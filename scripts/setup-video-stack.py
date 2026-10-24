"""Fetch pinned stock video weights, verify them, then expose neutral local views.

Run with a Python environment containing huggingface_hub. Runtimes are installed
separately; see README. Personal checkpoints are configured outside this repo.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(os.environ.get('LOCALLAB_AI_ROOT', Path.home() / 'AI'))
os.environ.setdefault('HF_HOME', str(ROOT / 'huggingface'))
os.environ.setdefault('HF_HUB_CACHE', str(ROOT / 'huggingface' / 'hub'))
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')

SOURCES = {
    'h3': ('MiniMaxAI/MiniMax-H3', '42ed227ee7df40d41602854ae760620d6eb651fe', 'h3-stock'),
    'ltx-2.5': ('dgrauet/ltx-2.5-mlx-q8', '746ca9aacb697d2c739f544d68b584214dedcc75', 'ltx-2.5'),
}


def selected(model: str, name: str) -> bool:
    if model == 'h3':
        return name.startswith('FL2VA/') or name in {'LICENSE', 'README.md'}
    return name not in {'transformer-dev.safetensors', 'ltx-2.5-22b-distilled-lora-450-bf16.safetensors'}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(16 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def link(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        if destination.resolve() == source.resolve():
            return
        raise RuntimeError(f'Refusing to replace an existing link: {destination}')
    if destination.exists():
        raise RuntimeError(f'Refusing to replace an existing file: {destination}')
    destination.symlink_to(source)


def install(model: str, *, offline: bool, workers: int) -> None:
    from huggingface_hub import HfApi, hf_hub_download

    repo, revision, name = SOURCES[model]
    view = ROOT / 'video-stack' / name
    manifest_path = view / 'source-manifest.json'
    if offline:
        manifest = json.loads(manifest_path.read_text())
        if manifest['repo'] != repo or manifest['revision'] != revision:
            raise RuntimeError('The cached source manifest does not match the pinned revision.')
    else:
        info = HfApi().model_info(repo, revision=revision, files_metadata=True)
        manifest = {'repo': repo, 'revision': revision, 'files': [
            {'path': f.rfilename, 'size': f.size, 'sha256': f.lfs.sha256 if f.lfs else None}
            for f in info.siblings if selected(model, f.rfilename)
        ]}
        view.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')

    def fetch(file: dict) -> tuple[dict, Path]:
        path = Path(hf_hub_download(repo, file['path'], revision=revision, local_files_only=offline))
        if path.stat().st_size != file['size']:
            raise RuntimeError(f"Size mismatch: {file['path']}")
        if file['sha256'] and digest(path) != file['sha256']:
            raise RuntimeError(f"SHA-256 mismatch: {file['path']}")
        print(f"Verified {model}: {file['path']}", flush=True)
        return file, path

    # Invalidate readiness before checking so a failed repair cannot stay runnable.
    ready = view / 'local-lab-ready.json'
    ready.unlink(missing_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for file, path in pool.map(fetch, manifest['files']):
            link(path, view / file['path'])
    ready.write_text(json.dumps({'revision': revision, 'verified_files': len(manifest['files'])}, indent=2) + '\n')
    print(f'Ready: {view}', flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', choices=list(SOURCES))
    parser.add_argument('--offline', action='store_true', help='Verify cached files using the saved source manifest.')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.workers <= 8:
        parser.error('--workers must be between 1 and 8')
    for model in [args.only] if args.only else SOURCES:
        install(model, offline=args.offline, workers=args.workers)


if __name__ == '__main__':
    main()
