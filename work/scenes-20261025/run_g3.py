"""User-authorized content-neutral prompt experiment; preserves earlier outputs."""
from run import ROOT, LABELS, torch, Flux2KleinPipeline, sync
from PIL import Image, ImageOps, ImageDraw
import gc
import hashlib
import html
import json
import signal
import time

PREVIOUS = ROOT / 'output/scenes-ab-20261025-060111'
PROMPT = (
    'Re-render this exact image in 3D, keeping the original picture unchanged. '
    'Preserve all original content, shapes, proportions, positions, composition, perspective and framing. '
    'Match the original colors, brightness, lighting and atmosphere. '
    'Only change the rendering quality: give the existing forms solid three-dimensional volume, '
    'convincing material textures, surface depth and subtle contact shadows. '
    'Do not add, remove, redesign, rearrange or crop anything.'
)


def main():
    def timeout(*_):
        raise TimeoutError('300 second experiment limit reached')
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(300)
    out = ROOT / 'output' / ('scenes-g3-' + time.strftime('%Y%m%d-%H%M%S'))
    out.mkdir(parents=True, exist_ok=False)
    protected = [ROOT / 'benchmark_local.py', ROOT / 'service.py', ROOT / 'runtime_config.py']
    protected += sorted(p for p in (ROOT / 'extension').rglob('*') if p.is_file())
    protected += sorted(p for p in (ROOT / '.local').rglob('*') if p.is_file())
    before = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    previous_metrics = json.loads((PREVIOUS / 'metrics.json').read_text())
    report = dict(prompt=PROMPT, variant='G3', steps=4, cfg=1., seed=42, dtype='bfloat16', device='mps',
                  model=previous_metrics['model'], sources=previous_metrics['sources'], runs=[], status='running',
                  previous_comparison=str(PREVIOUS), input_hashes={}, protected_hashes_before=before,
                  user_feedback='D rejected for scene use; G2 preferred for image 1 and 4; G preferred for image 2 and 3; no preference supplied for image 5. G3 must omit concrete scene subjects.',
                  prompt_cache=True, image_cache=False)
    def save():
        (out / 'metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for i in range(1, 6):
        report['input_hashes'][str(i)] = hashlib.sha256((PREVIOUS / f'{i}-input.png').read_bytes()).hexdigest()
    save()
    (out / 'prompt.txt').write_text(PROMPT)
    print('OUTPUT ' + str(out), flush=True)
    start = time.perf_counter()
    pipe = Flux2KleinPipeline.from_pretrained(report['model'], torch_dtype=torch.bfloat16, local_files_only=True)
    pipe.set_progress_bar_config(disable=True)
    pipe.text_encoder.to('mps')
    report['tokens'] = len(pipe.tokenizer.encode(PROMPT))
    if report['tokens'] > 256:
        raise ValueError('Prompt exceeds token limit')
    with torch.inference_mode():
        embeds, _ = pipe.encode_prompt(prompt=PROMPT, device=torch.device('mps'), max_sequence_length=256)
    sync()
    pipe.text_encoder.to('cpu')
    pipe.text_encoder = None
    gc.collect()
    torch.mps.empty_cache()
    pipe.to('mps')
    sync()
    report['load_and_prompt_seconds'] = time.perf_counter()-start
    save()
    for i in range(1, 6):
        with Image.open(PREVIOUS / f'{i}-input.png') as im:
            source = im.convert('RGB')
        sync()
        start = time.perf_counter()
        with torch.inference_mode():
            result = pipe(image=source, prompt_embeds=embeds, width=source.width, height=source.height,
                          num_inference_steps=4, guidance_scale=1., generator=torch.Generator('cpu').manual_seed(42)).images[0]
        sync()
        elapsed = time.perf_counter()-start
        result.save(out / f'{i}-G3.png')
        report['runs'].append(dict(image=i, file=f'{i}-G3.png', size=list(source.size), seconds=elapsed, first_pipeline_call=i == 1))
        save()
        print(f'RESULT {i} G3 {elapsed:.2f}s', flush=True)
    report['protected_files_unchanged'] = before == {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report['status'] = 'complete'
    save()
    rows = []
    sheet = Image.new('RGB', (2048, 1800), '#202024')
    draw = ImageDraw.Draw(sheet)
    for i, label in enumerate(LABELS, 1):
        cards = []
        for col, (suffix, title) in enumerate([('input', '原图输入'), ('G', '通用 G'), ('G2', '通用 G2'), ('G3', '通用 G3 本轮')]):
            path = out / f'{i}-{suffix}.png' if suffix == 'G3' else PREVIOUS / f'{i}-{suffix}.png'
            url = path.name if suffix == 'G3' else f'../{PREVIOUS.name}/{path.name}'
            cards.append(f'<figure><figcaption>{title}</figcaption><a href="{url}"><img src="{url}" alt="{label} {title}"></a></figure>')
            with Image.open(path) as im:
                fitted = ImageOps.contain(im.convert('RGB'), (500, 310))
                sheet.paste(fitted, (col*512+(512-fitted.width)//2, (i-1)*360+32+(310-fitted.height)//2))
            draw.text((col*512+12, (i-1)*360+8), f'{i} / {suffix}', fill='white')
        rows.append(f'<section><h2>{i}. {label}</h2><div>{"".join(cards)}</div></section>')
    sheet.save(out / 'contact-sheet.jpg', quality=94)
    (out / 'comparison.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>场景通用提示词 G3 对照</title><style>body{margin:24px;background:#151518;color:#eee;font:16px system-ui}h1{font-size:24px}h2{font-size:18px}section{margin:30px 0}section>div{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}figure{margin:0;background:#222228;padding:8px}figcaption{margin-bottom:8px}img{width:100%;height:290px;object-fit:contain}pre{white-space:pre-wrap;line-height:1.6}@media(max-width:900px){section>div{grid-template-columns:1fr 1fr}}</style><h1>原图 / G / G2 / G3</h1><p>本地 FLUX.2 Klein 4B · 4 步 · CFG 1 · 种子 42。G、G2 为此前结果；G3 使用完全相同输入。点击查看单图。</p>' + ''.join(rows) + '<h2>G3 提示词</h2><pre>' + html.escape(PROMPT) + '</pre><p><a href="metrics.json">参数与耗时</a></p></html>')
    signal.alarm(0)
    print('DONE ' + str(out), flush=True)


if __name__ == '__main__':
    main()
