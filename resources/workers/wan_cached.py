"""Reuse lossless Wan A14B conditioning across one-shot MLX workers."""
import hashlib
import json
import os
import runpy
import sys
import tempfile
from dataclasses import asdict
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from zipfile import BadZipFile

import mlx.core as mx
import numpy as np
from mlx_video import generate_wan as wan
from mlx_video.models.wan.text_encoder import T5Encoder
from mlx_video.models.wan.vae import WanVAE


def signature(path):
    path = Path(path).resolve()
    stat = path.stat()
    return [str(path), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


class ConditioningCache:
    def __init__(self, directory, runtime):
        self.directory = directory
        self.revision = [1, version("mlx"), version("mlx-video-with-audio"), runtime]

    def get_or_compute(self, kind, identity, shape, compute):
        key = hashlib.sha256(json.dumps([self.revision, identity], sort_keys=True).encode()).hexdigest()
        target = self.directory / f"{kind}-{key}.npz"
        try:
            with np.load(target, allow_pickle=False) as saved:
                value = saved["encoding"]
            if value.shape == shape and value.dtype == np.float32:
                os.utime(target, None)
                print(f"Wan {kind} cache hit", flush=True)
                return mx.array(value)
        except (OSError, ValueError, EOFError, KeyError, BadZipFile):
            pass

        result = compute()
        mx.eval(result)
        if result.shape != shape or result.dtype != mx.float32:
            return result
        print(f"Wan {kind} cache miss", flush=True)
        try:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=self.directory, delete=False) as stream:
                temporary = Path(stream.name)
                try:
                    # ZIP_STORED includes a CRC for the array. Publish only complete entries.
                    np.savez(stream, encoding=np.asarray(result))
                    stream.flush()
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
            entries = [(p.stat(), p) for p in self.directory.glob('*.npz')]
            total = sum(stat.st_size for stat, _ in entries)
            for stat, path in sorted(entries, key=lambda row: row[0].st_mtime_ns):
                if total <= 256 * 1024**2:
                    break
                path.unlink(missing_ok=True)
                total -= stat.st_size
        except OSError as error:
            print(f"Wan cache write skipped: {error}", file=sys.stderr)
        return result


class DeferredWeights:
    """Construct on every run to preserve the original MLX RNG sequence.

    The pinned upstream loaders initialize random layers before replacing their
    weights. Skipping construction on a hit would change the seeded video.
    """
    def __init__(self, model, path, strict):
        self.model = model
        self.path = path
        self.strict = strict
        self.loaded = False

    def load(self):
        if not self.loaded:
            weights = [(k, v.astype(mx.float32)) for k, v in mx.load(str(self.path)).items()]
            self.model.load_weights(weights, strict=self.strict)
            mx.eval(self.model.parameters())
            self.loaded = True
        return self.model


def install_cache(cache):
    original_vae = wan.load_vae_encoder

    def load_t5(path, config):
        # Mirrors load_t5_encoder in mlx-video-with-audio 0.1.36.
        model = T5Encoder(vocab_size=config.t5_vocab_size, dim=config.t5_dim,
                          dim_attn=config.t5_dim_attn, dim_ffn=config.t5_dim_ffn,
                          num_heads=config.t5_num_heads, num_layers=config.t5_num_layers,
                          num_buckets=config.t5_num_buckets, shared_pos=False)
        weights = DeferredWeights(model, path, strict=True)
        identity = [signature(path), asdict(config)]

        def encode(ids, mask):
            # The actual token IDs and mask cover tokenizer/template changes,
            # the negative prompt in CFG runs, and upstream text normalization.
            inputs = [np.asarray(ids).tolist(), np.asarray(mask).tolist()]
            return cache.get_or_compute("text", [identity, inputs], (*ids.shape, config.t5_dim),
                                        lambda: weights.load()(ids, mask=mask))
        return encode

    def load_vae(path, config):
        if config.model_type != 'i2v' or config.vae_z_dim != 16:
            return original_vae(path, config)
        weights = DeferredWeights(WanVAE(z_dim=16, encoder=True), path, strict=False)
        identity = [signature(path), config.vae_z_dim, config.vae_stride]

        class ImageEncoder:
            def encode(self, video):
                # The upstream A14B I2V call supplies the preprocessed first frame
                # followed by zeros. Hash those pixels and the full temporal shape.
                batch, _, frames, height, width = video.shape
                pixels = hashlib.sha256(np.asarray(video[:, :, 0]).tobytes()).hexdigest()
                shape = (batch, 16, (frames - 1) // 4 + 1, height // 8, width // 8)
                return cache.get_or_compute("image", [identity, pixels, video.shape, str(video.dtype)],
                                            shape, lambda: weights.load().encode(video))
        return ImageEncoder()

    wan.load_t5_encoder = load_t5
    wan.load_vae_encoder = load_vae


if __name__ == "__main__":
    script = sys.argv.pop(1)
    directory = os.environ.get("LOCALLAB_WAN_CACHE")
    try:
        supported = version("mlx-video-with-audio") == "0.1.36"
    except PackageNotFoundError:
        supported = False
    if directory and supported:
        install_cache(ConditioningCache(Path(directory), signature(script) if script != "-" else "stock"))
    if script == "-":
        wan.main()
    else:
        sys.argv[0] = script
        sys.path.insert(0, str(Path(script).parent))
        runpy.run_path(script, run_name="__main__")
