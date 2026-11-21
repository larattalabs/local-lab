#!/usr/bin/env python3
"""One-shot full or Turbo Qwen generation using the isolated mlx-serve INT8 engine.

Keeps existing weights/encoders and unmerged adapters. The localhost server
exists only for this request and is also stopped on cancellation.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request



def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--engine', type=Path, default=Path(__file__).resolve().parents[1]/'mlx-serve-macos-arm64/mlx-serve')
    ap.add_argument('--base-model', choices=['qwen-image-2.1', 'qwen-image-2.1-turbo'])
    ap.add_argument('--no-bake-lora', action='store_true')
    ap.add_argument('--model', required=True, type=Path)
    ap.add_argument('--prompt', required=True)
    ap.add_argument('--output', required=True, type=Path)
    ap.add_argument('--width', type=int, default=1024)
    ap.add_argument('--height', type=int, default=1024)
    ap.add_argument('--steps', type=int, default=40)
    ap.add_argument('--guidance', type=float, default=1)
    ap.add_argument('--negative-prompt', default='')
    ap.add_argument('--seed', type=int)
    ap.add_argument('--lora', nargs=2, action='append', default=[], metavar=('FILE','SCALE'))
    ap.add_argument('--benchmark-count', type=int, choices=(1, 3), default=1)
    args = ap.parse_args()
    ENGINE = args.engine
    if not ENGINE.is_file(): ap.error('The isolated mlx-serve engine is missing.')
    for component in ['transformer','vae','text_encoder','processor','scheduler']:
        if not (args.model/component).is_dir(): ap.error('Missing model component: '+component)
    if args.base_model == 'qwen-image-2.1-turbo':
        grid = json.loads((args.model/'model_index.json').read_text()).get('sample_sigmas')
        if not isinstance(grid, list) or len(grid) != 8 or args.steps != 8:
            ap.error('Turbo requires its installed eight-step distilled schedule.')
    if not 1 <= args.steps <= 60: ap.error('steps must be 1–60')
    if any(n<256 or n>2048 or n%32 for n in [args.width,args.height]):
        ap.error('width and height must be multiples of 32 between 256 and 2048')
    if not 0 <= args.guidance <= 20: ap.error('guidance must be 0–20')
    if args.seed is not None and args.seed != -1 and not 0 <= args.seed < 2**32: ap.error('seed must be unsigned 32-bit')
    if len(args.lora)>8: ap.error('At most eight adapters are supported')
    for path, scale in args.lora:
        if not Path(path).is_file(): ap.error('Adapter file is missing: '+path)
        if not 0 <= float(scale) <= 2: ap.error('Adapter scale must be 0–2')
    seed=args.seed if args.seed is not None and args.seed != -1 else secrets.randbelow(2**32)
    body=dict(model='qwen-full', prompt=args.prompt, size=f'{args.width}x{args.height}',
              steps=args.steps, seed=seed, guidance_scale=args.guidance,
              negative_prompt=args.negative_prompt, response_format='b64_json',
              lora_paths=[str(Path(p).resolve()) for p,_ in args.lora],
              lora_scales=[float(s) for _,s in args.lora])
    started=time.monotonic()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    token=secrets.token_urlsafe(32)
    def cancel(signum, _frame): raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM,cancel)
    signal.signal(signal.SIGINT,cancel)
    with tempfile.TemporaryDirectory(prefix='qwen-full-') as temp:
        view=Path(temp)/'qwen-full';view.mkdir()
        for p in args.model.iterdir():
            if p.name != 'config.json': (view/p.name).symlink_to(p.resolve(),target_is_directory=p.is_dir())
        (view/'config.json').write_text('{"model_type":"qwen_image21"}')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        url=f'http://127.0.0.1:{port}'
        cmd=[str(ENGINE),'--serve','--host','127.0.0.1','--port',str(port),
             '--model-dir',temp,'--max-resident-models','1','--w8a8','--log-file','off',
             '--api-key-env','LOCAL_LAB_NATIVE_AUTH','--api-key-strict']
        proc=subprocess.Popen(cmd,env={**os.environ,'LOCAL_LAB_NATIVE_AUTH':token})
        try:
            deadline=time.monotonic()+60
            while True:
                if proc.poll() is not None: raise RuntimeError('Native engine exited before becoming ready')
                try:
                    with urllib.request.urlopen(url+'/health',timeout=1) as response:
                        if response.status==200:break
                except (urllib.error.URLError,TimeoutError):pass
                if time.monotonic()>deadline:raise RuntimeError('Native engine startup timed out')
                time.sleep(0.2)
            print(f'Qwen INT8: {args.steps} steps, seed {seed}',flush=True)
            ready=time.monotonic()
            for index in range(args.benchmark_count):
                request_start=time.monotonic()
                body['seed']=(seed+index) % 2**32
                output=args.output if index == 0 else args.output.with_stem(f'{args.output.stem}-{index+1}')
                request=urllib.request.Request(url+'/v1/images/generations',data=json.dumps(body).encode(),
                           headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
                try:
                    with urllib.request.urlopen(request,timeout=1200) as response:result=json.load(response)
                except urllib.error.HTTPError as exc:
                    raise RuntimeError(exc.read().decode()) from exc
                png=base64.b64decode(result['data'][0]['b64_json'],validate=True)
                if not png.startswith(b'\x89PNG\r\n\x1a\n'):raise RuntimeError('Engine did not return a PNG')
                output.write_bytes(png)
                metadata={**body,'model':str(args.model.absolute()),'engine':str(ENGINE),'compute':'w8a8',
                          'server_pid':proc.pid, 'server_ready_seconds':ready-started, 'request_seconds':time.monotonic()-request_start,
                          'wall_seconds':time.monotonic()-started}
                output.with_suffix('.json').write_text(json.dumps(metadata,indent=2))
                print(f'Saved {output} ({metadata["wall_seconds"]:.2f}s)',flush=True)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:proc.wait(timeout=10)
                except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':
    try: main()
    except SystemExit as exc:
        if exc.code in (130, 143):
            sig = exc.code - 128
            signal.signal(sig, signal.SIG_DFL)
            os.kill(os.getpid(), sig)
        raise
