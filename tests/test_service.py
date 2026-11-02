"""Exercise the real HTTP handler; replace only the costly model boundary."""
import contextlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from PIL import Image, EpsImagePlugin
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
        self.seeds = []
        self.inference_fails = False

        def inference(**kwargs):
            self.calls += 1
            self.seeds.append(kwargs['generator'])
            self.input_image = kwargs['image'].copy()
            if self.inference_fails:
                raise RuntimeError('device failure ' + s.TOKEN)
            return types.SimpleNamespace(images=[kwargs['image']])

        s.pipe = inference
        s.prompt_hash = 'test-encoded-prompt-hash'
        s.ready = True
        self.torch = patch.dict(sys.modules, {'torch': types.SimpleNamespace(
            inference_mode=contextlib.nullcontext,
            Generator=lambda _: types.SimpleNamespace(manual_seed=lambda seed: seed),
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

    def test_refresh_changes_seed_and_caches_the_new_result(self):
        first = self.request()[1]
        self.assertEqual(first['seed'], 42)
        # Even a random draw matching the previous seed must produce a new variant.
        with patch.object(self.service.secrets, 'randbits', return_value=42):
            second = self.request(headers={'X-Print-Chamber-Refresh': '1'})[1]
            third = self.request(headers={'X-Print-Chamber-Refresh': '1'})[1]
        self.assertNotEqual(second['seed'], first['seed'])
        self.assertNotEqual(third['seed'], second['seed'])
        self.assertEqual(self.seeds, [first['seed'], second['seed'], third['seed']])
        cached = self.request()[1]
        self.assertTrue(cached['cached'])
        self.assertEqual(cached['seed'], third['seed'])
        self.assertEqual(self.calls, 3)

    def test_failed_refresh_keeps_previous_cached_result(self):
        first = self.request()[1]
        self.inference_fails = True
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.request(headers={'X-Print-Chamber-Refresh': '1'})[0], 500)
        cached = self.request()[1]
        self.assertTrue(cached['cached'])
        self.assertEqual(cached['image'], first['image'])
        self.assertEqual(cached['seed'], first['seed'])

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

    def test_only_jpeg_png_webp_reach_inference(self):
        for fmt in ('JPEG', 'PNG', 'WEBP', 'BMP', 'TIFF', 'GIF'):
            with self.subTest(format=fmt):
                buf = io.BytesIO()
                Image.new('RGB', (64, 64), '#7799bb').save(buf, format=fmt)
                before = self.calls
                status, data = self.request(buf.getvalue())
                if fmt in ('JPEG', 'PNG', 'WEBP'):
                    self.assertEqual(status, 200)
                else:
                    self.assertEqual((status, data['code']), (400, 'INVALID_IMAGE'))
                    self.assertEqual(self.calls, before)
        eps = b'%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 64 64\n%%EndComments\nshowpage\n'
        with patch.object(EpsImagePlugin, 'Ghostscript', side_effect=AssertionError('EPS decoder called')) as decoder:
            self.assertEqual(self.request(eps)[0], 400)
            decoder.assert_not_called()

    def test_slow_upload_does_not_occupy_model_and_has_total_deadline(self):
        self.service.UPLOAD_TIMEOUT = 0.6
        with socket.create_connection(('127.0.0.1', self.service.PORT), timeout=3) as connection:
            headers = (f'POST /generate HTTP/1.1\r\nHost: 127.0.0.1:{self.service.PORT}\r\n'
                       f'Authorization: Bearer {self.service.TOKEN}\r\nContent-Length: 100\r\n\r\n')
            connection.sendall(headers.encode() + b'x')
            started = time.monotonic()
            time.sleep(0.05)
            self.assertFalse(self.service.lock.locked())
            self.assertEqual(self.request()[0], 200, 'a complete upload can use the model')
            # Another inference owns the lock when the slow transfer times out.
            with self.service.lock:
                for _ in range(3):
                    time.sleep(0.1)
                    connection.sendall(b'x')
                with contextlib.redirect_stdout(io.StringIO()):
                    response = http.client.HTTPResponse(connection)
                    response.begin()
                    self.assertEqual(response.status, 408)
                    self.assertEqual(json.loads(response.read())['code'], 'TRANSFER_FAILED')
                self.assertTrue(self.service.lock.locked(), 'timeout must not release another request\'s lock')
            self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(self.request()[0], 200)

    def test_incomplete_upload_does_not_lock_model(self):
        with socket.create_connection(('127.0.0.1', self.service.PORT), timeout=3) as connection:
            connection.sendall((f'POST /generate HTTP/1.1\r\nHost: 127.0.0.1:{self.service.PORT}\r\n'
                                f'Authorization: Bearer {self.service.TOKEN}\r\nContent-Length: 10\r\n\r\nx').encode())
            connection.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(connection)
            response.begin()
            self.assertEqual(response.status, 400)
            self.assertIn('不完整', json.loads(response.read())['error'])
        self.assertFalse(self.service.lock.locked())
        self.assertEqual(self.calls, 0)

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


class TokenPermissionsTests(unittest.TestCase):
    def test_private_at_creation_and_existing_token_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder) / 'state'
            state.mkdir(mode=0o755)
            observed = []
            original = os.fdopen

            def observe(fd, *args, **kwargs):
                observed.append(stat.S_IMODE(os.fstat(fd).st_mode))
                return original(fd, *args, **kwargs)

            def load_service():
                spec = importlib.util.spec_from_file_location('permission_service', ROOT / 'service.py')
                module = importlib.util.module_from_spec(spec)
                with patch.object(runtime_config, 'STATE', state):
                    spec.loader.exec_module(module)
                return module

            previous_umask = os.umask(0o022)
            try:
                with patch('os.fdopen', side_effect=observe):
                    first = load_service()
            finally:
                os.umask(previous_umask)
            self.assertEqual(observed, [0o600], 'token must be private before its first write')
            self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
            (state / 'token').chmod(0o644)
            self.assertEqual(load_service().TOKEN, first.TOKEN, 'startup must not rotate an existing connection code')
            self.assertEqual(stat.S_IMODE((state / 'token').stat().st_mode), 0o600)


if __name__ == '__main__':
    unittest.main()
