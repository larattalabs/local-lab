#!/usr/bin/env python3
"""Expand a tensorwise INT8 ConvRot DiT for an MLX checkpoint.

Uses the regular, symmetric Hadamard rotation specified by comfy-kitchen:
https://github.com/Comfy-Org/comfy-kitchen/blob/main/comfy_kitchen/tensor/int8_utils.py
This preserves the published INT8 approximation; it does not recover the
author's original full-precision training weights. No source file is modified.
"""
import argparse
import json
from pathlib import Path
import tempfile

import torch
from safetensors import safe_open
from safetensors.torch import save_file


def hadamard(size):
    if size < 4 or size & (size - 1) or size.bit_length() % 2 != 1:
        raise ValueError('ConvRot group size must be a power of four.')
    h4 = torch.tensor([[1, 1, 1, -1], [1, 1, -1, 1],
                       [1, -1, 1, 1], [-1, 1, 1, 1]], dtype=torch.float32)
    h = h4
    while h.shape[0] < size:
        h = torch.kron(h, h4)
    return h / size ** 0.5


def expand_weight(weight, scale, config):
    if config.get('format') != 'int8_tensorwise' or weight.dtype != torch.int8:
        raise ValueError('Only tensorwise INT8 weights are supported.')
    value = weight.float() * scale.float()
    if config.get('convrot', False):
        group = config.get('convrot_groupsize', 256)
        if value.ndim != 2 or value.shape[1] % group:
            raise ValueError('Invalid ConvRot matrix dimensions.')
        # H is symmetric and orthogonal: W_rot = W @ H, so W = W_rot @ H.
        value = (value.reshape(-1, group) @ hadamard(group)).reshape(value.shape)
    if not torch.isfinite(value).all():
        raise ValueError('Non-finite expanded weight.')
    return value.to(torch.bfloat16)


def unfuse_gate_up(key, value):
    # ComfyUI qwen_image21 stores [gate; up] in one matrix; Diffusers/MLX
    # address these as gate_layer and proj. Split rows after dequantization.
    # https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/ldm/qwen_image21/model.py
    suffix = '.img_mlp.gate_up.weight'
    if key.endswith(suffix):
        if value.shape[0] % 2:
            raise ValueError('Odd row count in fused SwiGLU weight.')
        gate, up = value.chunk(2, dim=0)
        prefix = key[:-len(suffix)] + '.img_mlp.'
        return {prefix + 'gate_layer.weight': gate.contiguous(), prefix + 'proj.weight': up.contiguous()}
    return {key: value.contiguous()}


def write_checkpoint(source, destination, base):
    transformer = destination / 'transformer'
    transformer.mkdir()
    for item in base.iterdir():
        if item.name != 'transformer':
            (destination / item.name).symlink_to(item, target_is_directory=item.is_dir())
    (transformer / 'config.json').symlink_to(base / 'transformer' / 'config.json')
    shard, mapping, shards, expanded, total = {}, {}, [], 0, 0

    def flush():
        nonlocal shard
        if not shard:
            return
        name = 'diffusion_pytorch_model-%05d.safetensors' % (len(shards) + 1)
        save_file(shard, str(transformer / name), metadata={'format': 'pt', 'source': source.name})
        mapping.update({key: name for key in shard})
        shards.append(name)
        shard = {}

    with safe_open(str(source), framework='pt', device='cpu') as reader:
        for key in reader.keys():
            if key.endswith(('.comfy_quant', '.weight_scale')):
                continue
            value = reader.get_tensor(key)
            if value.dtype == torch.int8:
                if not key.endswith('.weight'):
                    raise ValueError('Unexpected INT8 tensor: ' + key)
                prefix = key[:-len('.weight')]
                config = json.loads(bytes(reader.get_tensor(prefix + '.comfy_quant').tolist()))
                value = expand_weight(value, reader.get_tensor(prefix + '.weight_scale'), config)
                expanded += 1
            total += value.numel() * value.element_size()
            shard.update(unfuse_gate_up(key, value))
            if sum(v.numel() * v.element_size() for v in shard.values()) >= 2 * 1024 ** 3:
                flush()
                print('Wrote', len(shards), 'shards;', expanded, 'INT8 matrices expanded', flush=True)
        flush()
    expected = set(json.loads((base / 'transformer' / 'diffusion_pytorch_model.safetensors.index.json').read_text())['weight_map'])
    if set(mapping) != expected:
        raise ValueError('Converted transformer keys do not exactly match the base architecture.')
    (transformer / 'diffusion_pytorch_model.safetensors.index.json').write_text(json.dumps({
        'metadata': {'total_size': total}, 'weight_map': mapping,
    }, indent=2) + '\n')
    (destination / 'conversion.json').write_text(json.dumps({
        'source': str(source), 'expanded_int8_matrices': expanded, 'tensor_count': len(mapping),
        'output_bytes': total, 'method': 'float32 scale and inverse regular Hadamard, then bfloat16',
    }, indent=2) + '\n')


def convert(source, destination, base):
    if destination.exists() or destination.is_symlink():
        raise ValueError('Destination already exists; do not overwrite a prepared model.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Publish only a complete checkpoint. A failed conversion cleans up its
    # own temporary files and can be retried without exposing partial weights.
    with tempfile.TemporaryDirectory(prefix='.' + destination.name + '-', dir=destination.parent) as temporary:
        prepared = Path(temporary) / 'checkpoint'
        prepared.mkdir()
        write_checkpoint(source, prepared, base)
        prepared.rename(destination)
    print('Prepared', destination, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--base', type=Path, required=True)
    args = parser.parse_args()
    torch.set_num_threads(8)
    convert(args.source.resolve(), args.destination.resolve(), args.base.resolve())
