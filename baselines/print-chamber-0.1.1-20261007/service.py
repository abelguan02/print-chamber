"""Loopback-only image editing service. No cloud calls or URL fetching."""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
import base64
import gc
import hashlib
import io
import json
import secrets
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PORT = 8877
STATE = ROOT / '.local'
STATE.mkdir(exist_ok=True, mode=0o700)
KEY = STATE / 'token'
if not KEY.exists():
    KEY.write_text(secrets.token_urlsafe(32))
KEY.chmod(0o600)
TOKEN = KEY.read_text().strip()
lock = threading.Lock()
ready = False
failure = None
cache = OrderedDict()
pipe = None
embeds = None

SAMPLES = [
    'applegreed-web2.jpg', 'harshal-magar-vodyanitsa.jpg', 'kirino-ttk-3.webp',
    'mintflavor-mintflavor-cross-bow-weapon-bulls-eyes-muted-color-dark-tone-f478b23b-d023-4b10-9e32-fd60cd538df0-1.jpg',
    'haiyang-ocean-sun-haiyang-ocean-sun-linework-copy-2-copy.webp',
]

def load():
    global pipe, embeds, ready, failure
    try:
        import torch
        from diffusers import Flux2KleinPipeline
        from benchmark_local import PROMPT
        if not torch.backends.mps.is_available():
            raise RuntimeError('无法访问 Metal GPU，请从终端启动本地服务。')
        pipe = Flux2KleinPipeline.from_pretrained(
            os.environ.get('FLUX_MODEL_PATH', '/Users/abelguan/Models/FLUX.2-klein-4B'),
            torch_dtype=torch.bfloat16, local_files_only=True)
        pipe.text_encoder.to('mps')
        with torch.inference_mode():
            embeds, _ = pipe.encode_prompt(prompt=PROMPT, device=torch.device('mps'), max_sequence_length=256)
        torch.mps.synchronize()
        pipe.text_encoder.to('cpu')
        pipe.text_encoder = None
        gc.collect()
        torch.mps.empty_cache()
        pipe.to('mps')
        torch.mps.synchronize()
        ready = True
        print('模型已就绪。关闭此终端即可停止服务并释放模型。', flush=True)
    except Exception as exc:
        failure = str(exc)
        print('模型加载失败：' + failure, flush=True)

def dimensions(width, height):
    scale = min(1, 768 / max(width, height), (330000 / (width * height)) ** .5)
    return max(64, round(width * scale / 16) * 16), max(64, round(height * scale / 16) * 16)

class Handler(BaseHTTPRequestHandler):
    server_version = 'PrintChamber/0.1'

    def allowed(self):
        host = self.headers.get('Host', '')
        origin = self.headers.get('Origin')
        return host in (f'127.0.0.1:{PORT}', f'localhost:{PORT}') and (
            not origin or origin in (f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}')
            or (origin.startswith('chrome-extension://') and len(origin.removeprefix('chrome-extension://')) == 32))

    def respond(self, status, body, mime='application/json'):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin and self.allowed():
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        if not self.allowed():
            return self.respond(403, {'error': '拒绝访问'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', ''))
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.end_headers()

    def do_GET(self):
        if not self.allowed():
            return self.respond(403, {'error': '拒绝访问'})
        path = urlsplit(self.path).path
        if path == '/health':
            if self.headers.get('Authorization') and not secrets.compare_digest(self.headers.get('Authorization'), 'Bearer ' + TOKEN):
                return self.respond(401, {'error': '连接码不正确'})
            return self.respond(200, {'ready': ready, 'busy': lock.locked(), 'failed': bool(failure)})
        if path in ('/', '/demo'):
            return self.respond(200, (ROOT / 'demo.html').read_bytes(), 'text/html; charset=utf-8')
        if path.startswith('/sample/'):
            try:
                index = int(path.rsplit('/', 1)[-1])
                if not 0 <= index < len(SAMPLES):
                    raise ValueError()
                p = Path('/Users/abelguan/Downloads') / SAMPLES[index]
                return self.respond(200, p.read_bytes(), 'image/webp' if p.suffix == '.webp' else 'image/jpeg')
            except (ValueError, OSError):
                return self.respond(404, {'error': '样图不存在'})
        return self.respond(404, {'error': '不存在'})

    def do_POST(self):
        if not self.allowed():
            return self.respond(403, {'error': '拒绝访问'})
        if not secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
            return self.respond(401, {'error': '请在插件中填写本地连接码'})
        if self.path != '/generate':
            return self.respond(404, {'error': '不存在'})
        if not ready:
            return self.respond(503, {'error': '模型加载失败，请检查终端' if failure else '模型正在准备，请稍后重试'})
        if not lock.acquire(blocking=False):
            return self.respond(409, {'error': '正在处理另一张图片，请稍后重试'})
        try:
            self.connection.settimeout(15)
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 12 * 1024 * 1024:
                return self.respond(413, {'error': '图片文件过大'})
            raw = self.rfile.read(length)
            if len(raw) != length:
                return self.respond(400, {'error': '图片传输不完整'})
            key = hashlib.sha256(raw).hexdigest()
            if key in cache:
                cache.move_to_end(key)
                return self.respond(200, {**cache[key], 'cached': True})
            from PIL import Image, ImageOps
            import torch
            Image.MAX_IMAGE_PIXELS = 24000000
            start = time.perf_counter()
            with Image.open(io.BytesIO(raw)) as img:
                if img.width * img.height > 24000000:
                    return self.respond(413, {'error': '图片分辨率过大'})
                img = ImageOps.exif_transpose(img).convert('RGB')
                w, h = dimensions(*img.size)
                img.thumbnail((w, h), Image.Resampling.LANCZOS)
            with torch.inference_mode():
                result = pipe(image=img, prompt_embeds=embeds, width=w, height=h,
                              num_inference_steps=4, guidance_scale=1.0,
                              generator=torch.Generator('cpu').manual_seed(42)).images[0]
            torch.mps.synchronize()
            buf = io.BytesIO()
            result.save(buf, format='JPEG', quality=90)
            data = {'image': 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode(),
                    'seconds': round(time.perf_counter() - start, 3), 'cached': False, 'width': w, 'height': h}
            cache[key] = data
            while len(cache) > 24:
                cache.popitem(last=False)
            self.respond(200, data)
        except Exception as exc:
            print('生成失败：' + str(exc), flush=True)
            self.respond(400, {'error': '无法处理这张图片，请尝试其他图片'})
        finally:
            lock.release()

if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'本地服务：http://127.0.0.1:{PORT}/demo\n插件连接码：{TOKEN}', flush=True)
    threading.Thread(target=load, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
