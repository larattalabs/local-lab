# Local Lab

A native desktop playground for comparing local AI models on Apple Silicon.

Write one prompt, run it across several models, and look at the results side by
side. Image, video, music and text each get their own section. Adding a model is
a declarative entry in a registry — no UI work.

Built because comparing local models otherwise means a terminal, several venvs,
and remembering which flag each CLI wants.

## Why a desktop app

These models are 14–41 GB apiece and live in separate Python virtualenvs. The app
is a thin, well-behaved supervisor around them: it spawns each model's own
interpreter with the right environment, streams the output back, and shows you
the artifact. Nothing is reimplemented, and no model weights are bundled.

## Requirements

macOS on Apple Silicon, with as many of these as you care about:

| Section | Backend | Where it's expected |
|---|---|---|
| Image | [mflux](https://github.com/filipstrand/mflux) CLIs | `~/.local/bin/mflux-generate*` |
| Image | Krea 2 (MLX) | `~/AI/krea2-mlx` |
| Video | `mlx_video` (LTX-2.3) | `~/AI/venvs/ltx-av` |
| Music | ACE-Step v1.5 (text-to-music + remix/cover) | `~/AI/ace-step` |
| Text | [Ollama](https://ollama.com) | `ollama` on PATH |
| Text | [DwarfStar / ds4](https://github.com/antirez/ds4) (V4.1 Flash 1017 Q2) | `~/Developer/_infra/ds4-v41` + `~/AI/ds4-gguf/v41-1017` |

Anything missing simply shows as unavailable with the path it looked for — the
app runs fine with only some of them installed.

**Availability checks local requirements.** New image adapters check their
checkpoint directories as well as the CLI. Some older adapters check only the
CLI and can still fail on first use if their weights were never downloaded.
Local Lab runs offline by default (see below), so that failure is fast and loud
rather than a silent multi-gigabyte download mid-run — and the error tells you
how to fetch it:

```bash
LOCALLAB_ALLOW_DOWNLOAD=1 pnpm dev
```

Every path is overridable by environment variable (`LOCALLAB_KREA2_DIR`,
`LOCALLAB_LTX_VENV`, `LOCALLAB_ACESTEP_DIR`, `LOCALLAB_OLLAMA_BIN`,
`LOCALLAB_AI_ROOT`, `LOCALLAB_RUNS_DIR`).

## Running it

```bash
pnpm install
pnpm dev
```

To build a distributable `.app`:

```bash
pnpm dist
```

### Driving it headlessly (for agents and debugging)

Two opt-in dev affordances, both inert unless you set the env var:

```bash
# The app screenshots ITSELF (capturePage) into <dir>/locallab.png every 2s —
# no macOS screen-recording permission involved.
LOCALLAB_SHOT=/tmp/shots pnpm dev

# Chrome DevTools Protocol on a port, so a script can drive the real UI:
LOCALLAB_CDP=9223 pnpm dev
# then e.g. list targets:  curl localhost:9223/json
```

These exist because this app was built (and is tested) largely by a coding
agent, which needs eyes and hands that don't depend on screen permissions or
guessing at window coordinates.

## How it works

```
src/
├── shared/types.ts        vocabulary shared across the IPC boundary
├── main/
│   ├── registry/          one file per modality; each model is a declarative entry
│   ├── runner.ts          the job queue — serialised, deliberately
│   ├── env.ts             the environment spawned processes get
│   └── index.ts           window + IPC handlers
├── preload/               the only surface the UI can reach
└── renderer/              Svelte 5 UI
```

### Adding a model

Add an entry to the relevant file in `src/main/registry/`. An adapter declares
what it needs on disk, what parameters to show, and how to turn a prompt plus
those parameters into a command line:

```ts
{
  id: 'my-model',
  label: 'My Model',
  modality: 'image',
  family: 'mflux',
  outputExt: 'png',
  requires: [BIN('mflux-generate-mymodel')],
  params: [aspectParam, { key: 'steps', label: 'Steps', type: 'int', default: 20 }],
  build: ({ prompt, params, outPath }) => ({
    bin: BIN('mflux-generate-mymodel'),
    args: ['--prompt', prompt, '--steps', String(params.steps), '--output', outPath],
  }),
}
```

The UI builds itself from `params`. There is nothing else to wire.

## Image generation, editing and upscaling

The Image picker includes Qwen Image 2.1 Turbo (8 steps), its reference editor,
the full Qwen Image 2.1 editor (40 steps), Noctaluna's Noct Q V4 (25 steps,
generation and editing), FLUX 3 Image Klein (16 steps, generation and editing),
and SeedVR2 upscaling. Editing takes one to ten attached reference images.
With context on, the previous finished image can serve as the next reference.
SeedVR2 takes exactly one image and needs no text prompt; its size setting
supports 2×, 3×, or a fixed shortest edge.

Qwen Turbo, the full Qwen editor, and Noct Q offer **Stock / Heretic** in the
Text encoder selector. Heretic changes the encoder; it does not replace the
image transformer or add visual training. Original checkpoints stay intact.
The full Qwen generation entry retains its strength-based img2img controls.

Use mflux 0.23.0 on Python 3.12. Pillow is pinned because 13.0.0 fails to import
on this runtime:

```sh
uv tool install --force --python 3.12 --with 'pillow==12.1.1' 'mflux==0.23.0'
~/.local/share/uv/tools/mflux/bin/python scripts/setup-image-stack.py
```

FLUX 3 requires accepting access on its Hugging Face model page first. The
setup script uses the existing HF credentials without printing them, downloads
pinned revisions into `~/AI/huggingface`, and composes checkpoint views under
`~/AI/image-stack` by symlink. Qwen Turbo shares the base Qwen3-VL encoder;
Heretic variants share all remaining components. SeedVR2 reuses the existing
`~/ComfyUI-Shared/models/SEEDVR2` files without copying them.

Noct Q V4 defaults to 25 steps, guidance 3 and a short negative quality prompt;
set guidance to 1 to trade conditioning for speed. Its publicly available INT8
ConvRot checkpoint is expanded once to BF16, including inverse rotation and
unpacking the fused SwiGLU matrices. This retains the source's
INT8 approximation; it is not the author's original BF16 checkpoint. Source
revisions and conversion details are recorded beside the model views.

Override paths with `LOCALLAB_IMAGE_MODELS_DIR`, `LOCALLAB_SEEDVR2_DIR`,
`LOCALLAB_AI_ROOT` or `LOCALLAB_HF_HOME`. Normal runs remain offline. Model files
and generated images are never stored in Git.

Checks: `node scripts/test-image-stack.mjs` verifies adapter contracts without
models. `~/.local/share/uv/tools/mflux/bin/python scripts/test-noct-conversion.py`
checks the expansion math. `node scripts/smoke-image-stack.mjs MODEL OUTPUT_DIR
[REFERENCE_IMAGE] [stock|heretic]` runs a real adapter on installed weights.

## DeepSeek V4.1 Flash 1017

In Text, select **DeepSeek V4.1 Flash 1017 · Q2 · abliterated**. This entry uses
the locally patched GGUF; it does not download or modify weights. It supports
streaming replies, system prompts and multi-turn conversation history. Reasoning
starts off; raise it in the parameter panel when needed, allowing enough output
tokens for thinking and the answer.

The 341 GiB file requires SSD streaming on a 128 GB Mac. Each job starts a
private loopback DwarfStar server and stops it on completion or cancellation,
releasing memory before another queued model runs. Loading happens on each turn;
expect a delay before tokens appear. The existing V4/omp setup is independent.
Avoid running another large inference service at the same time; DwarfStar's
instance lock remains enabled.

Paths can be overridden with `LOCALLAB_DS4_DIR` and `LOCALLAB_DS4_MODEL`.
`LOCALLAB_DS4_CACHE_EXPERTS` optionally sets the runtime's expert-cache budget
(for example `64GB`); leaving it unset uses automatic sizing. The worker uses
macOS's `/usr/bin/python3` and needs no Python packages. Advanced parameters
include allocated context length (default 32768).

Run the worker's protocol and cancellation checks without loading a model:
`python3 scripts/test-ds4-worker.py`.

## Remixing a song (ACE-Step cover mode)

The Music section has two ACE-Step entries. **remix / cover** takes a song and
a style caption and regenerates the track in that style while keeping the
source's structure and melody — ACE-Step's `cover` task, which its own Gradio
UI calls "Remix Mode". Attach an audio file, describe the target
("energetic synthwave, driving 80s basslines"), optionally paste lyrics to
keep or swap the vocals, and run.

One knob matters: **cover strength** (0–1). At 1.0 the output hugs the
original notes; around 0.2 it's loose style transfer; 0.7 is a good remix
default. Output duration is locked to the source. BPM/key locks are on the
advanced shelf. Covers skip ACE-Step's 5Hz language model entirely (per its
API docs), so they start *faster* than text-to-music.

## Two design decisions worth knowing

**Runs are serialised.** The app exists to compare model A against model B, which
invites firing several at once — but these are 14–41 GB peak models on one
machine. Two large runs in parallel don't halve the wall clock; they swap and
crawl, or the OS kills one. Comparison needs side-by-side *display*, not
simultaneous *execution*, so jobs queue and run one at a time.

**`HF_HOME` is set explicitly for every spawned process.** A GUI app launched
from Finder never sources your shell rc, so it inherits no `HF_HOME` and
`huggingface_hub` falls back to `~/.cache/huggingface` — which may hold stale
partial downloads of models that are fully present elsewhere. A process that
inherits the wrong cache doesn't fail; it silently resumes a broken download with
no progress and no error. `HF_HUB_OFFLINE` is on by default for the same reason:
it turns a cache miss into an immediate loud error. Set `LOCALLAB_ALLOW_DOWNLOAD=1`
when deliberately pulling something new.

## Status

All four modalities are verified end-to-end on real hardware: text (Ollama,
streamed), image (Krea 2 + FLUX.2 side by side), video (LTX-2.3 with audio),
and music (ACE-Step text-to-music and remix/cover both). ACE-Step runs through
`resources/workers/acestep_worker.py`; if a future ACE-Step update breaks it,
the fix belongs in the worker, not the adapter.

Generated media is written to `~/AI/local-lab-runs` and never into the repo.

## Licence

[MIT](LICENSE) © Laratta Labs
