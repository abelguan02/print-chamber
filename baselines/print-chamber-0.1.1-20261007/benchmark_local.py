"""Offline FLUX.2 Klein 4B editing benchmark using the existing Mac environment."""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HOME'] = os.path.join(os.path.dirname(__file__), '.cache', 'huggingface')
import argparse
import gc
import json
import time
from pathlib import Path
import torch
from PIL import Image
from diffusers import Flux2KleinPipeline

ROOT = Path(__file__).resolve().parent
PROMPT = ('Convert this illustration into a polished 3D anime game character render. '
          'Preserve the exact face identity, anime proportions, expression, pose, camera, '
          'framing, silhouette, hair, clothing design, accessories, colors and background. '
          'Change only rendering: sculpted dimensional hair, soft volumetric anime skin, '
          'dimensional cloth folds, distinct fabric and metal, soft lighting and contact '
          'shadows. Clearly three-dimensional, like a high-quality game character render. '
          'No redesign, photorealistic human face, flat cel shading, added objects or cropping.')

def sync():
    torch.mps.synchronize()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='/Users/abelguan/Models/FLUX.2-klein-4B')
    parser.add_argument('--image', default='/Users/abelguan/Downloads/kirino-ttk-3.webp')
    parser.add_argument('--sizes', default='288x512,432x768')
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--prompt-file')
    args = parser.parse_args()
    if not torch.backends.mps.is_available():
        raise RuntimeError('Metal GPU unavailable; run outside the restricted sandbox.')
    out = ROOT / 'output' / ('local-' + time.strftime('%Y%m%d-%H%M%S'))
    out.mkdir(parents=True, exist_ok=False)
    prompt = Path(args.prompt_file).read_text(encoding='utf-8') if args.prompt_file else PROMPT
    report = {'model': args.model, 'source': args.image, 'prompt': prompt,
              'device': 'mps', 'dtype': 'bfloat16', 'steps': 4,
              'prompt_cached': True, 'image_cache': False, 'runs': []}
    def save():
        (out / 'metrics.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    start = time.perf_counter()
    print('Loading existing model offline...', flush=True)
    pipe = Flux2KleinPipeline.from_pretrained(args.model, torch_dtype=torch.bfloat16,
                                            local_files_only=True)
    pipe.text_encoder.to('mps')
    print('Encoding fixed style prompt...', flush=True)
    with torch.inference_mode():
        embeds, _ = pipe.encode_prompt(prompt=prompt, device=torch.device('mps'),
                                       max_sequence_length=256)
    sync()
    pipe.text_encoder.to('cpu')
    pipe.text_encoder = None
    gc.collect()
    torch.mps.empty_cache()
    pipe.to('mps')
    sync()
    report['load_and_prompt_seconds'] = time.perf_counter() - start
    save()
    print('READY ' + json.dumps({'setup_seconds': report['load_and_prompt_seconds'],
                                 'output': str(out)}), flush=True)
    for size in args.sizes.split(','):
        w, h = map(int, size.split('x'))
        for repeat in range(args.repeats):
            sync()
            begin = time.perf_counter()
            with Image.open(args.image) as source:
                source = source.convert('RGB')
                source.thumbnail((w, h), Image.Resampling.LANCZOS)
            prepared = time.perf_counter()
            step_times = []
            def callback(pipeline, step, timestep, kwargs):
                sync()
                elapsed = time.perf_counter() - prepared
                step_times.append(elapsed)
                print(f'{size} run {repeat+1} step {step+1}: {elapsed:.2f}s', flush=True)
                return kwargs
            with torch.inference_mode():
                result = pipe(image=source, prompt_embeds=embeds, width=w, height=h,
                              num_inference_steps=4, guidance_scale=1.0,
                              generator=torch.Generator('cpu').manual_seed(42+repeat),
                              callback_on_step_end=callback).images[0]
            sync()
            generated = time.perf_counter()
            filename = f'preview-{size}-{repeat+1}.jpg'
            result.save(out / filename, quality=90)
            end = time.perf_counter()
            run = {'size': [w,h], 'input_size': list(source.size), 'repeat': repeat+1,
                   'seed': 42+repeat, 'first_run_at_resolution': repeat == 0,
                   'prepare_seconds': prepared-begin, 'pipeline_seconds': generated-prepared,
                   'save_seconds': end-generated, 'total_seconds': end-begin,
                   'step_elapsed_seconds': step_times, 'file': filename,
                   'mps_allocated_gb': torch.mps.current_allocated_memory()/1e9,
                   'under_five_seconds': end-begin <= 5}
            report['runs'].append(run)
            save()
            print('RESULT ' + json.dumps(run), flush=True)
    print('REPORT ' + str(out / 'metrics.json'), flush=True)

if __name__ == '__main__':
    main()
