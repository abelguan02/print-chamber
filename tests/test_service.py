"""Exercise the real HTTP handler; replace only the costly model boundary."""
import contextlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from PIL import Image
import runtime_config

ROOT = Path(__file__).resolve().parents[1]


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        source = Path(self.temp.name) / 'service.py'
        source.write_bytes((ROOT / 'service.py').read_bytes())
        spec = importlib.util.spec_from_file_location('isolated_service', source)
        self.service = importlib.util.module_from_spec(spec)
        with patch.object(runtime_config, 'STATE', Path(self.temp.name)):
            spec.loader.exec_module(self.service)
        s = self.service
        self.calls = 0
        self.inference_fails = False

        def inference(**kwargs):
            self.calls += 1
            self.input_image = kwargs['image'].copy()
            if self.inference_fails:
                raise RuntimeError('device failure ' + s.TOKEN)
            return types.SimpleNamespace(images=[kwargs['image']])

        s.pipe = inference
        s.prompt_hash = 'test-encoded-prompt-hash'
        s.ready = True
        self.torch = patch.dict(sys.modules, {'torch': types.SimpleNamespace(
            inference_mode=contextlib.nullcontext,
            Generator=lambda _: types.SimpleNamespace(manual_seed=lambda _: None),
            mps=types.SimpleNamespace(synchronize=lambda: None))})
        self.torch.start()
        s.Handler.log_message = lambda *args: None
        self.server = s.ThreadingHTTPServer(('127.0.0.1', 0), s.Handler)
        s.PORT = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        buffer = io.BytesIO()
        Image.new('RGB', (64, 64), '#7799bb').save(buffer, format='PNG')
        self.image = buffer.getvalue()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.torch.stop()
        self.temp.cleanup()

    def request(self, body=None, headers=None, path='/generate', method='POST'):
        connection = http.client.HTTPConnection('127.0.0.1', self.service.PORT, timeout=5)
        try:
            connection.request(method, path, body=body if body is not None else self.image,
                               headers={'Authorization': 'Bearer ' + self.service.TOKEN, **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_same_bytes_cache_but_explicit_refresh_runs_inference(self):
        status, first = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(first['promptHash'], self.service.prompt_hash)
        cached = self.request()[1]
        self.assertTrue(cached['cached'])
        self.assertEqual(cached['promptHash'], self.service.prompt_hash)
        self.assertEqual(self.calls, 1)
        status, data = self.request(headers={'X-Print-Chamber-Refresh': '1'})
        self.assertEqual(status, 200)
        self.assertFalse(data['cached'])
        self.assertEqual(self.calls, 2)

    def test_auth_busy_loading_and_bad_origin(self):
        self.assertEqual(self.request(headers={'Authorization': 'Bearer wrong'})[0], 401)
        self.assertEqual(self.request(headers={'Origin': 'https://evil.example'})[0], 403)
        self.service.ready = False
        self.assertEqual(self.request()[0], 503)
        self.service.ready = True
        with self.service.lock:
            self.assertEqual(self.request()[0], 409)
        self.assertEqual(self.calls, 0)

    def test_invalid_image_is_distinct_from_device_failure(self):
        status, data = self.request(b'not an image')
        self.assertEqual(status, 400)
        self.assertEqual(data['code'], 'INVALID_IMAGE')
        self.inference_fails = True
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status, data = self.request()
        self.assertEqual(status, 500)
        self.assertEqual(data['code'], 'INFERENCE_FAILED')
        self.assertNotIn(self.service.TOKEN, output.getvalue())
        self.assertFalse(self.service.lock.locked())

    def test_oversized_and_malformed_length_release_lock(self):
        self.assertEqual(self.request(headers={'Content-Length': str(13 * 1024 * 1024)})[0], 413)
        self.assertEqual(self.request(headers={'Content-Length': 'bad'})[0], 400)
        self.assertFalse(self.service.lock.locked())

    def test_transparency_is_composited_on_white_before_inference(self):
        for fmt in ('PNG', 'WEBP'):
            with self.subTest(format=fmt):
                image = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
                image.paste((255, 0, 0, 128), (16, 0, 32, 64))
                image.paste((20, 40, 60, 255), (32, 0, 64, 64))
                buf = io.BytesIO()
                image.save(buf, format=fmt, lossless=True)
                self.assertEqual(self.request(buf.getvalue())[0], 200)
                self.assertEqual(self.input_image.getpixel((0, 0)), (255, 255, 255))
                self.assertEqual(self.input_image.getpixel((20, 0)), (255, 127, 127))
                self.assertEqual(self.input_image.getpixel((40, 0)), (20, 40, 60))

    def test_palette_transparency_and_opaque_rgb(self):
        image = Image.new('P', (64, 64), 0)
        image.putpalette([0, 0, 0, 20, 40, 60] + [0] * 762)
        image.paste(1, (32, 0, 64, 64))
        buf = io.BytesIO()
        image.save(buf, format='PNG', transparency=0)
        self.assertEqual(self.request(buf.getvalue())[0], 200)
        self.assertEqual(self.input_image.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(self.input_image.getpixel((40, 0)), (20, 40, 60))
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.input_image.getpixel((0, 0)), (119, 153, 187))

    def test_diagnostics_classify_causes_without_logging_private_text(self):
        private = self.service.TOKEN + ' /Users/private/art.png https://private.example/image'
        cases = [(FileNotFoundError(private), 'FILE_NOT_FOUND'),
                 (PermissionError(private), 'PERMISSION_DENIED'),
                 (RuntimeError('MPS backend out of memory ' + private), 'OUT_OF_MEMORY'),
                 (RuntimeError(private), 'UNCLASSIFIED')]
        for exc, reason in cases:
            with self.subTest(reason=reason):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.service.diagnostic('MODEL_LOAD_FAILED', exc)
                self.assertIn(reason, output.getvalue())
                self.assertNotIn(private, output.getvalue())
                self.assertNotIn(self.service.TOKEN, output.getvalue())
                self.assertNotIn('/Users/', output.getvalue())
                self.assertNotIn('https://', output.getvalue())

    def test_inference_failure_logs_stage_and_local_frame(self):
        self.inference_fails = True
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(self.request()[0], 500)
        self.assertIn('stage=inference', output.getvalue())
        self.assertRegex(output.getvalue(), r'location=service.py:\d+')
        self.assertNotIn(self.service.TOKEN, output.getvalue())


if __name__ == '__main__':
    unittest.main()
