"""One bounded revision after observed scene and lighting hallucinations."""
from run import ROOT, FILES, LABELS, torch, Flux2KleinPipeline, sync
from PIL import Image, ImageOps, ImageDraw
import gc
import html
import json
import signal
import time

OUT = ROOT / 'output/scenes-ab-20261025-060111'
PROMPT = (
    'Convert only the surface rendering of this exact image to three-dimensional CGI. '
    'Faithfully reproduce the source image rather than reinterpret it. '
    'Keep the identical content, composition, perspective, shapes, proportions, object positions and framing. '
    'Preserve the exact original palette, exposure, dark areas, light sources, light colors and atmosphere. '
    'Keep lava as lava, underwater scenes underwater, and blank backgrounds blank. '
    'Keep existing text and separate design drawings in place. '
    'Give the existing forms solid volume, material definition and subtle contact shading. '
    'Do not introduce daylight, vegetation, water, faces or any other elements absent from the source. '
    'Do not replace, remove, redesign, rearrange or crop anything.'
)


def main():
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('300 second revision limit reached')))
    signal.alarm(300)
    report = dict(prompt=PROMPT, reason='G added water and daylight, removed lava atmosphere; constrain semantic content and lighting',
                  steps=4, cfg=1, seed=42, runs=[], status='running')
    def save():
        (OUT / 'revision-metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    save()
    begin = time.perf_counter()
    pipe = Flux2KleinPipeline.from_pretrained('/Users/abelguan/Models/FLUX.2-klein-4B', torch_dtype=torch.bfloat16, local_files_only=True)
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
    report['load_and_prompt_seconds'] = time.perf_counter()-begin
    for i in range(1, 6):
        with Image.open(OUT / f'{i}-input.png') as im:
            source = im.convert('RGB')
        sync()
        begin = time.perf_counter()
        with torch.inference_mode():
            result = pipe(image=source, prompt_embeds=embeds, width=source.width, height=source.height,
                          num_inference_steps=4, guidance_scale=1., generator=torch.Generator('cpu').manual_seed(42)).images[0]
        sync()
        elapsed = time.perf_counter()-begin
        result.save(OUT / f'{i}-G2.png')
        report['runs'].append(dict(image=i, file=f'{i}-G2.png', seconds=elapsed, size=list(source.size)))
        save()
        print(f'RESULT {i} G2 {elapsed:.2f}s', flush=True)
    report['status'] = 'complete'
    save()
    rows = []
    sheet = Image.new('RGB', (2048, 1800), '#202024')
    draw = ImageDraw.Draw(sheet)
    for i, label in enumerate(LABELS, 1):
        cards = []
        for col, (suffix, title) in enumerate([('input', '模型输入'), ('D', '当前 D'), ('G', '通用 G 首轮'), ('G2', '通用 G2 修订')]):
            filename = f'{i}-{suffix}.png'
            cards.append(f'<figure><figcaption>{title}</figcaption><a href="{filename}"><img src="{filename}" alt="{label} {title}"></a></figure>')
            with Image.open(OUT / filename) as im:
                fitted = ImageOps.contain(im.convert('RGB'), (500, 310))
                sheet.paste(fitted, (col*512+(512-fitted.width)//2, (i-1)*360+32+(310-fitted.height)//2))
            draw.text((col*512+12, (i-1)*360+8), f'{i} / {suffix}', fill='white')
        rows.append(f'<section><h2>{i}. {label}</h2><div>{"".join(cards)}</div></section>')
    sheet.save(OUT / 'contact-sheet-revised.jpg', quality=94)
    (OUT / 'comparison-revised.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>场景提示词对照与一次修订</title><style>body{margin:24px;background:#151518;color:#eee;font:16px system-ui}h1{font-size:24px}h2{font-size:18px}section{margin:30px 0}section>div{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}figure{margin:0;background:#222228;padding:8px}figcaption{margin-bottom:8px}img{width:100%;height:290px;object-fit:contain}pre{white-space:pre-wrap;line-height:1.6}@media(max-width:900px){section>div{grid-template-columns:1fr 1fr}}</style><h1>5 张场景：原图 / D / G / G2</h1><p>本地 FLUX.2 Klein 4B · 4 步 · CFG 1 · 种子 42。点击图片查看原尺寸。只做一次修订，未更改活动默认提示词。</p>' + ''.join(rows) + '<h2>G2 提示词</h2><pre>' + html.escape(PROMPT) + '</pre><p><a href="metrics.json">首轮参数与耗时</a> · <a href="revision-metrics.json">修订参数与耗时</a></p></html>')
    signal.alarm(0)
    print('DONE', flush=True)


if __name__ == '__main__':
    main()
