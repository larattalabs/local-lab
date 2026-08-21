#!/bin/bash
# One streamed chat completion against the local oMLX server.
#
# oMLX is not a always-on daemon like Ollama — it parks 20-70GB per loaded
# model, so it normally sits stopped. Starting it is therefore part of running
# a job: if nothing answers on the port, launch the serve script detached (the
# same one used from the shell) and wait for it to bind before sending. The
# server outlives this job on purpose, exactly like the omp wrapper does;
# idle models still unload on oMLX's own timer.
#
# args: <request.json>   (full OpenAI-format body; see registry/omlx.ts)
set -uo pipefail

# NB: deliberately NOT named OMLX_HOST — oMLX reads that itself as its bind
# host, and an inherited value collides with the serve script's --port flag
# ("http://127.0.0.1:8080:8080" -> Errno 8, server never binds).
HOST="${LOCALLAB_OMLX_HOST:-127.0.0.1:8080}"
SERVE="${LOCALLAB_OMLX_SERVE:-$HOME/AI/laguna/serve-laguna.sh}"
REQ="${1:?usage: omlx_chat.sh <request.json>}"
BOOT_TIMEOUT="${LOCALLAB_OMLX_BOOT_TIMEOUT:-90}"

up() { curl -s --max-time 2 "http://$HOST/v1/models" >/dev/null 2>&1; }

if ! up; then
  if [ ! -x "$SERVE" ]; then
    echo "oMLX is not running and no serve script found at $SERVE." >&2
    echo "Start it yourself, or set LOCALLAB_OMLX_SERVE to the launcher." >&2
    exit 3
  fi
  BOOTLOG="${TMPDIR:-/tmp}/locallab-omlx-serve.log"
  echo "oMLX not running — starting $SERVE (log: $BOOTLOG) …" >&2
  nohup "$SERVE" > "$BOOTLOG" 2>&1 &
  for _ in $(seq "$BOOT_TIMEOUT"); do
    sleep 1
    up && break
  done
  if ! up; then
    echo "oMLX did not start listening on $HOST within ${BOOT_TIMEOUT}s." >&2
    echo "--- last lines of $BOOTLOG ---" >&2
    tail -20 "$BOOTLOG" >&2 2>/dev/null
    exit 4
  fi
  echo "oMLX up." >&2
fi

# --fail-with-body keeps the server's JSON error visible instead of collapsing
# it into a bare exit code; -N disables buffering so tokens stream live.
exec curl -sN --fail-with-body "http://$HOST/v1/chat/completions" \
  -H 'Content-Type: application/json' --data-binary "@$REQ"
