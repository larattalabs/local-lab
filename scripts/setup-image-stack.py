#!/usr/bin/env python3
"""Fetch pinned image checkpoints into the shared HF cache and compose views.

Run with ~/.local/share/uv/tools/mflux/bin/python after installing mflux 0.23.
Requires the signed-in HF account to have access to FLUX 3 Image Klein.
"""
import concurrent.futures
import json
import os
from pathlib import Path

AI = Path(os.environ.get('LOCALLAB_AI_ROOT', str(Path.home() / 'AI')))
ROOT = Path(os.environ.get('LOCALLAB_IMAGE_MODELS_DIR', str(AI / 'image-stack')))
os.environ['HF_HOME'] = os.environ.get('LOCALLAB_HF_HOME', str(AI / 'huggingface'))
os.environ['HF_HUB_CACHE'] = os.environ.get('LOCALLAB_HF_HUB_CACHE', str(Path(os.environ['HF_HOME']) / 'hub'))
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
from huggingface_hub import snapshot_download

QWEN_PATTERNS = ['model_index.json', 'processor/**', 'scheduler/*.json', 'vae/*.json',
                 'vae/*.safetensors', 'transformer/*.json', 'transformer/*.safetensors',
                 'text_encoder/*.json', 'text_encoder/*.safetensors']
SOURCES = [
    ('qwen-image-2.1', 'Qwen/Qwen-Image-2.1', 'd26bb61231c349cf6b7896fa83353113880e1ba3', QWEN_PATTERNS),
    ('qwen-image-2.1-turbo', 'Qwen/Qwen-Image-2.1-Turbo', 'fc13ba1986fcb905854dc8de2f52eee395f49b5b',
     [p for p in QWEN_PATTERNS if not p.startswith('text_encoder/')]),
    ('flux3-image-klein', 'black-forest-labs/flux-3-image-klein', '8454017f9ebaada30c998fccd9f67a80c7580f68',
     ['config.json', 'vae/*.json', 'vae/*.safetensors', 'transformer/*.json', 'transformer/*.safetensors',
      'text_encoder/*.json', 'text_encoder/*.safetensors', 'text_encoder/merges.txt', 'text_encoder/chat_template.jinja',
      'LICENSE.md', 'NOTICE.md']),
]


def link(target, destination):
    if destination.is_symlink():
        if destination.resolve() != target.resolve():
            raise ValueError('Existing checkpoint link differs from the pinned source: ' + str(destination))
    elif destination.exists():
        raise ValueError('Refusing to replace existing path: ' + str(destination))
    else:
        destination.symlink_to(target, target_is_directory=target.is_dir())


def view(source, destination, encoder=None):
    destination.mkdir(exist_ok=True)
    for item in source.iterdir():
        target = encoder if encoder is not None and item.name == 'text_encoder' else item
        link(target, destination / item.name)
    if encoder is not None and not (destination / 'text_encoder').exists():
        link(encoder, destination / 'text_encoder')


def fetch(source):
    name, repo, revision, patterns = source
    snapshot = Path(snapshot_download(repo, revision=revision, allow_patterns=patterns, max_workers=2))
    return {'name': name, 'repo': repo, 'revision': revision, 'snapshot': str(snapshot)}


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    # Fetching overlaps network only. Real inference is always serial.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        sources = list(pool.map(fetch, SOURCES))
    for source in sources:
        name, snapshot = source['name'], Path(source['snapshot'])
        if name == 'qwen-image-2.1-turbo':
            # Turbo changes the DiT and schedule. Reuse the installed base
            # Qwen3-VL encoder, retaining its full vision tower for editing.
            view(snapshot, ROOT / name, ROOT / 'qwen-image-2.1' / 'text_encoder')
        else:
            link(snapshot, ROOT / name)
    (ROOT / 'sources.json').write_text(json.dumps(sources, indent=2) + '\n')
    print('Prepared image checkpoints in', ROOT)


if __name__ == '__main__':
    main()
