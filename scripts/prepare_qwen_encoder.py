"""Create a symlinked Qwen encoder view compatible with mflux 0.23's editor."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile


def compatible_config(original):
    config = deepcopy(original)
    text = config['text_config']
    rope = text.get('rope_scaling') or text.get('rope_parameters')
    if not rope or 'mrope_section' not in rope:
        raise ValueError('Qwen encoder has no recognized multimodal RoPE configuration.')
    # Transformers 5 moved these fields; mflux's reference editor still reads
    # the Transformers 4 names. Keep both schemas and preserve all values.
    text.setdefault('rope_scaling', {k: v for k, v in rope.items() if k != 'rope_theta'})
    if 'rope_theta' not in text:
        text['rope_theta'] = rope['rope_theta']
    return config


def prepare_encoder(source, destination):
    source = source.resolve()
    config = json.dumps(compatible_config(json.loads((source / 'config.json').read_text())), indent=2) + '\n'
    if destination.exists() and not destination.is_symlink():
        if (destination / 'config.json').read_text() != config:
            raise ValueError('Existing encoder config differs from the pinned compatibility view.')
        for item in source.iterdir():
            if item.name != 'config.json' and (destination / item.name).resolve() != item.resolve():
                raise ValueError('Existing encoder component differs: ' + item.name)
        return
    if destination.is_symlink() and destination.resolve() != source:
        raise ValueError('Refusing to replace a link to another encoder.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.qwen-encoder-', dir=destination.parent) as temporary:
        prepared = Path(temporary) / 'encoder'
        prepared.mkdir()
        for item in source.iterdir():
            if item.name != 'config.json':
                (prepared / item.name).symlink_to(item, target_is_directory=item.is_dir())
        (prepared / 'config.json').write_text(config)
        (prepared / 'encoder-compatibility.json').write_text(json.dumps({
            'source': str(source), 'operation': 'Add legacy rope_scaling and rope_theta aliases for mflux 0.23',
        }, indent=2) + '\n')
        # This only replaces an earlier link to the same immutable snapshot.
        # Cached config and weight bytes are never edited or removed.
        if destination.is_symlink():
            destination.unlink()
        prepared.rename(destination)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    prepare_encoder(args.source, args.destination)
