#!/usr/bin/env python3
"""CPU checks for the published ConvRot format; run with mflux's Python."""
import importlib.util
from pathlib import Path
import unittest

import torch

spec = importlib.util.spec_from_file_location('prepare_noct', Path(__file__).with_name('prepare-noct-q.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class ConversionTests(unittest.TestCase):
    def test_regular_hadamard(self):
        expected = torch.tensor([[1, 1, 1, -1], [1, 1, -1, 1],
                                 [1, -1, 1, 1], [-1, 1, 1, 1]], dtype=torch.float32) / 2
        torch.testing.assert_close(prepare.hadamard(4), expected)
        for size in (4, 16, 64, 256):
            h = prepare.hadamard(size)
            torch.testing.assert_close(h @ h, torch.eye(size), rtol=0, atol=0)

    def test_forward_with_inverse_rotation(self):
        torch.manual_seed(42)
        q = torch.randint(-100, 100, (16, 512), dtype=torch.int8)
        scale = torch.linspace(.001, .01, 16)[:, None]
        config = {'format': 'int8_tensorwise', 'convrot': True, 'convrot_groupsize': 256}
        expanded = prepare.expand_weight(q, scale, config).float()
        x = torch.randn(3, 512)
        rotated_x = (x.reshape(-1, 256) @ prepare.hadamard(256)).reshape(x.shape)
        expected = rotated_x @ (q.float() * scale).T
        # BF16 introduces the only additional approximation in the expansion.
        error = torch.linalg.norm(x @ expanded.T - expected) / torch.linalg.norm(expected)
        self.assertLess(error.item(), .005)

    def test_plain_int8(self):
        q = torch.tensor([[1, -2, 3, 4]], dtype=torch.int8)
        actual = prepare.expand_weight(q, torch.tensor(0.5), {'format': 'int8_tensorwise'})
        torch.testing.assert_close(actual.float(), q.float() * 0.5)

    def test_rejects_unrecognized_format(self):
        with self.assertRaises(ValueError):
            prepare.expand_weight(torch.ones((4, 4), dtype=torch.int8), torch.tensor(1), {'format': 'other'})
        with self.assertRaises(ValueError):
            prepare.hadamard(8)

    def test_fused_swiglu_order(self):
        fused = torch.arange(24).reshape(8, 3)
        prefix = 'transformer_blocks.0.img_mlp.'
        result = prepare.unfuse_gate_up(prefix + 'gate_up.weight', fused)
        torch.testing.assert_close(result[prefix + 'gate_layer.weight'], fused[:4])
        torch.testing.assert_close(result[prefix + 'proj.weight'], fused[4:])


if __name__ == '__main__':
    unittest.main(verbosity=2)
