# Local Lab

A native desktop playground for comparing local AI models on Apple Silicon.

Write one prompt, run it across several models, and look at the results side by
side. Image, video, music and text each get their own section. Adding a model is
a declarative entry in a registry — no UI work.

Built because comparing local models otherwise means a terminal, several venvs,
and remembering which flag each CLI wants.

## Why a desktop app

Models occupy tens to over a hundred GB and use separate native runtimes. The app
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
| Video | [h3.c](https://github.com/antirez/h3.c) (MiniMax H3) | `~/Developer/labs/h3.c` |
| Video | [ltx-2-mlx](https://github.com/dgrauet/ltx-2-mlx) (LTX-2.5) | `~/AI/venvs/ltx-next` |
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

To build a normal Apple Silicon macOS app:

```bash
pnpm run pack
```

Open `release/mac-arm64/Local Lab.app`, or copy it to `~/Applications` and
launch **Local Lab** from Finder, Spotlight or the Dock. `pnpm dist` also creates
`release/Local Lab-<version>-arm64.dmg` with a drag-to-Applications installer.
The named app includes its custom icon and uses a local ad-hoc signature; these
personal builds do not require Apple Developer credentials. Public distribution
would need a separate Developer ID signing/notarization setup.

The packaged app uses the same `~/AI` model stores, private profiles and
`~/AI/local-lab-runs` outputs as development. Models are not bundled into the app.
Rebuild after source changes, then replace the installed copy while it is closed.
To regenerate the icon assets, run `pnpm icon` (uses macOS AppKit and iconutil).

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

## Prompt Director

Image and Video settings include **Prompt Director** on both the Mac and paired
phones. The default is **Preview rewrite**: enter your request, review the
rewritten prompt, optionally edit it, then choose **Generate with this prompt**.
**Use original** skips the rewrite; **Off** sends the original directly.
**Automatic rewrite** continues on the Mac without waiting for client approval,
including when the initiating phone disconnects.

Choose Faithful, Photography, Precise edit or Motion director, and Low, Medium or
High creative freedom. Faithful image requests with references automatically use
the Precise edit recipe. The Animate dialog has the same video controls. Comparison
mode either sends the exact same rewritten prompt to every selected model or
adapts wording separately for each model. Keep the same prompt for controlled
comparisons; model-specific wording is a separate variable.

Open **Edit directors…** for the director library and a full-size instruction
editor. Create directors from scratch, duplicate an existing director, rename
and edit directors, or customize a built-in. Built-in customizations have a
**Restore original** action. Removal can be undone in the open editor, and
switching directors or closing prompts you to save or discard unsaved changes.
**Save director** saves without changing the current selection; **Save & use**
selects it for the current Image or Video workflow. The editor also works when
Ollama is stopped. Concurrent edits from another device produce a conflict
instead of overwriting that device's changes; **Reload library** refreshes the
saved version after you choose how to handle your draft.

Under **Model & defaults**, select an installed local Ollama model or add
protected identity trigger words. **Save model & defaults** shares the model, protected words and
initial defaults through the Mac; current mode/preset selections persist per
device. Custom profiles are available on both interfaces after settings refresh.
The app selects a locally installed model on first use, preferring one labelled
uncensored or abliterated when available. It never downloads a rewriting model.
Start Ollama first; the endpoint must be loopback (`OLLAMA_HOST`, default
`http://127.0.0.1:11434`).

The director receives the request, generation settings, model descriptions and
bounded user-message context when context is enabled. A model is treated as
text-only unless the runtime explicitly reports vision support. The preview
shows this limitation and the selected source image. For a vision-capable model,
up to four references are resized to a maximum dimension of 1024 pixels and sent
locally. Generation still receives all selected references. A rewrite is bound
to the exact source, request, models and settings that produced it.

Rewriting shares the serial model queue. **Model & defaults → Preview speed**
keeps a successful preview model warm for two minutes by default, reusing its
weights and available prompt cache for faster follow-up previews. Choose
**Unload after every rewrite** to minimize idle memory. The selected weights,
context window and rewrite instructions stay unchanged. Automatic rewrites,
failed rewrites and cancellations release the model immediately. Before any
image, video, music or text generation starts, the queue unloads retained
director models and verifies release; this ownership survives app restarts. The queue only
coordinates jobs launched by Local Lab; separately launched GPU tools still
need to be managed separately. Cancelling a rewrite waits for its cleanup before
the next queued job can start.

The result's **Prompt used** disclosure shows the final and original prompts.
Run metadata also records the model-generated text, final approved text,
instructions, preset and source-image capability. Private settings live in the
app's user-data directory as `prompt-director.json`; durable previews live under
`~/AI/local-lab-runs/director/`. Neither belongs in Git. Tests:

```sh
pnpm test:director
pnpm test:phone
```

## Image generation, editing and upscaling

The Image picker includes Qwen Image 2.1 Turbo (8 steps), its reference editor,
the full Qwen Image 2.1 editor (40 steps), FLUX 3 Image Klein (16 steps,
generation and editing), and SeedVR2 upscaling. Editing takes one to ten
attached reference images. With context on, the previous finished image can
serve as the next reference. SeedVR2 takes one image and needs no text prompt.

Use mflux 0.23.0 on Python 3.12 with Pillow 12.3.0:

```sh
uv tool install --force --python 3.12 --with 'pillow==12.3.0' 'mflux==0.23.0'
~/.local/share/uv/tools/mflux/bin/python scripts/setup-image-stack.py
```

FLUX 3 requires accepting its Hugging Face model license. The setup downloads
pinned revisions into `~/AI/huggingface` and composes views under
`~/AI/image-stack`. Turbo shares the base encoder. SeedVR2 reuses
`~/ComfyUI-Shared/models/SEEDVR2` without copying files. Normal runs stay offline.

Full Qwen and Turbo generation can use **mlx-serve INT8** through the optional private
`~/AI/local-lab-private/qwen-runtime.json` (`LOCALLAB_QWEN_RUNTIME` overrides it).
Set `python`, `script`, and `engine` to absolute paths for a Python interpreter,
the installed copy of `resources/workers/qwen_full_native.py`, and the verified
mlx-serve binary. This enables **Generation engine**, defaulting to mlx-serve
INT8 on full Qwen, Turbo generators and local profiles. It preserves the selected
model, encoder, LoRAs, guidance and step count. INT8 changes numerical precision
and can change fine details; it does not skip denoising steps.

Choose **mflux (reference)** to restore the original backend and its precision
and step-reuse controls. Those controls are hidden and omitted from requests
in INT8 mode, including values saved by an older client. Turbo generation keeps
its eight-step distilled schedule. Instruction editors continue using mflux. The native worker starts an authenticated
localhost-only server for each job, stops it on completion or cancellation,
and saves a PNG plus effective-request metadata. No model weights are copied.
Desktop and phone use the same runtime selection; refresh the phone page after
installing an app update. Verify routing with `node scripts/test-qwen-runtime.mjs`.

Personal checkpoints and optional encoders/LoRAs belong in an external
`~/AI/image-stack/profiles.json`, never in source control. Override this with
`LOCALLAB_IMAGE_PROFILES`. Example:

```json
{
  "models": [{
    "id": "qwen-local", "label": "Qwen local profile", "model": "qwen-local",
    "base": "qwen-image-2.1", "command": "mflux-generate-qwen-2.1",
    "steps": 25, "qwen": true, "guided": true, "stepReuse": true
  }],
  "encoders": {
    "flux-3": [{"id": "alternate", "label": "Alternate", "suffix": "-alternate"}]
  },
  "loras": [
    {"id": "photo", "label": "Photo style", "path": "adapters/photo.safetensors", "scale": 1},
    {"id": "character", "label": "Character", "family": "qwen-2.1", "path": "adapters/character.safetensors", "scale": 1}
  ]
}
```

Encoder suffixes select composed model views (for example,
`flux3-image-klein-alternate`) that share the transformer and VAE. LoRAs appear
in **Image adapter** on FLUX 3, Qwen 2.1 instruction editing, and custom Qwen
profiles. Set `family: "qwen-2.1"` for Qwen adapters, `family: "h3-image"` for dedicated H3 Image adapters, or `family: "flux-3"` for
FLUX 3; existing entries without a family retain their FLUX 3 behavior.
**Adapter strength** multiplies the configured scale. Qwen adapters use runtime
application to preserve small weight updates. Keep source revisions, licenses and
conversion records beside private model assets. The generic
`scripts/expand-int8-checkpoint.py` expands compatible tensorwise INT8 ConvRot
checkpoints to BF16, preserving the source quantization approximation.
`scripts/prepare_qwen_encoder.py` supplies legacy RoPE config aliases for
encoders that need them without changing cached files.

Custom Qwen profiles can expose guidance, negative prompts and optional step
reuse. Guidance above 1 with a negative prompt doubles the denoising passes.
Step reuse is off by default and can change detail and composition.

Override asset paths with `LOCALLAB_IMAGE_MODELS_DIR`, `LOCALLAB_SEEDVR2_DIR`,
`LOCALLAB_AI_ROOT`, `LOCALLAB_HF_HOME` or `LOCALLAB_HF_HUB_CACHE`.
Checks: `node scripts/test-image-stack.mjs` verifies adapter contracts;
`~/.local/share/uv/tools/mflux/bin/python scripts/test-checkpoint-conversion.py`
checks expansion math. Run installed models with
`node scripts/smoke-image-stack.mjs MODEL OUTPUT_DIR [REFERENCE_IMAGE] [ENCODER_ID]`.

Measured on an M5 Max / 128 GB at 1024², including loading: Qwen Turbo generation
40 s / editing 52 s; full Qwen generation 162 s / editing 186 s; FLUX 3 generation
46 s / editing 97 s. SeedVR2's 256→512 test took 15 s. These are single-run smoke
timings, not a broad quality ranking.

## Edit an image in the same chat

With context on, the next image prompt uses the latest finished image. Qwen and
FLUX entries with matching instruction editors automatically route to that editor;
the composer previews the input and names the actual model before Send. Compatible
identity adapter, encoder, strength, aspect and sampling settings carry over from
the selected generator. Private generation/edit pairs share their model and preset
adapters. No prompt-classification or rewriting LLM is used.

Click **edit this image** beneath any finished result in the current chat to
choose an earlier source. Its card is highlighted and the composer says **Selected
image** with a thumbnail. **Use latest image** returns to automatic context.
The choice is local to that chat and stays visible while the edit is queued or
running. After it succeeds, context follows the new result. A failed edit retains
the choice for retry. Choosing another source while a job runs is preserved.
Every edit card also shows its submitted source, independent of the next prompt. Explicitly selected sources also work
with context off; **Clear selection** removes the source in that mode.

Type an edit instruction such as “Change the jacket to green; preserve the face,
pose and background.” Attachments override the carried image. Context off with no
attachment generates a fresh image. Each completed edit becomes the next input.
An unavailable editor or a model that cannot accept the image produces a clear
message rather than silently ignoring it. Choose one generator or its editor,
rather than both, for the same edit. These remain generative edits; exact pixel
preservation is not guaranteed.

## Animate a generated image

Click **animate** beneath a finished image in a conversation or Earlier runs.
The dialog previews the starting frame and lets you enter a motion prompt,
choose an installed image-to-video model, and adjust its settings. Resolution
starts near the source image's aspect ratio unless you already chose a video
resolution. Cancel leaves the current chat and settings intact.

**Generate video** queues the job and opens a fresh Video chat with that image
and those settings. Other image drafts and conversations stay intact. The
source frame is saved with the video chat and carries into later prompts while
context is on. Jobs still run one at a time.

The stock LTX text encoder has an explicit local view so generation does not
fall back to a hidden download. Prepare it with the shared mflux Python:
`~/.local/share/uv/tools/mflux/bin/python scripts/setup-video-encoder.py`.
Override its directory with `LOCALLAB_LTX_ENCODER_DIR`. The video adapter checks
for its config before appearing available. Video inference keeps its separate
`~/AI/venvs/ltx-av` environment.

The installed LTX-2.3 unified MLX path uses fixed 8 + 3 sampling steps and baked
in guidance; the app does not expose Steps, CFG or negative-prompt controls that
this runtime ignores. Video-only output is the default, skipping audio decode
and muxing while retaining joint audio/video denoising. Enable audio by
unchecking **Video only**. Small draft sizes are available for quick tests;
frame counts follow the model's 8n+1 constraint.

Run `node scripts/test-video-workflow.mjs` for model-free handoff, context,
draft-isolation, rejection and backend-contract checks.

### Native H3 and LTX-2.5

These use separate engines from the existing LTX-2.3 entry. Install their pinned
runtimes with native arm64 tools:

```sh
git clone https://github.com/antirez/h3.c.git ~/Developer/labs/h3.c
git -C ~/Developer/labs/h3.c checkout 8974cc055ea9c02fcd14cc27dfda3e1027c05153
make -C ~/Developer/labs/h3.c -j8

git clone https://github.com/dgrauet/ltx-2-mlx.git ~/Developer/labs/ltx-to-mlx
git -C ~/Developer/labs/ltx-to-mlx checkout b82b97e3d000e01361f8cfcb745244b15b89a521
cd ~/Developer/labs/ltx-to-mlx
UV_PROJECT_ENVIRONMENT=~/AI/venvs/ltx-next uv sync --python 3.12 --no-dev
```

Then run `scripts/setup-video-stack.py` from the Local Lab checkout with the
shared mflux Python. Accept the LTX-2.5 MLX pack's Hugging Face license first.
The script downloads about 144 GB for H3's first/last-frame components and 45 GB
for the distilled LTX-2.5 pack, verifies published SHA-256 hashes, and composes
views under `~/AI/video-stack`. Use `--only h3` or `--only ltx-2.5` to select one;
`--offline` rechecks cached files using the saved source manifest. Models become
available only after verification writes their readiness marker.

H3 produces sound at 24 FPS and uses a different frame grid (17n+5). Its
balanced default uses 20 steps, 45 of 50 layers and prediction reuse of 2;
choose all 50 layers and disable reuse for a closer reference. LTX-2.5 uses
8n+1 frames, its bundled Gemma 4 encoder, and an 8 + 3 step distilled schedule.
The first-stage step control can reduce that to 6 or 4 evaluations for drafts.
Audio is optional. Its older Gemma 3 encoder is not interchangeable.
LTX-2.5 also offers its experimental diffusion decoder in advanced settings;
the convolutional decoder remains the faster default.
Its advanced **Compute precision** control defaults to **FP16 (faster)** for
the denoiser's projections and attention, retaining FP32 residuals/modulation.
Choose **FP32 (reference)** to reproduce the original compute path. Both keep
the same model, encoder, 8 + 3 schedule and decoder; rounding can change the
result slightly. Sparse attention stays off. This setting is available in
both the desktop and paired phone UI and does not affect older LTX models.
The Animate dialog prefers LTX-2.5 when no available video model is selected.

Personal video profiles belong in `~/AI/video-stack/profiles.json`, with model
identities, licenses and conversion recipes kept in private files outside Git:

```json
{
  "models": [{
    "id": "ltx-local", "label": "LTX local profile", "engine": "ltx-mlx",
    "model": "ltx-local", "ltxVersion": "2.3", "encoder": "ltx-text-encoder"
  }, {
    "id": "h3-local", "label": "H3 local profile", "engine": "h3-native",
    "model": "h3-local", "binary": "h3-local-engine/h3",
    "steps": 8, "allowApproximation": false
  }]
}
```

Profiles use the same Animate dialog and serial job queue. A profile's converted
pack needs its own `local-lab-ready.json` after validation. Use neutral IDs,
labels and filesystem aliases because command paths appear in local run logs.
Private source records remain truthful about the underlying weights and licenses.
Restart Local Lab after changing profiles. Overrides: `LOCALLAB_VIDEO_PROFILES`,
`LOCALLAB_VIDEO_MODELS_DIR`, `LOCALLAB_H3_BIN`, `LOCALLAB_LTX_NEXT_BIN`.
LTX profiles default to version 2.3 and require an explicit local Gemma 3 encoder.
For a 2.5 pack, set `ltxVersion` to `2.5` and use its bundled encoder. Availability
also checks the matching codecs and spatial upscaler; the runtime must not fall
back to an uninitialized upscaler when a shared component is missing.

## DeepSeek V4.1 Flash 1017

In Text, select **DeepSeek V4.1 Flash 1017 · Q2**. This entry uses
the configured local GGUF; it does not download or modify weights. It supports
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

## Code: a coding agent on local models

**Code** (desktop only, next to the modality tabs) runs a coding agent in a
folder you pick, much like a desktop coding app, but every token comes from a
local model. Two harnesses are supported and switchable per session:

- **omp** (Oh My Pi), driven over its JSON-lines RPC mode (`omp --mode rpc-ui`).
  It uses your existing `~/.omp` setup: providers, AGENTS.md, LSP and memory.
- **opencode**, driven through one private `opencode serve` (v2 API). Its
  provider config is generated by the app and passed in
  `OPENCODE_CONFIG_CONTENT`, so `~/.config/opencode` is untouched. Sessions still
  land in opencode's database, so they can also be continued from the CLI.

The transcript streams thinking, replies, tool calls and their output.
Approvals appear inline, with edit diffs. **Approval modes:**

| Mode | Runs without asking | Waits for you |
| --- | --- | --- |
| Ask before edits | Reads | Edits and commands |
| Auto-accept edits | Reads and edits | Commands |
| Full auto | Everything | Nothing |

**Models.** The picker lists `~/AI/local-lab-private/code-models.json`, which
holds only models that passed a tool-call check through their server. The file
is private and outside the repo. Without it, the tab falls back to whatever
Ollama and oMLX report. Each entry names a backend (`ollama`, `omlx`, `ds4`,
`ds4-ablit`, `ds4-v41`) and the model id that server expects; `<backend>/<id>`
is also the omp `--model` value.

**One model server at a time.** Before a turn, the app brings up the model's
server with `resources/workers/code_backend.zsh`. That script first stops the
other servers and unloads Ollama's resident models.

- It holds the same lock as the terminal `omp()` switcher
  (`~/.omp/backend.lock`) and follows the same stop rules: it waits for the
  memory to be released and aborts rather than loading on top of a model that
  won't stop.
- It won't switch while another Code session is mid-turn on a different
  backend, or while a Local Lab job is running.

**Context windows.** oMLX's per-model limits live in
`~/.omlx/model_settings.json` (Settings → Servers edits them; oMLX restarts on its
next request, and the catalog and omp's `models.yml` are updated to match).
Models with a window of 64K or less get small run-only adjustments:

- omp gets a `--config` overlay that compacts at 85%. Its default 16K reserve
  would otherwise compact on every turn.
- opencode gets a 4K output reserve when the window is 32K or less.

Neither adjustment changes any global settings. Every omp Code session also runs
with `compaction.strategy: context-full`, an ordinary LLM summary. omp's
default, snapcompact, turns history into bitmap images for the model to read
back: it fails on text-only local models and isn't useful on local vision
models. On a short session, omp refuses to compact ("Nothing to compact"); the
app reports that and doesn't wait.

### Session controls

- **Thinking.** Shown for reasoning models. oMLX models switch thinking on or off
  through the chat template's `enable_thinking`, because oMLX's
  `reasoning_effort` is unreliable on Qwen. DwarfStar models take
  off/low/medium/high.
  - omp: `--thinking` and `set_thinking_level`.
  - opencode: model variants whose settings go straight into the request body.
- **Agent (opencode).** Switch between build and plan; plan is read-only.
- **Typing while the agent works.** Enter queues the message for after the
  current turn (omp `follow_up`, opencode `delivery: queue`). ⌘Enter steers it
  into the running turn (omp `steer`, opencode `delivery: steer`).
- **Images.** For vision models: paste, drop or attach. The agent is told the
  images are inline, so it doesn't go looking for a file.
- **Slash commands.** Type `/` for the harness's own commands (omp's ~60,
  opencode's `init`, `review`, `goal`).
- **Context meter and Compact.** Compact summarizes the conversation now.
- **Changes.** Shows the folder's uncommitted git diff, including untracked
  files, independent of the harness.
- **Rename.** Click the session title.

**Writes outside the folder always ask** in Ask and Auto-accept modes:

- omp loads `resources/workers/omp-folder-guard.ts` with `--hook`. Its own tiers
  would allow a write anywhere.
- opencode gets `external_directory: ask`.

Only Full auto skips this. It was added after a local model, unsure where "the
attached image" was, wrote under `~/Library/Claude`.

**opencode context.** opencode would otherwise fall back to Claude Code's
`~/.claude/CLAUDE.md` and push ~48K characters of Claude-specific rules into a
local model's prompt.

- The app points `OPENCODE_CONFIG_DIR` at its own folder, whose `AGENTS.md`
  links to the shared `~/.codex/AGENTS.md` (the same context omp reads).
- Project AGENTS.md and CLAUDE.md files are still read.

### Settings (gear next to New session)

- **Models.**
  - Edit names, context windows and the reasoning, vision and uncensored flags.
  - Remove models.
  - Find models that Ollama and oMLX report but the catalog lacks, and run the
    tool-call check, which adds the model when it passes.
- **Harnesses.**
  - The omp lean tool set.
  - Extra instructions for every session: omp gets them via
    `--append-system-prompt`, opencode via an instructions file.
- **Servers.**
  - Idle-unload minutes for the DeepSeek servers.
  - oMLX context limits per model.

### Tests

| Command | What it checks | Needs |
| --- | --- | --- |
| `pnpm test:code` | Both harnesses on a real model: full auto, ask with approval, then resume after a driver restart | Live model |
| `pnpm test:code-features` | Thinking off and on, an image, a message queued mid-turn, slash commands, the context meter, compaction, Changes | A vision model |
| `pnpm test:code-guard` | The folder guard, deterministically: a fake server on :8080 stands in for the model | oMLX stopped |

To narrow `test:code` or `test:code-features`, set
`CODE_TEST_MODEL=<backend>/<id>` and `CODE_TEST_HARNESS=omp` or `opencode`.
The tests use a temporary opencode database and omp session folder, so they
leave nothing in your history.

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
streamed), image (Krea 2, Qwen 2.1/Turbo, local Qwen profile, FLUX.2/3 and SeedVR2), video (LTX-2.3 with audio),
and music (ACE-Step text-to-music and remix/cover both). ACE-Step runs through
`resources/workers/acestep_worker.py`; if a future ACE-Step update breaks it,
the fix belongs in the worker, not the adapter.

Generated media is written to `~/AI/local-lab-runs` and never into the repo.

## Licence

[MIT](LICENSE) © Laratta Labs

Private image profiles may set `defaultEncoders` by architecture family. Explicit Stock selection remains available; omitted encoder settings use the configured default. Model-specific component views and alternate launcher scripts can be configured in `~/AI/local-lab-private/runtime-profiles.json` (or `LOCALLAB_RUNTIME_PROFILES`) using absolute `model`, `encoder`, or `script` paths keyed by adapter ID. Validate model architecture, layer extraction, tokenization and required projection weights before routing a model to replacement components.

### Additional native image/video runtimes

MiniMax H3 Image uses a separate `~/AI/venvs/h3-image` environment and an image-stack model view. Its optional private runtime profile can set `models.minimax-h3-image.model` and a compatible `script` override. With that runtime installed, private image profiles with `family: "h3-image"` expose an optional adapter selector and strength control. The default is Off; a dedicated H3 Image adapter may be combined with references. The adapter supports zero to sixteen reference images, keeps the native six-step sampler, and disables automatic prompt expansion. Supply a full scene caption. Its text conditioner and image VAE must match H3 Image; video LoRAs and Qwen image adapters are not interchangeable.

Wan 2.2 A14B uses `mlx_video.generate_wan` in the existing video environment and a `video-stack/wan22-i2v-a14b-q8` view. Keep both noise experts, the UMT5 encoder, and the z16 VAE together. Its separate Lightning entry requires matching I2V high/low adapters named `lightning_high.safetensors` and `lightning_low.safetensors`. It uses four Euler steps with guidance 1; the base entry uses forty UniPC steps. Wan outputs silent 16 FPS video and requires one initial image and 4n+1 frames.

Additional private Wan profiles are read from `~/AI/video-stack/wan-profiles.json` (`models`: entries with `id`, `label`, absolute `model`, `steps`, `guidance`, optional `shift`). Image profiles can declare `presetLoras` with relative `path` and optional `scale`; the selected identity adapter remains independent. New H3 Image and Wan model views require a `local-lab-ready.json` marker after a successful live output check. Keep setup records, licensing, and personal checkpoint identities beside private assets.

## Basic and Advanced mode

Use the title-bar **Basic / Advanced** switch. The phone starts in Basic; the Mac
keeps Advanced by default. The choice and drafts are remembered separately on
each device. Chats, finished media, directors and saved presets are shared.

Basic offers **Create image**, **Edit image**, **Upscale**, and **Video** (animate
an image). Choose a style, subject, Fast/Detailed quality and shape. Video adds
clip duration. Fast images use Qwen Image 2.1 Turbo; Detailed uses full Qwen or a
configured local profile; video uses LTX-2.5. Existing optimized runtime and
encoder defaults apply. Edit uses the matching instruction editor. Unavailable
models or incompatible identity adapters report an error instead of silently
changing models.

**18+** selects the editable **18+ · Adult editorial** director, with glamour,
pin-up, boudoir and swimwear moods. It preserves the requested adult subject,
wardrobe and action. Use **Edit adult director** in the Style sheet to customize it
without changing Advanced's director selection. **Prompt assist** enables
automatic rewriting; **Review prompt** lets you inspect/edit the rewrite first.

Choose **edit this image** or **animate** beneath a result to pin that exact
source. Basic never implicitly replaces it with the latest image. **Make
another** reuses the finished result's approved prompt, source and resolved
settings with a new seed, without another rewrite. **Open in Advanced** copies
those exact settings into the full controls. Older results without a settings
snapshot retain their existing edit/animate actions.

Use **Save as preset…** beneath a result or in Advanced model settings. Give it
a name, optional thumbnail, director, and choose which controls Basic should
expose; the remaining settings stay fixed. In Basic, open **Saved presets** to
select, refresh or edit the library. Saves use version checks so an older phone
cannot overwrite a newer preset silently. Presets live in the app's private
user-data directory (`basic-presets.json`). Resolved job recipes and approved
prompts are retained in chat/run metadata; durable preparation records live in
`~/AI/local-lab-runs/basic-plans/` for safe reconnects and retries.

Optional personal defaults live outside the repository at
`~/AI/local-lab-private/basic-profiles.json`:

```json
{
  "models": { "fast": "qwen-image-2.1-turbo", "detailed": "qwen-image-2.1", "video": "ltx-2.5" },
  "subjects": [{ "id": "my-character", "label": "My character", "lora": "registered-adapter-id", "trigger": "private-trigger" }]
}
```

Use registered model/adapter IDs and keep personal identities private. Restart
the Mac app after changing this private file. Verification: `pnpm test:basic`,
`pnpm test:phone`, `pnpm test:director`, and `pnpm check`.

### Moods and intensity

In Basic, choose **Style → 18+**, then a mood and intensity. **Low · Subtle**
adds no extra intensity instructions, preserving the original treatment.
**Medium · Bold** emphasizes confident posing and framing; **High · Dramatic**
adds stronger editorial presentation. Model selection, identity, wardrobe and
explicit actions remain governed by your request. Intensity is separate from
Prompt Director's creative freedom.

Open **Advanced → Settings → Prompt Director → Edit moods & intensity…**
(or **Edit moods / Edit intensity levels** in Basic's 18+ Style sheet). Edit names,
descriptions, shared prompt instructions and optional video-only instructions.
Create, duplicate and delete custom options; built-ins can be edited or restored.
Changes stay in the editor until **Save changes**. Saves are revision checked;
a stale client must reload instead of overwriting another device. Options used
by an adult preset cannot be removed until that preset changes.

Options live privately in `<Electron userData>/basic-modifiers.json`, sync to
paired clients, and work with Prompt assist on or off. Presets using the built-in
Adult editorial director save default mood/intensity choices, adjustable in
Basic. These editors do not inject modifiers into arbitrary Advanced requests.
Each Basic result stores the applied option names and full instructions in its
recipe; view them in **Activity** or **Settings used**. Prepared jobs and **Make
another** retain their original prompt/settings after options are edited.

## Studio and media library

Basic and Advanced share the image and video Studio on Mac and phone. The image stays fitted
in the viewer, with fullscreen navigation and a before/after slider for edits.
Choose **Edit**, **Animate**, **Make another**, or the **More** menu under a result.
The prompt stays at the bottom; character, visual style cards, quality, shape,
and saved presets open in a desktop dialog or a phone bottom sheet. Character
portraits and style previews use your own saved media, with neutral placeholders
until a suitable image exists. Automatic prompt assistance stays unobtrusive;
**Review prompt** still opens an editable preview.

New projects have permanent identifiers. Edits and animations retain their source result IDs. Choose **Use in new project** to borrow a still for a separate project. Studio groups older chats through their source-image relationships. Images,
edits and animations share a version strip and activity history; this grouping
does not migrate or rewrite old chat files. Rename a project from its heading.
**Library** searches prompts/project names, filters images/videos/projects, and
shows favorites. Hearts, project names, preset favorites and character portraits
sync across paired devices through private `studio.json` in Electron user data.
Older standalone runs remain available; exact replay requires a saved request.

Open **More → Compare motion** on a still to run a shared motion prompt through two or more installed video models. The dialog shows each model’s resolved dimensions, frame count and playback rate. Reopen it after generation to scrub the finished clips together, step a frame, or use blind A/B. **Run recipe** shows the submitted prompt, source and recorded settings. **Repeat settings & seed** reuses a recorded seed.

**Studio settings** includes workspace mode, directors, moods, intensity, saved presets, history and the installed build ID. On a paired phone it also includes Unpair.

Progress reports the actual runtime phase and sampling steps when the runtime
provides them. Timing hints use completed runs with matching model/settings:
“Last run” with fewer than three samples, or a measured range with more samples.
No overall percentage or timing is invented. Queue cancellation stays available.

The phone checks for a new renderer on focus and once a minute while visible.
**Update available → Refresh** reloads it after prompt preparation finishes;
Basic and Advanced drafts are saved locally before refresh. Jobs already accepted
by the Mac keep running. Existing phone tabs need one manual refresh to load
this update-checking version. Run `pnpm test` for the model-free contract suites. On a Mac, `pnpm run pack` followed by `pnpm run test:package` checks the packaged preload, temporary library, HTTPS bundle and worker resources.

## iPhone over local Wi-Fi

The packaged Mac app includes an optional HTTPS web client. Open **Phone access** in the title bar, enable it, then choose **Pair a device**. The Mac and phone must be on the same private Wi-Fi or LAN; no account, cloud relay, port forwarding, or public listener is configured.

For the first connection:

1. Scan the **First-time iPhone setup** QR. Download the certificate, then install it from iPhone Settings → Profile Downloaded (or General → VPN & Device Management).
2. Compare its SHA-256 fingerprint with the Mac’s Phone access panel. Enable trust in Settings → General → About → Certificate Trust Settings for **Local Lab private Wi-Fi CA**. The Mac can also reveal the `.cer` file for AirDrop. The app does not alter the Mac’s trust store.
3. Open the HTTPS QR/link, enter the six-digit code, and approve that device on the Mac. Codes and pending requests expire after five minutes; each code accepts one pairing request.
4. In Safari, Share → **Add to Home Screen**. The Home Screen app may need its own pairing. Use **Pair a device** again if needed.

Image generation, explicit image editing, reference uploads, model settings, animation handoff, saved chats, earlier runs, progress, cancellation, and media downloads share the desktop’s existing models and serial generation queue. Phone uploads accept PNG/JPEG/WebP, up to 25 MB each; convert HEIC photos to JPEG first. Phone access currently exposes Image and Video tabs. Run-directory deletion and filesystem controls remain on the Mac.

Keep Local Lab running and the Mac’s lid open. With phone access enabled (or a job running), Local Lab prevents idle system sleep; display sleep is fine. Closing the desktop window keeps the service alive on macOS. Quitting the app stops phone access; ongoing generations are not guaranteed to survive a quit or reboot. This is not a separate login/background daemon. Phone access resumes when the app starts if previously enabled. After a network change, disable and re-enable it. Guest-network client isolation or a firewall may prevent the phone reaching the Mac; allow Local Lab’s local connection if macOS asks. The network must provide a private IPv4 address on a physical Wi-Fi/Ethernet interface.

The server binds that LAN interface on **8443**. Only during first-time pairing, **8444** serves the public certificate and setup instructions; it never serves chats, media, credentials, or an API. The HTTPS hostname is the Mac’s stable `.local` name. Certificates are generated locally with OpenSSL (Homebrew preferred, `/usr/bin/openssl` fallback), with a per-installation CA and annually renewed server certificate. Keys and hashed device credentials live in `<Electron userData>/phone/`, outside the repo. Revoke devices individually from the Mac; revocation closes their event streams and denies subsequent media/API requests. Pairings expire after 90 days. Disabling access closes the listeners without deleting saved pairings or outputs.

Chats are now owned and atomically saved by the main-process `Conversations` service. Clients submit idempotent turns with a conversation revision. Concurrent stale submissions are rejected and refreshed rather than replacing another device’s messages. Terminal job results persist without a renderer. SSE reconnects trigger a fresh snapshot; a disconnected phone does not cancel accepted jobs. The PWA caches no private chat/media/API data and provides an offline reconnect page. There are no push notifications or offline generation submissions.

### Phone verification

```sh
pnpm check
pnpm test:phone
node scripts/test-video-workflow.mjs
node scripts/test-image-stack.mjs
pnpm build
```

`test:phone` uses disposable files and loopback TLS, with actual certificate verification. It checks pairing/approval, auth, Origin/Host enforcement, restricted uploads, signed media references, symlink escape prevention, range playback, parameter validation, shared chat persistence, duplicate-turn protection, concurrent edits, SSE, and revocation. It does not invoke a model.

For responsive UI development, `pnpm build && node scripts/preview-phone.mjs` starts a **disposable fixture** at `http://localhost:18787`. It uses sample media and simulated jobs, with a loopback proxy to the real HTTPS service and automatic approval of fixture-only devices. This script is excluded from the packaged app, never opens a LAN port, and never reads real chats/models/device credentials. Stop it with Ctrl-C. Production has no automatic approval or HTTP API.

### Clear history across devices

Open **History & storage** (the settings icon in the top bar), review the summary, type `CLEAR`, and choose **Move history to Trash**. This works in Basic and Advanced on the Mac and paired phones. It clears all Local Lab chats, generated media and text, uploaded references, prompt-preparation records, library favorites and drafts. It blocks while generation, uploads or prompt preparation are active and requires a fresh confirmation if history changes.

Files from the app-owned history directories move together to the Mac’s Trash; empty Trash to reclaim disk space. Models, adapters, training datasets, copies saved elsewhere, presets, directors, moods, intensity settings and phone pairing remain saved. Preset thumbnails and character portraits are cleared because their source images move to Trash. Connected clients refresh automatically; offline clients clear old drafts when they reconnect.

`pnpm test:history` checks reset boundaries and recovery using disposable files. `pnpm test:phone` checks the authenticated reset flow, preserved configuration and fresh generation after clearing. Neither test touches real history.
