"""Config compatibility checks; needs only the Python standard library."""
import json
from pathlib import Path
import tempfile
import unittest
from prepare_qwen_encoder import compatible_config, prepare_encoder


class EncoderViewTests(unittest.TestCase):
    def test_transformers5_aliases_preserve_values(self):
        source = {'text_config': {'rope_parameters': {'rope_theta': 5000000,
                  'mrope_section': [24, 20, 20], 'rope_type': 'default'}}}
        result = compatible_config(source)
        self.assertEqual(result['text_config']['rope_theta'], 5000000)
        self.assertEqual(result['text_config']['rope_scaling']['mrope_section'], [24, 20, 20])
        self.assertEqual(result['text_config']['rope_parameters'], source['text_config']['rope_parameters'])
        self.assertNotIn('rope_scaling', source['text_config'])

    def test_legacy_config_unchanged(self):
        source = {'text_config': {'rope_theta': 5000000, 'rope_scaling': {'mrope_section': [24, 20, 20]}}}
        self.assertEqual(compatible_config(source), source)

    def test_view_shares_weights_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source, view = Path(directory) / 'source', Path(directory) / 'view'
            source.mkdir()
            text = json.dumps({'text_config': {'rope_parameters': {'rope_theta': 5000000, 'mrope_section': [24, 20, 20]}}})
            (source / 'config.json').write_text(text)
            (source / 'model.safetensors').write_bytes(b'unchanged weight fixture')
            view.symlink_to(source, target_is_directory=True)
            prepare_encoder(source, view)
            prepare_encoder(source, view)  # Idempotent rerun.
            self.assertFalse(view.is_symlink())
            self.assertTrue((view / 'model.safetensors').is_symlink())
            self.assertEqual((view / 'model.safetensors').resolve(), (source / 'model.safetensors').resolve())
            self.assertEqual((source / 'config.json').read_text(), text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
