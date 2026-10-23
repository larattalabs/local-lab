#!/usr/bin/python3
"""Own one DwarfStar server for one Local Lab job, including cancellation.

The large SSD-streamed model must leave memory before the queue runs another
backend. A private loopback server gives us proper chat history and SSE without
leaving an unsupervised 80+ GB daemon behind after a run or cancellation.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


def cancelled(signum, _frame):
    raise SystemExit(128 + signum)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request')
    parser.add_argument('--engine-dir', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--ctx', type=int, default=32768)
    args = parser.parse_args()
    engine = Path(args.engine_dir).resolve()
    model = Path(args.model).resolve()
    body = Path(args.request).read_bytes()
    json.loads(body)  # Fail before loading hundreds of gigabytes for a bad request.
    if not model.is_file():
        raise ValueError('Model file is missing: ' + str(model))

    # Do not collide with the existing V4/omp server or another local service.
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = 'http://127.0.0.1:' + str(port)
    command = [str(engine / 'ds4-server'), '-m', str(model), '--metal',
               '--ssd-streaming', '--ctx', str(args.ctx),
               '--host', '127.0.0.1', '--port', str(port)]
    cache = os.environ.get('LOCALLAB_DS4_CACHE_EXPERTS')
    if cache:
        command += ['--ssd-streaming-cache-experts', cache]
    print('[ds4] Loading V4.1 with SSD streaming; first response takes time.', file=sys.stderr, flush=True)
    # No shell: paths and user messages never become executable shell text.
    # cwd matters: DwarfStar resolves its Metal shaders relative to the engine.
    server = subprocess.Popen(command, cwd=engine, stdin=subprocess.DEVNULL,
                              stdout=sys.stderr, stderr=sys.stderr)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        deadline = time.monotonic() + float(os.environ.get('LOCALLAB_DS4_BOOT_TIMEOUT', '300'))
        while True:
            if server.poll() is not None:
                raise RuntimeError('DwarfStar exited during startup (exit %s); see the run log above.' % server.returncode)
            try:
                with opener.open(base + '/v1/models', timeout=1) as response:
                    ids = [item['id'] for item in json.load(response).get('data', [])]
                    if 'deepseek-v4.1-flash' not in ids:
                        raise RuntimeError('DwarfStar loaded an unexpected model: ' + str(ids))
                break
            except (urllib.error.URLError, TimeoutError, socket.timeout):
                if time.monotonic() >= deadline:
                    raise RuntimeError('DwarfStar did not become ready before the startup timeout.')
                time.sleep(0.25)
        print('[ds4] Ready; generating.', file=sys.stderr, flush=True)
        req = urllib.request.Request(base + '/v1/chat/completions', data=body,
                                     headers={'Content-Type': 'application/json'})
        # ASCII-escaped JSON survives arbitrary UTF-8 chunk boundaries in the
        # runner's pipe reads. The renderer restores Unicode when parsing SSE.
        with opener.open(req, timeout=600) as response:
            done = False
            for line in response:
                if line.strip() == b'data: [DONE]':
                    done = True
                if line.startswith(b'data:') and line.strip() != b'data: [DONE]':
                    event = json.loads(line[5:])
                    if 'error' in event:
                        raise RuntimeError('DwarfStar API error: ' + str(event['error']))
                    line = ('data: ' + json.dumps(event, ensure_ascii=True) + '\n').encode('ascii')
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
            if not done:
                raise RuntimeError('DwarfStar stream ended before completion.')
    finally:
        # Further cancellation must not interrupt reaping the GPU-owning child.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
        print('[ds4] Server stopped; model memory released.', file=sys.stderr, flush=True)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    try:
        main()
    except SystemExit as error:
        if error.code in (130, 143):
            # Runner identifies cancellation from the worker's terminating
            # signal, after the owned server has been stopped and reaped.
            signum = error.code - 128
            signal.signal(signum, signal.SIG_DFL)
            os.kill(os.getpid(), signum)
        raise
    except urllib.error.HTTPError as error:
        print('[ds4] HTTP %s: %s' % (error.code, error.read().decode('utf-8', 'replace')), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, RuntimeError) as error:
        print('[ds4] ' + str(error), file=sys.stderr)
        sys.exit(1)
