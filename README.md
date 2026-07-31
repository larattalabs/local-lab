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
| Music | ACE-Step v1.5 | `~/AI/ace-step` |
| Text | [Ollama](https://ollama.com) | `ollama` on PATH |

Anything missing simply shows as unavailable with the path it looked for — the
app runs fine with only some of them installed.

**Availability checks the CLI, not the weights.** A model can be listed as
runnable and still fail on first use because its weights were never downloaded.
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

Image and text are wired and working. Video (LTX) is wired against its real CLI.
Music (ACE-Step) goes through `resources/workers/acestep_worker.py`, which is
written against the documented pipeline API but **not yet verified end-to-end** —
if it fails, the fix belongs in the worker, not the adapter.

Generated media is written to `~/AI/local-lab-runs` and never into the repo.

## Licence

MIT
