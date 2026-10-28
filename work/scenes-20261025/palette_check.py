"""One authorized palette-preservation check; G3 remains unchanged."""
from run import ROOT, torch, Flux2KleinPipeline, sync
from PIL import Image, ImageOps, ImageDraw
import gc
import hashlib
import html
import json
import signal
import time

ADDITIONAL = ROOT / 'output/additional-g3-20261025-082632'
PORTRAITS = ROOT / 'output/portraits-d-g3-20261025-061325'
SAMPLES = [(ADDITIONAL, 2, '秋色森林'), (ADDITIONAL, 1, '机械件'),
           (ADDITIONAL, 3, '四盆植物'), (PORTRAITS, 7, '旧人物：深肤色角色')]
ADDITION = (
    'The original palette is intentional art direction, including unusual and highly saturated colors. '
    'Preserve each region\'s original hue, saturation and relative brightness exactly. '
    'Do not replace stylized colors with conventional natural colors, neutralize them, or rebalance the image. '
)


def main():
    def timeout(*_):
        raise TimeoutError('300 second experiment limit reached')
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(300)
    g3_path = ROOT / 'output/scenes-g3-20261025-060950/prompt.txt'
    g3 = g3_path.read_text()
    anchor = 'Match the original colors, brightness, lighting and atmosphere. '
    if g3.count(anchor) != 1:
        raise ValueError('Expected G3 color sentence missing or ambiguous')
    prompt = g3.replace(anchor, anchor + ADDITION)
    out = ROOT / 'output' / ('palette-g4-' + time.strftime('%Y%m%d-%H%M%S'))
    out.mkdir(parents=True, exist_ok=False)
    protected = [ROOT / 'benchmark_local.py', ROOT / 'service.py', ROOT / 'runtime_config.py', g3_path]
    protected += sorted(p for folder in ['extension', '.local'] for p in (ROOT / folder).rglob('*') if p.is_file())
    before = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report = dict(prompts={'G3': g3, 'G4': prompt}, added_constraint=ADDITION, steps=4, cfg=1., seed=42,
                  model='/Users/abelguan/Models/FLUX.2-klein-4B', device='mps', dtype='bfloat16',
                  prompt_cache=True, image_cache=False, sources=[], runs=[], status='running',
                  protected_hashes_before=before, scope='One prompt revision, four images, no further iterations')
    def save():
        (out / 'metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for i, (folder, old_i, label) in enumerate(SAMPLES, 1):
        old = json.loads((folder / 'metrics.json').read_text())
        timing = next(x for x in old['runs'] if x['image'] == old_i and x.get('variant','G3') == 'G3')
        for suffix in ['input', 'G3']:
            (out / f'{i}-{suffix}.png').write_bytes((folder / f'{old_i}-{suffix}.png').read_bytes())
        report['sources'].append(dict(image=i, label=label, input_source=str(folder / f'{old_i}-input.png'),
                                      input_sha256=hashlib.sha256((out / f'{i}-input.png').read_bytes()).hexdigest(),
                                      g3_source=str(folder / f'{old_i}-G3.png'), g3_seconds=timing['seconds'], size=timing['size']))
    (out / 'prompt-g4.txt').write_text(prompt)
    save()
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
    for i in range(1, 5):
        with Image.open(out / f'{i}-input.png') as im:
            source = im.convert('RGB')
        sync()
        begin = time.perf_counter()
        with torch.inference_mode():
            result = pipe(image=source, prompt_embeds=embeds, width=source.width, height=source.height,
                          num_inference_steps=4, guidance_scale=1., generator=torch.Generator('cpu').manual_seed(42)).images[0]
        sync()
        elapsed = time.perf_counter()-begin
        result.save(out / f'{i}-G4.png')
        report['runs'].append(dict(image=i, file=f'{i}-G4.png', seconds=elapsed, size=list(source.size), first_pipeline_call=i == 1))
        save()
        print(f'RESULT {i} G4 {elapsed:.2f}s', flush=True)
    report['protected_files_unchanged'] = before == {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report['status'] = 'complete'
    save()
    rows = []
    for start in [1, 3]:
        sheet = Image.new('RGB', (1536, 960), '#202024')
        draw = ImageDraw.Draw(sheet)
        for i in range(start, start+2):
            cards = []
            for col, (key, title) in enumerate([('input','原图输入'), ('G3','G3 已保留'), ('G4','G4 配色约束试验')]):
                filename = f'{i}-{key}.png'
                cards.append(f'<figure><figcaption>{title}</figcaption><a href="{filename}"><img src="{filename}" alt="{SAMPLES[i-1][2]} {title}"></a></figure>')
                with Image.open(out / filename) as im:
                    fitted = ImageOps.contain(im.convert('RGB'), (500, 430))
                    sheet.paste(fitted, (col*512+(512-fitted.width)//2, (i-start)*480+32+(430-fitted.height)//2))
                draw.text((col*512+12, (i-start)*480+8), f'{i} / {key}', fill='white')
            rows.append(f'<section><h2>{i}. {SAMPLES[i-1][2]}</h2><div>{"".join(cards)}</div></section>')
        sheet.save(out / f'contact-sheet-{start}-{start+1}.jpg', quality=94)
    (out / 'comparison.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>G3 / G4 配色小范围验证</title><style>body{margin:24px;background:#151518;color:#eee;font:16px system-ui}main{max-width:1600px;margin:auto}h1{font-size:25px}h2{font-size:19px}section{margin:35px 0}section>div{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}figure{margin:0;background:#242429;padding:10px}figcaption{margin-bottom:8px}img{width:100%;height:430px;object-fit:contain}pre{white-space:pre-wrap;line-height:1.6}a{color:#d8dcff}@media(max-width:800px){section>div{grid-template-columns:1fr}}</style><main><h1>原图 / G3 / G4 配色约束</h1><p>仅一次修订、四张图。同输入尺寸 · 4 步 · CFG 1 · 种子 42。G3 复用已保存结果；G4 是本轮实验候选，未替换默认。点击查看单图。</p>'+''.join(rows)+'<h2>G4 新增的唯一约束</h2><pre>'+html.escape(ADDITION)+'</pre><h2>完整 G4</h2><pre>'+html.escape(prompt)+'</pre><p><a href="metrics.json">完整参数、来源与耗时</a></p></main></html>')
    signal.alarm(0)
    print('DONE ' + str(out), flush=True)


if __name__ == '__main__':
    main()
