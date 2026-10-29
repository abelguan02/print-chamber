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
from runtime_config import STATE, settings

ROOT = Path(__file__).resolve().parent
PORT = 8877
UPLOAD_TIMEOUT = 15
STATE.mkdir(exist_ok=True, mode=0o700)
STATE.chmod(0o700)
KEY = STATE / 'token'
try:
    token_fd = os.open(KEY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    KEY.chmod(0o600)
else:
    with os.fdopen(token_fd, 'w') as token_file:
        token_file.write(secrets.token_urlsafe(32))
TOKEN = KEY.read_text().strip()
lock = threading.Lock()
ready = False
failure = None
cache = OrderedDict()
pipe = None
embeds = None
prompt_hash = None

SAMPLES = [
    'applegreed-web2.jpg', 'harshal-magar-vodyanitsa.jpg', 'kirino-ttk-3.webp',
    'mintflavor-mintflavor-cross-bow-weapon-bulls-eyes-muted-color-dark-tone-f478b23b-d023-4b10-9e32-fd60cd538df0-1.jpg',
    'haiyang-ocean-sun-haiyang-ocean-sun-linework-copy-2-copy.webp',
]

def load():
    global pipe, embeds, ready, failure, prompt_hash
    stage = 'dependencies'
    try:
        import torch
        from diffusers import Flux2KleinPipeline
        from benchmark_local import PROMPT
        stage = 'device_check'
        if not torch.backends.mps.is_available():
            raise RuntimeError('无法访问 Metal GPU，请检查模型运行环境及 macOS 权限。')
        stage = 'model_load'
        pipe = Flux2KleinPipeline.from_pretrained(
            str(settings()['model']),
            torch_dtype=torch.bfloat16, local_files_only=True)
        stage = 'prompt_encode'
        pipe.text_encoder.to('mps')
        with torch.inference_mode():
            embeds, _ = pipe.encode_prompt(prompt=PROMPT, device=torch.device('mps'), max_sequence_length=256)
        prompt_hash = hashlib.sha256(PROMPT.encode('utf-8')).hexdigest()
        torch.mps.synchronize()
        pipe.text_encoder.to('cpu')
        pipe.text_encoder = None
        gc.collect()
        torch.mps.empty_cache()
        stage = 'model_to_device'
        pipe.to('mps')
        torch.mps.synchronize()
        ready = True
        print('模型已就绪。可通过菜单栏小助手停止服务。', flush=True)
    except Exception as exc:
        failure = str(exc)
        diagnostic('MODEL_LOAD_FAILED', exc, stage)

def diagnostic(code, exc, stage='unknown'):
    # Classify internally; never emit raw exception text, paths, URLs or locals.
    reason = 'UNCLASSIFIED'
    if isinstance(exc, FileNotFoundError):
        reason = 'FILE_NOT_FOUND'
    elif isinstance(exc, PermissionError):
        reason = 'PERMISSION_DENIED'
    elif isinstance(exc, ImportError):
        reason = 'DEPENDENCY_UNAVAILABLE'
    elif isinstance(exc, MemoryError) or 'out of memory' in str(exc).lower():
        reason = 'OUT_OF_MEMORY'
    elif isinstance(exc, TimeoutError):
        reason = 'TIMEOUT'
    elif isinstance(exc, ConnectionError):
        reason = 'CONNECTION_INTERRUPTED'
    location = 'unknown'
    trace = exc.__traceback__
    while trace:
        if trace.tb_frame.f_code.co_filename == __file__:
            location = f'service.py:{trace.tb_lineno}'
        trace = trace.tb_next
    print(f'{code}: {type(exc).__name__} reason={reason} stage={stage} location={location}', flush=True)

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
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Print-Chamber-Refresh')
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
                p = settings()['samples'] / SAMPLES[index]
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
            return self.respond(503, {'code': 'MODEL_LOAD_FAILED' if failure else 'MODEL_LOADING',
                                      'error': '模型加载失败，请在菜单栏查看运行日志' if failure else '模型正在准备，请稍后重试'})
        acquired = False
        stage = 'request_read'
        try:
            deadline = time.monotonic() + UPLOAD_TIMEOUT
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                return self.respond(400, {'code': 'INVALID_LENGTH', 'error': '图片传输长度无效'})
            if not 0 < length <= 12 * 1024 * 1024:
                return self.respond(413, {'error': '图片文件过大'})
            raw = bytearray()
            while len(raw) < length:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Upload deadline exceeded')
                self.connection.settimeout(remaining)
                # read1 performs at most one socket read, so trickling bytes cannot reset the deadline.
                chunk = self.rfile.read1(min(65536, length - len(raw)))
                if time.monotonic() >= deadline:
                    raise TimeoutError('Upload deadline exceeded')
                if not chunk:
                    break
                raw.extend(chunk)
            self.connection.settimeout(15)
            if len(raw) != length:
                return self.respond(400, {'error': '图片传输不完整'})
            key = hashlib.sha256(raw).hexdigest()
            acquired = lock.acquire(blocking=False)
            if not acquired:
                return self.respond(409, {'code': 'MODEL_BUSY', 'error': '正在处理另一张图片，请稍后重试'})
            if key in cache and self.headers.get('X-Print-Chamber-Refresh') != '1':
                cache.move_to_end(key)
                return self.respond(200, {**cache[key], 'cached': True})
            from PIL import Image, ImageOps, UnidentifiedImageError
            import torch
            Image.MAX_IMAGE_PIXELS = 24000000
            start = time.perf_counter()
            stage = 'image_decode'
            try:
                with Image.open(io.BytesIO(raw), formats=('JPEG', 'PNG', 'WEBP')) as img:
                    if img.width * img.height > 24000000:
                        return self.respond(413, {'code': 'IMAGE_TOO_LARGE', 'error': '图片分辨率过大'})
                    img = ImageOps.exif_transpose(img)
                    if 'A' in img.getbands() or 'transparency' in img.info:
                        rgba = img.convert('RGBA')
                        img = Image.alpha_composite(Image.new('RGBA', rgba.size, 'white'), rgba).convert('RGB')
                    else:
                        img = img.convert('RGB')
                    w, h = dimensions(*img.size)
                    img.thumbnail((w, h), Image.Resampling.LANCZOS)
            except Image.DecompressionBombError:
                return self.respond(413, {'code': 'IMAGE_TOO_LARGE', 'error': '图片分辨率过大'})
            except (UnidentifiedImageError, OSError, ValueError):
                return self.respond(400, {'code': 'INVALID_IMAGE', 'error': '图片数据损坏或格式不受支持'})
            stage = 'inference'
            with torch.inference_mode():
                result = pipe(image=img, prompt_embeds=embeds, width=w, height=h,
                              num_inference_steps=4, guidance_scale=1.0,
                              generator=torch.Generator('cpu').manual_seed(42)).images[0]
            stage = 'device_sync'
            torch.mps.synchronize()
            stage = 'result_encode'
            buf = io.BytesIO()
            result.save(buf, format='JPEG', quality=90)
            data = {'image': 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode(),
                    'seconds': round(time.perf_counter() - start, 3), 'cached': False, 'width': w, 'height': h,
                    'promptHash': prompt_hash}
            cache[key] = data
            while len(cache) > 24:
                cache.popitem(last=False)
            self.respond(200, data)
        except (TimeoutError, ConnectionError) as exc:
            diagnostic('TRANSFER_FAILED', exc, stage)
            self.respond(408, {'code': 'TRANSFER_FAILED', 'error': '图片传输中断，请重试'})
        except Exception as exc:
            diagnostic('INFERENCE_FAILED', exc, stage)
            self.respond(500, {'code': 'INFERENCE_FAILED', 'error': '模型推理失败，请在菜单栏查看运行日志，必要时重启模型'})
        finally:
            if acquired:
                lock.release()

if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'本地服务：http://127.0.0.1:{PORT}/demo\n连接码请通过菜单栏小助手复制。', flush=True)
    threading.Thread(target=load, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
