#!/usr/bin/env python3
"""Prepare LTX's pinned stock text encoder in the shared cache; no inference."""
import os
from pathlib import Path

ai = Path(os.environ.get('LOCALLAB_AI_ROOT', str(Path.home() / 'AI')))
os.environ['HF_HOME'] = os.environ.get('LOCALLAB_HF_HOME', str(ai / 'huggingface'))
os.environ['HF_HUB_CACHE'] = os.environ.get('LOCALLAB_HF_HUB_CACHE', str(Path(os.environ['HF_HOME']) / 'hub'))
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
from huggingface_hub import snapshot_download

repo = 'mlx-community/gemma-3-12b-it-bf16'
revision = 'b8b9b412cb795bd6115fdce8c9a0ef0d1664db3a'
snapshot = Path(snapshot_download(repo, revision=revision,
    allow_patterns=['*.json', '*.safetensors', '*.model', '*.txt', '*.jinja'], max_workers=2))
destination = Path(os.environ.get('LOCALLAB_LTX_ENCODER_DIR', str(ai / 'video-stack' / 'ltx-text-encoder')))
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.is_symlink():
    if destination.resolve() != snapshot.resolve():
        raise ValueError('Existing encoder view differs from the pinned source.')
elif destination.exists():
    raise ValueError('Refusing to replace an existing encoder directory.')
else:
    destination.symlink_to(snapshot, target_is_directory=True)
print('Prepared LTX text encoder at', destination)
