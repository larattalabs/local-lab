#!/bin/zsh
# Bring up exactly one local model server for Local Lab's Code tab, stopping
# the others first so two 30-97 GB models are never resident at once.
#
#   code_backend.zsh <ollama|omlx|ds4|ds4-ablit|ds4-v41>        bring one up, stop the rest
#   code_backend.zsh stop <ollama|omlx|ds4|ds4-ablit|ds4-v41>   stop (or, for Ollama, unload) one
#
# Holds the same lock as the terminal `omp()` backend switcher in ~/.zshrc
# (~/.omp/backend.lock), so a terminal omp and the app never switch at the same
# time. Mirrors the switcher's stop rules: TERM ds4's serve.sh only (its trap
# drains the request and persists KV), wait until the process is really gone,
# SIGKILL at 30 s, and ABORT at 40 s rather than load on top of a model that
# would not die.
#
# Progress lines start with "status: " so the app can show them; anything else
# is log output. Exit status 0 means the target answers on its port.
emulate -L zsh
setopt no_unset pipe_fail

action=ensure
if [[ ${1:-} == stop ]]; then action=stop; shift; fi
target=${1:-}
case "$target" in
  ollama|omlx|ds4|ds4-ablit|ds4-v41) ;;
  *) print -u2 "usage: code_backend.zsh [stop] <ollama|omlx|ds4|ds4-ablit|ds4-v41>"; exit 2 ;;
esac

home=$HOME
DS4_DIR="$home/Developer/_infra/ds4"
ABLIT_DIR="$home/Developer/_infra/ds4-mxfp4-build"
V41_DIR="$home/Developer/_infra/ds4-v41"
V41_MODEL="${LOCALLAB_DS4_MODEL:-$home/AI/ds4-gguf/v41-1017/DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf}"
OMLX_SERVE="$home/AI/laguna/serve-laguna.sh"
OLLAMA_URL="http://127.0.0.1:11434"
CURL=/usr/bin/curl

port_for() {
  case "$1" in
    ollama) print 11434 ;; omlx) print 8080 ;; ds4) print 8000 ;; ds4-ablit) print 8002 ;; ds4-v41) print 8003 ;;
  esac
}
up() {
  local p; p=$(port_for "$1")
  if [[ $1 == ollama ]]; then $CURL -fsS -m 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1
  else $CURL -fsS -m 2 "http://127.0.0.1:$p/v1/models" >/dev/null 2>&1; fi
}
status() { print -r -- "status: $*"; }

# Wait for every process matching $1 to exit; SIGKILL at 30 s, give up at 40 s.
wait_gone() {
  local pattern=$1 name=$2 i=0
  while pgrep -f "$pattern" >/dev/null 2>&1; do
    i=$((i + 1))
    if (( i == 60 )); then status "$name did not stop after 30 s; forcing it"; pkill -KILL -f "$pattern" 2>/dev/null; fi
    if (( i > 80 )); then status "$name FAILED to stop; not loading another model on top of it"; return 1; fi
    sleep 0.5
  done
  return 0
}

stop_ds4() {
  pgrep -f "$DS4_DIR/(serve.sh|ds4-server)" >/dev/null 2>&1 || return 0
  status "Stopping DeepSeek V4 Flash (ds4 :8000) to free memory"
  pkill -TERM -f "$DS4_DIR/serve.sh" 2>/dev/null
  pgrep -f "$DS4_DIR/serve.sh" >/dev/null 2>&1 || pkill -TERM -f "$DS4_DIR/ds4-server" 2>/dev/null
  wait_gone "$DS4_DIR/(serve.sh|ds4-server)" "ds4"
}
stop_ablit() {
  pgrep -f "$ABLIT_DIR/ds4-server" >/dev/null 2>&1 || return 0
  status "Stopping DeepSeek V4 Flash abliterated (ds4 :8002) to free memory"
  pkill -TERM -f "$ABLIT_DIR/ds4-server" 2>/dev/null
  wait_gone "$ABLIT_DIR/ds4-server" "ds4 abliterated"
}
stop_v41() {
  pgrep -f "$V41_DIR/ds4-server" >/dev/null 2>&1 || return 0
  status "Stopping DeepSeek V4.1 (ds4 :8003) to free memory"
  pkill -TERM -f "$V41_DIR/ds4-server" 2>/dev/null
  wait_gone "$V41_DIR/ds4-server" "ds4 V4.1"
}
stop_omlx() {
  pgrep -f "omlx-server" >/dev/null 2>&1 || return 0
  status "Stopping oMLX to free memory"
  pkill -TERM -f "omlx-server" 2>/dev/null
  wait_gone "omlx-server" "oMLX"
}
# Ollama stays running (it is the user's always-on service); only its loaded
# models are evicted.
unload_ollama() {
  up ollama || return 0
  local names
  names=$($CURL -fsS -m 3 "$OLLAMA_URL/api/ps" 2>/dev/null | /usr/bin/python3 -c 'import json,sys
try:
  print("\n".join(m["name"] for m in json.load(sys.stdin).get("models", [])))
except Exception:
  pass') || return 0
  [[ -z $names ]] && return 0
  local n
  for n in ${(f)names}; do
    status "Unloading $n from Ollama"
    $CURL -fsS -m 30 "$OLLAMA_URL/api/generate" -d "{\"model\":\"$n\",\"keep_alive\":0}" >/dev/null 2>&1
  done
  local i=0
  while [[ -n $($CURL -fsS -m 3 "$OLLAMA_URL/api/ps" 2>/dev/null | /usr/bin/python3 -c 'import json,sys
try:
  print("x" if json.load(sys.stdin).get("models") else "")
except Exception:
  pass') ]]; do
    i=$((i + 1)); (( i > 60 )) && { status "Ollama did not unload its model"; return 1; }
    sleep 0.5
  done
}

wait_up() {
  local name=$1 limit=$2 log=$3 i=0
  until up "$name"; do
    i=$((i + 1))
    (( i % 15 == 0 )) && status "Still loading $name (${i}s)…"
    if (( i > limit )); then status "$name not ready after ${limit}s; see $log"; return 1; fi
    sleep 1
  done
}

switch() {
  # Stop everything heavy except the target. Order: biggest first.
  [[ $target != ds4-v41 ]] && { stop_v41 || return 1; }
  [[ $target != ds4-ablit ]] && { stop_ablit || return 1; }
  [[ $target != ds4 ]] && { stop_ds4 || return 1; }
  [[ $target != omlx ]] && { stop_omlx || return 1; }
  [[ $target != ollama ]] && { unload_ollama || return 1; }

  up "$target" && { status "$target ready"; return 0; }
  mkdir -p "$home/.ds4"
  case "$target" in
    ollama)
      status "Ollama is not running. Start the Ollama app, then try again."
      return 1 ;;
    omlx)
      [[ -x $OMLX_SERVE ]] || { status "Missing $OMLX_SERVE"; return 1; }
      status "Starting oMLX on :8080 (the model loads on the first request)"
      nohup "$OMLX_SERVE" >"$home/AI/laguna/.omlx_serve.log" 2>&1 &!
      wait_up omlx 120 "$home/AI/laguna/.omlx_serve.log" ;;
    ds4)
      [[ -x $DS4_DIR/serve.sh ]] || { status "Missing $DS4_DIR/serve.sh"; return 1; }
      status "Starting DeepSeek V4 Flash on :8000 (loads ~86 GB)"
      nohup "$DS4_DIR/serve.sh" >"$home/.ds4/server.log" 2>&1 &!
      wait_up ds4 420 "$home/.ds4/server.log" ;;
    ds4-ablit)
      [[ -x $ABLIT_DIR/serve-abliterated.sh ]] || { status "Missing $ABLIT_DIR/serve-abliterated.sh"; return 1; }
      status "Starting DeepSeek V4 Flash abliterated on :8002 (loads ~86 GB)"
      # ds4 resolves metal/*.metal relative to its working directory.
      ( cd "$ABLIT_DIR" && nohup ./serve-abliterated.sh >"$home/.ds4/server-ablit.log" 2>&1 &! )
      wait_up ds4-ablit 420 "$home/.ds4/server-ablit.log" ;;
    ds4-v41)
      [[ -x $V41_DIR/ds4-server && -f $V41_MODEL ]] || { status "Missing ds4 V4.1 engine or model"; return 1; }
      status "Starting DeepSeek V4.1 with SSD streaming on :8003 (first turn is slow)"
      ( cd "$V41_DIR" && nohup "$V41_DIR/ds4-server" -m "$V41_MODEL" --metal --ssd-streaming \
          --ctx "${LOCALLAB_V41_CTX:-65536}" --host 127.0.0.1 --port 8003 >"$home/.ds4/server-v41.log" 2>&1 &! )
      wait_up ds4-v41 420 "$home/.ds4/server-v41.log" ;;
  esac
  local rc=$?
  (( rc == 0 )) && status "$target ready"
  return $rc
}

stop_one() {
  case "$target" in
    ds4) stop_ds4 ;; ds4-ablit) stop_ablit ;; ds4-v41) stop_v41 ;; omlx) stop_omlx ;; ollama) unload_ollama ;;
  esac
  local rc=$?
  (( rc == 0 )) && status "$target stopped"
  return $rc
}
run() { if [[ $action == stop ]]; then stop_one; else switch; fi }

lock="$home/.omp/backend.lock"
mkdir -p "$home/.omp"; : >> "$lock"
if zmodload zsh/system 2>/dev/null; then
  (
    zsystem flock -t 180 -f lockfd "$lock" 2>/dev/null || { status "Another backend switch is in progress (terminal omp?)"; exit 3; }
    run
  )
  exit $?
fi
run
