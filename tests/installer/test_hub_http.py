"""Exercise the packaged Python downloader with the pinned Hub SDK and a loopback Hub."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from test_local_model import FILES, REV, ROOT, hub_metadata


class HubHTTPTest(unittest.TestCase):
    def test_pinned_sdk_resumes_against_loopback_hub(self):
        self.check_resumed_file(corrupt_prefix=False)

    def test_checksum_covers_bytes_retained_before_resume(self):
        self.check_resumed_file(corrupt_prefix=True)

    def check_resumed_file(self, corrupt_prefix):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            data = home / 'state'
            partial = data / 'snapshot/transformer/weights.partial'
            partial.parent.mkdir(parents=True)
            offset = 32768
            partial.write_bytes(b'x' * offset if corrupt_prefix else FILES['transformer/weights'][:offset])
            ranges = []
            repo = 'black-forest-labs/FLUX.2-klein-4B'

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    start = 0
                    if self.path.split('?')[0] == f'/api/models/{repo}/revision/{REV}':
                        body = json.dumps({'id': repo, 'sha': REV, 'siblings': hub_metadata()}).encode()
                    elif self.path.startswith(f'/{repo}/resolve/{REV}/'):
                        key = self.path.split(f'/resolve/{REV}/')[1]
                        body = FILES[key]
                        if self.headers.get('Range'):
                            ranges.append((key, self.headers['Range']))
                            start = int(self.headers['Range'][6:-1])
                    else:
                        self.send_error(404)
                        return
                    self.send_response(206 if start else 200)
                    if start:
                        self.send_header('Content-Range', f'bytes {start}-{len(body)-1}/{len(body)}')
                    self.send_header('Content-Length', str(len(body)-start))
                    self.end_headers()
                    self.wfile.write(body[start:])

                def log_message(self, *args):
                    pass

            with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
                threading.Thread(target=server.serve_forever, daemon=True).start()
                try:
                    env = dict(os.environ, HOME=temp, HF_HOME=str(data / 'hf'),
                               HF_ENDPOINT=f'http://127.0.0.1:{server.server_port}', HF_HUB_DISABLE_IMPLICIT_TOKEN='1')
                    result = subprocess.run(
                        [sys.executable, '-B', str(ROOT / 'installer/local_model.py'),
                         str(data / 'snapshot'), str(data / 'progress.json')], env=env, timeout=15)
                finally:
                    server.shutdown()
            self.assertEqual(ranges, [('transformer/weights', f'bytes={offset}-')])
            self.assertFalse(partial.exists())
            weights = data / 'snapshot/transformer/weights'
            if corrupt_prefix:
                self.assertEqual(result.returncode, 65)
                self.assertFalse(weights.exists())
                return
            self.assertEqual(result.returncode, 0)
            self.assertEqual(weights.read_bytes(), FILES['transformer/weights'])
            size = sum(map(len, FILES.values()))
            self.assertEqual(json.loads((data / 'progress.json').read_text()), {'downloaded': size, 'total': size})


if __name__ == '__main__':
    unittest.main()
