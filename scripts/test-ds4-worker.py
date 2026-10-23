#!/usr/bin/python3
"""Protocol and process-lifecycle tests; no model weights or GPU required."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

WORKER = Path(__file__).resolve().parents[1] / 'resources/workers/ds4_chat.py'
FAKE_SERVER = r'''#!/usr/bin/python3
import json, os, signal, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
Path('server.pid').write_text(str(os.getpid()))
mode = os.environ.get('DS4_TEST_MODE', 'success')
if mode == 'startup-failure': sys.exit(7)
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200); self.end_headers()
        self.wfile.write(b'{"data":[{"id":"deepseek-v4.1-flash"}]}')
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        Path('received.json').write_bytes(body)
        if mode == 'http-error':
            self.send_response(400); self.end_headers()
            self.wfile.write(b'{"error":{"message":"context full"}}'); return
        self.send_response(200); self.end_headers()
        if mode == 'cancel':
            Path('generating').touch()
            time.sleep(30); return
        if mode == 'sse-error':
            self.wfile.write(b'data: {"error":{"message":"decode failed"}}\n\n'); return
        event = {'choices':[{'delta':{'content':'Hello, caf\u00e9!'}}]}
        self.wfile.write(('data: '+json.dumps(event,ensure_ascii=False)+'\n\n').encode())
        if mode != 'truncated': self.wfile.write(b'data: [DONE]\n\n')
HTTPServer(('127.0.0.1',int(sys.argv[sys.argv.index('--port')+1])),Handler).serve_forever()
'''


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='local-lab-ds4-')
        self.root = Path(self.tmp.name)
        server = self.root / 'ds4-server'
        server.write_text(FAKE_SERVER)
        server.chmod(0o755)
        (self.root / 'model.gguf').touch()
        self.body = {'model': 'deepseek-v4.1-flash', 'stream': True, 'messages': [
            {'role': 'system', 'content': 'Be concise.'},
            {'role': 'user', 'content': 'Remember teal.'},
            {'role': 'assistant', 'content': 'Okay.'},
            {'role': 'user', 'content': 'Which color?'}]}
        (self.root / 'request.json').write_text(json.dumps(self.body))
        self.command = ['/usr/bin/python3', str(WORKER), str(self.root / 'request.json'),
                        '--engine-dir', str(self.root), '--model', str(self.root / 'model.gguf')]

    def tearDown(self):
        self.tmp.cleanup()

    def start(self, mode):
        return subprocess.Popen(self.command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={**os.environ, 'DS4_TEST_MODE': mode}, text=True)

    def assert_reaped(self):
        pid = int((self.root / 'server.pid').read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_stream_and_history(self):
        child = self.start('success')
        out, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, err)
        event = json.loads(out.splitlines()[0][5:])
        self.assertEqual(event['choices'][0]['delta']['content'], 'Hello, café!')
        self.assertTrue(out.isascii())
        self.assertIn('data: [DONE]', out)
        self.assertEqual(json.loads((self.root / 'received.json').read_text()), self.body)
        self.assert_reaped()

    def test_http_error(self):
        child = self.start('http-error')
        _, err = child.communicate(timeout=10)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('context full', err)
        self.assert_reaped()

    def test_incomplete_stream(self):
        child = self.start('truncated')
        _, err = child.communicate(timeout=10)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('before completion', err)
        self.assert_reaped()

    def test_stream_error(self):
        child = self.start('sse-error')
        _, err = child.communicate(timeout=10)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('decode failed', err)
        self.assert_reaped()

    def test_startup_failure(self):
        child = self.start('startup-failure')
        _, err = child.communicate(timeout=10)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('exit 7', err)
        self.assert_reaped()

    def test_cancel_reaps_server(self):
        child = self.start('cancel')
        try:
            deadline = time.monotonic() + 10
            while not (self.root / 'generating').exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue((self.root / 'generating').exists())
            child.terminate()
            child.communicate(timeout=15)
            self.assertEqual(child.returncode, -signal.SIGTERM)
            self.assert_reaped()
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()


if __name__ == '__main__':
    unittest.main(verbosity=2)
