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

from test_local_model import FILES, REV, ROOT


class HubHTTPTest(unittest.TestCase):
    def test_pinned_sdk_resumes_against_loopback_hub(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            data = home / 'state'
            partial = data / 'snapshot/transformer/weights.partial'
            partial.parent.mkdir(parents=True)
            offset = 32768
            partial.write_bytes(FILES['transformer/weights'][:offset])
            ranges = []
            repo = 'black-forest-labs/FLUX.2-klein-4B'

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    start = 0
                    if self.path.split('?')[0] == f'/api/models/{repo}/revision/{REV}':
                        body = json.dumps({'id': repo, 'sha': REV, 'siblings': [
                            {'rfilename': key, 'size': len(value)} for key, value in FILES.items()
                        ]}).encode()
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
                    subprocess.run([sys.executable, '-B', str(ROOT / 'installer/local_model.py'),
                                    str(data / 'snapshot'), str(data / 'progress.json')], check=True, env=env, timeout=15)
                finally:
                    server.shutdown()
            self.assertEqual(ranges, [('transformer/weights', f'bytes={offset}-')])
            self.assertEqual((data / 'snapshot/transformer/weights').read_bytes(), FILES['transformer/weights'])
            size = sum(map(len, FILES.values()))
            self.assertEqual(json.loads((data / 'progress.json').read_text()), {'downloaded': size, 'total': size})


if __name__ == '__main__':
    unittest.main()
