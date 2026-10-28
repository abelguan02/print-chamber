"""Compare the retained G3 candidate with current D on all eight prior portraits."""
from run import ROOT, PROMPT as D, torch, Flux2KleinPipeline, sync
from PIL import Image, ImageOps, ImageDraw
from pathlib import Path
import gc
import hashlib
import html
import json
import signal
import time


def main():
    def timeout(*_):
        raise TimeoutError('300 second experiment limit reached')
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(300)
    history = ROOT / 'output/eight-ab-20261007-174824/metrics.json'
    old = json.loads(history.read_text())
    samples = [r for r in old['runs'] if r['variant'] == 'A']
    g3_path = ROOT / 'output/scenes-g3-20261025-060950/prompt.txt'
    g3 = g3_path.read_text()
    out = ROOT / 'output' / ('portraits-d-g3-' + time.strftime('%Y%m%d-%H%M%S'))
    out.mkdir(parents=True, exist_ok=False)
    protected = [ROOT / 'benchmark_local.py', ROOT / 'service.py', ROOT / 'runtime_config.py', g3_path]
    protected += sorted(p for folder in ['extension', '.local'] for p in (ROOT / folder).rglob('*') if p.is_file())
    before = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report = dict(model='/Users/abelguan/Models/FLUX.2-klein-4B', historical_source=str(history),
                  prompts={'D': D, 'G3': g3}, g3_source=str(g3_path), steps=4, cfg=1., seed=42,
                  device='mps', dtype='bfloat16', prompt_cache=True, image_cache=False,
                  sources=[], runs=[], protected_hashes_before=before, status='running',
                  input_policy='Original files EXIF-transposed and RGB-converted, full-frame resized to historical recorded dimensions. D and G3 share identical PNG inputs. Fresh outputs for both prompts.')
    def save():
        (out / 'metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for sample in samples:
        i = sample['image']
        path = Path('/Users/abelguan/Downloads') / sample['source']
        with Image.open(path) as im:
            source = ImageOps.exif_transpose(im).convert('RGB')
        original_size = list(source.size)
        source.save(out / f'{i}-original.jpg', quality=95)
        source.resize(sample['size'], Image.Resampling.LANCZOS).save(out / f'{i}-input.png')
        report['sources'].append(dict(image=i, path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                                      historical_reference=f'../eight-ab-20261007-174824/{i}-original.jpg',
                                      original_size=original_size, size=sample['size']))
    save()
    print('OUTPUT ' + str(out), flush=True)
    begin = time.perf_counter()
    pipe = Flux2KleinPipeline.from_pretrained(report['model'], torch_dtype=torch.bfloat16, local_files_only=True)
    pipe.set_progress_bar_config(disable=True)
    pipe.text_encoder.to('mps')
    embeds = {}
    for key, prompt in report['prompts'].items():
        tokens = len(pipe.tokenizer.encode(prompt))
        if tokens > 256:
            raise ValueError(f'{key} exceeds token limit')
        with torch.inference_mode():
            embeds[key], _ = pipe.encode_prompt(prompt=prompt, device=torch.device('mps'), max_sequence_length=256)
        report.setdefault('tokens', {})[key] = tokens
    sync()
    pipe.text_encoder.to('cpu')
    pipe.text_encoder = None
    gc.collect()
    torch.mps.empty_cache()
    pipe.to('mps')
    sync()
    report['load_and_prompts_seconds'] = time.perf_counter()-begin
    save()
    for sample in samples:
        i = sample['image']
        with Image.open(out / f'{i}-input.png') as im:
            source = im.convert('RGB')
        for key in ['D', 'G3']:
            sync()
            begin = time.perf_counter()
            with torch.inference_mode():
                result = pipe(image=source, prompt_embeds=embeds[key], width=source.width, height=source.height,
                              num_inference_steps=4, guidance_scale=1., generator=torch.Generator('cpu').manual_seed(42)).images[0]
            sync()
            elapsed = time.perf_counter()-begin
            result.save(out / f'{i}-{key}.png')
            report['runs'].append(dict(image=i, variant=key, file=f'{i}-{key}.png', size=list(source.size),
                                       seconds=elapsed, first_pipeline_call=len(report['runs']) == 0))
            save()
            print(f'RESULT {i} {key} {elapsed:.2f}s', flush=True)
    report['protected_files_unchanged'] = before == {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report['status'] = 'complete'
    save()
    rows = []
    for start in [1, 5]:
        sheet = Image.new('RGB', (1200, 1680), '#202024')
        draw = ImageDraw.Draw(sheet)
        for i in range(start, start+4):
            cards = []
            for col, (key, label) in enumerate([('input', '原图输入'), ('D', '当前 D'), ('G3', '通用 G3')]):
                filename = f'{i}-{key}.png'
                cards.append(f'<figure><figcaption>{label}</figcaption><a href="{filename}"><img src="{filename}" alt="人物 {i} {label}"></a></figure>')
                with Image.open(out / filename) as im:
                    fitted = ImageOps.contain(im.convert('RGB'), (390, 380))
                    sheet.paste(fitted, (col*400+(400-fitted.width)//2, (i-start)*420+30+(380-fitted.height)//2))
                draw.text((col*400+10, (i-start)*420+8), f'{i} / {key}', fill='white')
            name = html.escape(samples[i-1]['source'])
            rows.append(f'<section><h2>{i}. {name}</h2><div>{"".join(cards)}</div></section>')
        sheet.save(out / f'contact-sheet-{start}-{start+3}.jpg', quality=94)
    (out / 'comparison.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>人物 D / G3 对照</title><style>body{margin:24px;background:#151518;color:#eee;font:16px system-ui}h1{font-size:24px}h2{font-size:17px;overflow-wrap:anywhere}section{margin:30px 0}section>div{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0;background:#222228;padding:8px}figcaption{margin-bottom:8px}img{width:100%;height:470px;object-fit:contain}pre{white-space:pre-wrap;line-height:1.6}@media(max-width:750px){section>div{grid-template-columns:1fr}}</style><h1>8 张旧人物：原图 / 当前 D / 通用 G3</h1><p>两版均为本轮新生成。相同输入与历史尺寸 · 4 步 · CFG 1 · 种子 42。点击查看单图。未修改插件或默认提示词。</p>'+''.join(rows)+'<h2>G3 提示词</h2><pre>'+html.escape(g3)+'</pre><h2>当前 D 提示词</h2><pre>'+html.escape(D)+'</pre><p><a href="metrics.json">来源、参数与耗时</a></p></html>')
    signal.alarm(0)
    print('DONE ' + str(out), flush=True)


if __name__ == '__main__':
    main()
