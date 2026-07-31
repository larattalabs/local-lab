#!/usr/bin/env python
"""One-shot ACE-Step generation for Local Lab.

ACE-Step ships a Gradio server (`acestep`), not a one-shot CLI, so this worker
gives it the same shape every other adapter in the app has: arguments in, one
audio file out, non-zero exit on failure.

STATUS: written against ACE-Step v1.5's pipeline API but NOT yet verified
end-to-end. If the first run fails, fix it here — the adapter in
src/main/registry/music.ts only builds the command line and should not need to
change.

Runs under ACE-Step's own venv (~/AI/ace-step/.venv), never the app's.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True, help="style / description tags")
    ap.add_argument("--lyrics", default="", help="empty for an instrumental")
    ap.add_argument("--duration", type=float, default=30.0)
    ap.add_argument("--steps", type=int, default=27)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        from acestep.acestep_v15_pipeline import ACEStepPipeline  # type: ignore
    except Exception as exc:  # noqa: BLE001
        print(f"could not import ACE-Step pipeline: {exc}", file=sys.stderr)
        print("check that ~/AI/ace-step/.venv is intact and the repo is on sys.path",
              file=sys.stderr)
        return 2

    pipe = ACEStepPipeline(dtype="float32", torch_compile=False)

    kwargs = dict(
        prompt=args.prompt,
        lyrics=args.lyrics,
        audio_duration=args.duration,
        infer_step=args.steps,
        save_path=str(out),
    )
    if args.seed is not None:
        kwargs["manual_seeds"] = str(args.seed)

    result = pipe(**kwargs)

    # Different ACE-Step versions either write to save_path directly or return
    # the path(s) they chose. Normalise both onto the path we were asked for.
    if not out.exists():
        produced = None
        if isinstance(result, (list, tuple)) and result:
            produced = result[0]
        elif isinstance(result, (str, Path)):
            produced = result
        if produced and Path(produced).exists():
            shutil.copy2(produced, out)

    if not out.exists() or out.stat().st_size == 0:
        print(f"pipeline finished but produced no audio at {out}", file=sys.stderr)
        return 1

    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
