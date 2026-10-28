"""Shared local paths for the terminal launcher, menu helper and service."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE = Path(os.environ.get('PRINT_CHAMBER_STATE', ROOT / '.local')).expanduser().resolve()


def settings():
    config_file = STATE / 'runtime.json'
    config = json.loads(config_file.read_text()) if config_file.exists() else {}
    defaults = {'python': ROOT / '.venv/bin/python',
                'model': Path.home() / 'Models/FLUX.2-klein-4B',
                'samples': Path.home() / 'Downloads'}
    variables = {'python': 'FLUX_PYTHON', 'model': 'FLUX_MODEL_PATH', 'samples': 'FLUX_SAMPLES_DIR'}
    # Keep the venv executable path: resolving its symlink would bypass the venv.
    return {key: Path(os.environ.get(variables[key]) or config.get(key) or default).expanduser().absolute()
            for key, default in defaults.items()}


if __name__ == '__main__':
    config = settings()
    if not config['python'].is_file():
        raise SystemExit('找不到模型运行环境，请按 DEVELOPMENT.md 配置本地 Python。')
    os.execv(str(config['python']), [str(config['python']), str(ROOT / 'service.py')])
