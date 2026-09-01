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
    # --- cover / remix ("Remix Mode" in ACE-Step's own Gradio UI) ---
    ap.add_argument("--task", default="text2music",
                    choices=["text2music", "cover"],
                    help="cover = transform --src-audio into the style described "
                         "by --prompt, keeping the source's structure/melody")
    ap.add_argument("--src-audio", default=None,
                    help="source song to cover; duration is locked to it")
    ap.add_argument("--cover-strength", type=float, default=0.7,
                    help="0.0-1.0; 1.0 hugs the original notes, ~0.2 is loose "
                         "style transfer")
    ap.add_argument("--bpm", type=int, default=None,
                    help="lock tempo; omit for auto-detect")
    ap.add_argument("--keyscale", default="",
                    help='lock key, e.g. "E Major" or "Am"; omit for auto')
    args = ap.parse_args()

    if args.task == "cover" and not args.src_audio:
        print("--task cover requires --src-audio", file=sys.stderr)
        return 2
    if args.src_audio and not Path(args.src_audio).is_file():
        print(f"source audio not found: {args.src_audio}", file=sys.stderr)
        return 2

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
    if args.task == "cover":
        # The pipeline skips the 5Hz LM for cover/repaint/extract even when
        # thinking=True (see docs/en/API.md) — conditioning comes straight from
        # caption+lyrics+src_audio. Don't load 10+ GB that will never run.
        llm = None
    else:
        msg, ok = llm.initialize(
            checkpoint_dir=os.path.join(ACE_ROOT, "checkpoints"),
            lm_model_path=args.lm_model_path, backend="mlx",
            device="auto", offload_to_cpu=False, dtype=None,
        )
        if not ok:
            print(f"ACE-Step LM init failed: {msg}", file=sys.stderr)
            return 1

    kwargs = dict(
        task_type=args.task,
        thinking=args.task != "cover",  # LM is skipped for cover regardless
        caption=args.prompt,
        lyrics=args.lyrics,
        instrumental=not args.lyrics.strip(),
        vocal_language="en",
        duration=args.duration,
        inference_steps=args.steps,
        guidance_scale=args.cfg_scale,
        seed=args.seed if args.seed is not None else -1,  # -1 = GenerationParams' "unset"
    )
    if args.task == "cover":
        kwargs.update(src_audio=args.src_audio, audio_cover_strength=args.cover_strength)
        kwargs.pop("duration")  # locked to the source; the pipeline ignores it anyway
    if args.bpm is not None:
        kwargs["bpm"] = args.bpm
    if args.keyscale.strip():
        kwargs["keyscale"] = args.keyscale.strip()
    params = GenerationParams(**kwargs)
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
