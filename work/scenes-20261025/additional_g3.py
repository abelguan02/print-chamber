"""Seven user-provided images, offline G3 only. No active implementation changes."""
from run import ROOT, torch, Flux2KleinPipeline, sync
from PIL import Image, ImageOps, ImageDraw
from pathlib import Path
import gc
import hashlib
import html
import json
import signal
import time

SAMPLES = [
    ('himesh-anand-doodle-060.jpg', '硬表面机械设计'),
    ('ellen-maincamera.jpg', '秋色森林'),
    ('natalia-otero-roman-renders-ps.jpg', '四盆植物'),
    ('theo-di-malta-42-crew-shipa-a-flare-v2-1080p.webp', '太空飞船'),
    ('andrian-luchian-andrianluchiansufix04.jpg', '双视图飞船线稿'),
    ('baitong-li-01-finalshot.jpg', '山谷场景'),
    ('maung-thuta-space2.jpg', '三机甲设计板'),
]


def main():
    def timeout(*_):
        raise TimeoutError('300 second experiment limit reached')
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(300)
    prompt_path = ROOT / 'output/scenes-g3-20261025-060950/prompt.txt'
    prompt = prompt_path.read_text()
    out = ROOT / 'output' / ('additional-g3-' + time.strftime('%Y%m%d-%H%M%S'))
    out.mkdir(parents=True, exist_ok=False)
    protected = [ROOT / 'benchmark_local.py', ROOT / 'service.py', ROOT / 'runtime_config.py', prompt_path]
    protected += sorted(p for folder in ['extension', '.local'] for p in (ROOT / folder).rglob('*') if p.is_file())
    before = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report = dict(prompt=prompt, prompt_source=str(prompt_path), model='/Users/abelguan/Models/FLUX.2-klein-4B',
                  variant='G3', steps=4, cfg=1., seed=42, device='mps', dtype='bfloat16',
                  prompt_cache=True, image_cache=False, sources=[], runs=[], status='running',
                  duplicate_attachment='baitong-li-01-finalshot.jpg appeared twice; generated once',
                  resolution_policy='Full frame resized; long edge <=768, target area <=330000 before rounding dimensions to multiples of 16',
                  protected_hashes_before=before)
    def save():
        (out / 'metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for i, (name, label) in enumerate(SAMPLES, 1):
        path = Path('/Users/abelguan/Downloads') / name
        with Image.open(path) as im:
            source = ImageOps.exif_transpose(im).convert('RGB')
        w, h = source.size
        scale = min(1, 768/max(w, h), (330000/(w*h))**.5)
        size = [max(64, round(w*scale/16)*16), max(64, round(h*scale/16)*16)]
        source.save(out / f'{i}-original.jpg', quality=95)
        source.resize(size, Image.Resampling.LANCZOS).save(out / f'{i}-input.png')
        report['sources'].append(dict(image=i, label=label, path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                                      original_size=[w,h], size=size))
    save()
    (out / 'prompt.txt').write_text(prompt)
    print('OUTPUT ' + str(out), flush=True)
    begin = time.perf_counter()
    pipe = Flux2KleinPipeline.from_pretrained(report['model'], torch_dtype=torch.bfloat16, local_files_only=True)
    pipe.set_progress_bar_config(disable=True)
    pipe.text_encoder.to('mps')
    report['tokens'] = len(pipe.tokenizer.encode(prompt))
    if report['tokens'] > 256:
        raise ValueError('Prompt exceeds token limit')
    with torch.inference_mode():
        embeds, _ = pipe.encode_prompt(prompt=prompt, device=torch.device('mps'), max_sequence_length=256)
    sync()
    pipe.text_encoder.to('cpu')
    pipe.text_encoder = None
    gc.collect()
    torch.mps.empty_cache()
    pipe.to('mps')
    sync()
    report['load_and_prompt_seconds'] = time.perf_counter()-begin
    save()
    for i in range(1, len(SAMPLES)+1):
        begin = time.perf_counter()
        with Image.open(out / f'{i}-input.png') as im:
            source = im.convert('RGB')
        sync()
        prepared = time.perf_counter()
        with torch.inference_mode():
            result = pipe(image=source, prompt_embeds=embeds, width=source.width, height=source.height,
                          num_inference_steps=4, guidance_scale=1., generator=torch.Generator('cpu').manual_seed(42)).images[0]
        sync()
        generated = time.perf_counter()
        result.save(out / f'{i}-G3.png')
        report['runs'].append(dict(image=i, file=f'{i}-G3.png', size=list(source.size), seconds=generated-prepared,
                                   file_io_and_pipeline_seconds=time.perf_counter()-begin, first_pipeline_call=i == 1))
        save()
        print(f'RESULT {i} G3 {generated-prepared:.2f}s', flush=True)
    report['protected_files_unchanged'] = before == {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report['status'] = 'complete'
    save()
    rows = []
    for start, end in [(1,4),(5,7)]:
        sheet = Image.new('RGB', (1280, 420*(end-start+1)), '#202024')
        draw = ImageDraw.Draw(sheet)
        for i in range(start, end+1):
            cards = []
            for col, (key, title) in enumerate([('input', '原图输入'), ('G3', '本地 G3')]):
                filename = f'{i}-{key}.png'
                cards.append(f'<figure><figcaption>{title}</figcaption><a href="{filename}"><img src="{filename}" alt="{i} {SAMPLES[i-1][1]} {title}"></a></figure>')
                with Image.open(out / filename) as im:
                    fitted = ImageOps.contain(im.convert('RGB'), (620, 380))
                    sheet.paste(fitted, (col*640+(640-fitted.width)//2, (i-start)*420+30+(380-fitted.height)//2))
                draw.text((col*640+10, (i-start)*420+8), f'{i} / {key}', fill='white')
            rows.append(f'<section><h2>{i}. {SAMPLES[i-1][1]}</h2><p>{html.escape(SAMPLES[i-1][0])} · {report["runs"][i-1]["seconds"]:.2f} 秒</p><div>{"".join(cards)}</div></section>')
        sheet.save(out / f'contact-sheet-{start}-{end}.jpg', quality=94)
    (out / 'comparison.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>新增七图 · 本地 G3</title><style>body{margin:24px;background:#151518;color:#eee;font:16px system-ui}main{max-width:1500px;margin:auto}h1{font-size:25px}h2{font-size:19px}section{margin:35px 0}section>div{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0;background:#242429;padding:10px}figcaption{margin-bottom:8px}img{width:100%;height:470px;object-fit:contain}pre{white-space:pre-wrap;line-height:1.6}p{overflow-wrap:anywhere;color:#ccc}a{color:#d8dcff}@media(max-width:750px){section>div{grid-template-columns:1fr}}</style><main><h1>新增七图：原图 / 本地 G3</h1><p>本地 FLUX.2 Klein 4B · 4 步 · CFG 1 · 种子 42。七张不同图片各一次，重复附件不重复生成。点击图片看原尺寸。无付费云端调用，未修改插件、配置或默认提示词。</p>'+''.join(rows)+'<h2>原文 G3</h2><pre>'+html.escape(prompt)+'</pre><p>时间为单张模型推理，不含启动，不等于悬停到显示的耗时。<a href="metrics.json">完整参数与耗时</a></p></main></html>')
    signal.alarm(0)
    print('DONE ' + str(out), flush=True)


if __name__ == '__main__':
    main()
