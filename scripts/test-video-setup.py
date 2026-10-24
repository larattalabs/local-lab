"""Exercise installation integrity without network access or model downloads."""
import hashlib
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('video_setup', Path(__file__).with_name('setup-video-stack.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class VideoSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.source = self.cache / 'weights'
        self.source.write_bytes(b'verified model bytes')
        self.api = Mock()
        self.api.model_info.return_value = SimpleNamespace(siblings=[SimpleNamespace(
            rfilename='FL2VA/transformer/model.safetensors', size=self.source.stat().st_size,
            lfs=SimpleNamespace(sha256=hashlib.sha256(self.source.read_bytes()).hexdigest()))])
        self.fetch = Mock(return_value=str(self.source))
        self.addCleanup(patch.stopall)
        patch.object(setup, 'ROOT', self.root).start()
        patch.object(setup, 'SOURCES', {'h3': ('example/stock', 'pinned-revision', 'h3-stock')}).start()
        patch.dict('sys.modules', {'huggingface_hub': SimpleNamespace(HfApi=lambda: self.api, hf_hub_download=self.fetch)}).start()
        self.view = self.root / 'video-stack/h3-stock'

    def test_verified_view_rechecks_offline(self):
        setup.install('h3', offline=False, workers=1)
        link = self.view / 'FL2VA/transformer/model.safetensors'
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(), self.source.resolve())
        self.assertEqual(json.loads((self.view / 'local-lab-ready.json').read_text())['revision'], 'pinned-revision')
        setup.install('h3', offline=True, workers=1)
        self.assertEqual(self.api.model_info.call_count, 1)
        self.assertTrue(self.fetch.call_args.kwargs['local_files_only'])

    def test_corruption_removes_readiness(self):
        setup.install('h3', offline=False, workers=1)
        self.source.write_bytes(b'corrupt! model bytes')  # Same length; catches a hash failure, not just truncation.
        with self.assertRaisesRegex(RuntimeError, 'SHA-256 mismatch'):
            setup.install('h3', offline=True, workers=1)
        self.assertFalse((self.view / 'local-lab-ready.json').exists())

    def test_existing_model_file_is_preserved(self):
        file = self.view / 'FL2VA/transformer/model.safetensors'
        file.parent.mkdir(parents=True)
        file.write_bytes(b'existing file')
        with self.assertRaisesRegex(RuntimeError, 'Refusing to replace'):
            setup.install('h3', offline=False, workers=1)
        self.assertEqual(file.read_bytes(), b'existing file')
        self.assertFalse((self.view / 'local-lab-ready.json').exists())


if __name__ == '__main__':
    unittest.main()
