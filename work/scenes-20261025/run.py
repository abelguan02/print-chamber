"""Isolated scene prompt comparison. No service or extension changes."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from benchmark_local import PROMPT, torch, Flux2KleinPipeline, sync
from PIL import Image, ImageOps, ImageDraw
import gc
import hashlib
import html
import json
import signal
import time

FILES = [
    'dawnpu-at-art-vision-studio-xzz.jpeg',
    'kevin-zamir-goeke-es-reka-marketingartii-13-k-small.jpg',
    'nolan-bouana-262.webp',
    'telmo-berzosa-render-final-final-bn.jpg',
    'vinicius-pazian-catatau-entrada-templolobby-agua-5.jpeg',
]
LABELS = ['浮空水域', '秋林行走屋', '花店设计板', '熔岩神殿', '水下大厅']
GENERAL = (
    'Re-render this exact illustration as a high-quality 3D game cinematic, keeping the entire picture unchanged. '
    'Preserve the original composition, camera angle, perspective, framing, scale, silhouettes and spatial layout of every element. '
    'Keep all architecture, terrain, water, vegetation, props and any characters in their original positions and proportions. '
    'Match the original colors, brightness, lighting direction, shadows and atmosphere. '
    'Only change the rendering: solid three-dimensional forms, distinct believable materials, surface depth, gentle contact shadows and volumetric light. '
    'Preserve existing text and separate design panels. No redesign, added or removed objects, cropping or rearrangement.'
)


def main():
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('600 second experiment limit reached')))
    signal.alarm(600)
    if not torch.backends.mps.is_available():
        raise RuntimeError('Metal GPU is unavailable in this execution environment')
    out = ROOT / 'output' / ('scenes-ab-' + time.strftime('%Y%m%d-%H%M%S'))
    out.mkdir(parents=True, exist_ok=False)
    protected = ['benchmark_local.py', 'service.py', 'extension/cloud-prompt.js', 'extension/manifest.json']
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in protected}
    report = dict(model='/Users/abelguan/Models/FLUX.2-klein-4B', steps=4, cfg=1.0, seed=42,
                  device='mps', dtype='bfloat16', prompts={'D': PROMPT, 'G': GENERAL},
                  hashes_before=hashes, sources=[], runs=[], status='running',
                  resolution_policy='long edge <=768, area approximately <=330000; dimensions rounded to multiples of 16; full image resized without cropping',
                  prompt_cache=True, image_cache=False)
    def save():
        (out / 'metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for i, name in enumerate(FILES, 1):
        path = Path('/Users/abelguan/Downloads') / name
        with Image.open(path) as im:
            source = ImageOps.exif_transpose(im).convert('RGB')
        width, height = source.size
        scale = min(1, 768 / max(width, height), (330000 / (width * height)) ** .5)
        size = [max(64, round(width * scale / 16) * 16), max(64, round(height * scale / 16) * 16)]
        source.save(out / f'{i}-original.jpg', quality=95)
        source.resize(size, Image.Resampling.LANCZOS).save(out / f'{i}-input.png')
        report['sources'].append(dict(id=i, path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest(), original_size=[width, height], size=size))
    save()
    print('OUTPUT ' + str(out), flush=True)
    start = time.perf_counter()
    pipe = Flux2KleinPipeline.from_pretrained(report['model'], torch_dtype=torch.bfloat16, local_files_only=True)
    pipe.set_progress_bar_config(disable=True)
    sync()
    report['model_load_seconds'] = time.perf_counter() - start
    pipe.text_encoder.to('mps')
    embeds = {}
    for key, prompt in report['prompts'].items():
        start_prompt = time.perf_counter()
        token_count = len(pipe.tokenizer.encode(prompt))
        if token_count > 256:
            raise ValueError(f'{key} prompt exceeds 256 token limit: {token_count}')
        with torch.inference_mode():
            embeds[key], _ = pipe.encode_prompt(prompt=prompt, device=torch.device('mps'), max_sequence_length=256)
        sync()
        report.setdefault('prompt_encoding', {})[key] = dict(tokens=token_count, seconds=time.perf_counter()-start_prompt)
    pipe.text_encoder.to('cpu')
    pipe.text_encoder = None
    gc.collect()
    torch.mps.empty_cache()
    pipe.to('mps')
    sync()
    report['load_and_prompts_seconds'] = time.perf_counter() - start
    save()
    print('READY setup_seconds=' + str(round(report['load_and_prompts_seconds'], 2)), flush=True)
    jobs = [(i, key, False) for i in range(1, 6) for key in ['D', 'G']] + [(1, 'G', True)]
    for i, key, repeat in jobs:
        with Image.open(out / f'{i}-input.png') as im:
            source = im.convert('RGB')
        sync()
        begin = time.perf_counter()
        with torch.inference_mode():
            result = pipe(image=source, prompt_embeds=embeds[key], width=source.width, height=source.height,
                          num_inference_steps=4, guidance_scale=1.0,
                          generator=torch.Generator('cpu').manual_seed(42)).images[0]
        sync()
        elapsed = time.perf_counter() - begin
        filename = f'{i}-{key}' + ('-repeat' if repeat else '') + '.png'
        result.save(out / filename)
        report['runs'].append(dict(image=i, variant=key, repeat=repeat, size=list(source.size), seconds=elapsed,
                                   first_pipeline_call=len(report['runs']) == 0, file=filename,
                                   mps_allocated_gb=torch.mps.current_allocated_memory()/1e9))
        save()
        print(f'RESULT {i} {key} repeat={repeat} {elapsed:.2f}s', flush=True)
    report['hashes_after'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in protected}
    report['protected_files_unchanged'] = report['hashes_after'] == hashes
    report['status'] = 'complete'
    save()
    rows = []
    sheet = Image.new('RGB', (1536, 5 * 360), '#202024')
    draw = ImageDraw.Draw(sheet)
    for i, label in enumerate(LABELS, 1):
        cards = []
        for col, (suffix, title) in enumerate([('input', '模型输入'), ('D', '当前 D'), ('G', '通用 G')]):
            filename = f'{i}-{suffix}.png'
            cards.append(f'<figure><figcaption>{title}</figcaption><a href="{filename}"><img src="{filename}" alt="{html.escape(label)} {title}"></a></figure>')
            with Image.open(out / filename) as im:
                fitted = ImageOps.contain(im.convert('RGB'), (500, 310))
                x, y = col * 512 + (512-fitted.width)//2, (i-1)*360 + 32 + (310-fitted.height)//2
                sheet.paste(fitted, (x, y))
            draw.text((col*512+12, (i-1)*360+8), f'{i} / {suffix}', fill='white')
        rows.append(f'<section><h2>{i}. {label}</h2><div>{"".join(cards)}</div></section>')
    sheet.save(out / 'contact-sheet.jpg', quality=94)
    (out / 'comparison.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>场景提示词对照</title><style>body{margin:28px;background:#151518;color:#eee;font:16px system-ui}h1{font-size:24px}h2{font-size:18px}section{margin:32px 0}section>div{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}figure{margin:0;background:#222228;padding:10px}figcaption{margin-bottom:8px}img{width:100%;height:310px;object-fit:contain}pre{white-space:pre-wrap;line-height:1.6}@media(max-width:800px){section>div{grid-template-columns:1fr}}</style><h1>5 张场景：D / 通用 G</h1><p>本地 FLUX.2 Klein 4B · 4 步 · CFG 1 · 种子 42。点击图片查看原尺寸；模型输入保留完整画面。</p>' + ''.join(rows) + '<h2>通用 G 提示词</h2><pre>' + html.escape(GENERAL) + '</pre><p><a href="metrics.json">完整参数与耗时</a></p></html>')
    signal.alarm(0)
    print('DONE ' + str(out), flush=True)


if __name__ == '__main__':
    main()
