#!/usr/bin/env python
"""One-shot ACE-Step v1.5 generation for Local Lab.

ACE-Step ships a Gradio server (`acestep`), not a one-shot CLI, so this worker
gives it the same shape every other adapter in the app has: arguments in, one
audio file out, non-zero exit on failure.

Built on the handler/inference API (`AceStepHandler` + `generate_music`) — the
same call path ACE-Step's own UI uses, verified end-to-end elsewhere on this
machine. The earlier draft imported an `ACEStepPipeline` class that does not
exist in v1.5; `acestep_v15_pipeline.py` is the Gradio wrapper, not the API.

Runs under ACE-Step's own venv (~/AI/ace-step/.venv), never the app's.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path

# ACE-Step's own entry points strip proxy vars before import; a stale proxy
# setting has caused indefinite hangs in its model download path.
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
    os.environ.pop(k, None)

ACE_ROOT = os.environ.get("LOCALLAB_ACESTEP_DIR", os.path.expanduser("~/AI/ace-step"))
sys.path.insert(0, ACE_ROOT)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True, help="style / description tags")
    ap.add_argument("--lyrics", default="", help="empty for an instrumental")
    ap.add_argument("--duration", type=float, default=30.0)
    ap.add_argument("--steps", type=int, default=8,
                    help="xl-turbo is tuned for 8 steps with guidance off")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--cfg-scale", type=float, default=1.0)
    ap.add_argument("--config-path", default="acestep-v15-xl-turbo")
    ap.add_argument("--lm-model-path", default="acestep-5Hz-lm-4B")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        from acestep.handler import AceStepHandler
        from acestep.inference import GenerationConfig, GenerationParams, generate_music
        from acestep.llm_inference import LLMHandler
    except Exception as exc:  # noqa: BLE001
        print(f"could not import ACE-Step: {exc}", file=sys.stderr)
        print(f"checked repo root: {ACE_ROOT}", file=sys.stderr)
        return 2

    print(f"loading DiT={args.config_path} LM={args.lm_model_path}…", flush=True)
    dit = AceStepHandler()
    msg, ok = dit.initialize_service(
        project_root=ACE_ROOT, config_path=args.config_path,
        device="auto", offload_to_cpu=False,
    )
    if not ok:
        print(f"ACE-Step DiT init failed: {msg}", file=sys.stderr)
        return 1

    llm = LLMHandler()
    msg, ok = llm.initialize(
        checkpoint_dir=os.path.join(ACE_ROOT, "checkpoints"),
        lm_model_path=args.lm_model_path, backend="mlx",
        device="auto", offload_to_cpu=False, dtype=None,
    )
    if not ok:
        print(f"ACE-Step LM init failed: {msg}", file=sys.stderr)
        return 1

    params = GenerationParams(
        task_type="text2music",
        thinking=True,
        caption=args.prompt,
        lyrics=args.lyrics,
        instrumental=not args.lyrics.strip(),
        vocal_language="en",
        duration=args.duration,
        inference_steps=args.steps,
        guidance_scale=args.cfg_scale,
        seed=args.seed if args.seed is not None else -1,  # -1 = GenerationParams' "unset"
    )
    config = GenerationConfig(batch_size=1, audio_format="wav")

    with tempfile.TemporaryDirectory() as save_dir:
        res = generate_music(dit, llm, params=params, config=config, save_dir=save_dir)
        if not res.success:
            print(f"generation failed: {res.status_message}", file=sys.stderr)
            return 1
        if not res.audios:
            print("generation returned no audio outputs", file=sys.stderr)
            return 1
        produced = res.audios[0].get("path")
        if not produced or not os.path.isfile(produced):
            print(f"reported output path is missing: {produced!r}", file=sys.stderr)
            return 1
        shutil.copy(produced, out)

    if not out.exists() or out.stat().st_size == 0:
        print(f"pipeline finished but produced no audio at {out}", file=sys.stderr)
        return 1
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
