"""Save machine-specific paths outside Git; never install or download a model."""
import argparse
import json
from runtime_config import STATE
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--python', required=True, help='Model environment Python executable')
parser.add_argument('--model', required=True, help='Existing FLUX.2 klein 4B model directory')
args = parser.parse_args()
python, model = Path(args.python).expanduser().absolute(), Path(args.model).expanduser().resolve()
if not python.is_file() or not model.is_dir():
    parser.error('Python executable or model directory does not exist')
STATE.mkdir(exist_ok=True, parents=True, mode=0o700)
target = STATE / 'runtime.json'
config = json.loads(target.read_text()) if target.exists() else {}
config.update(python=str(python), model=str(model))
target.write_text(json.dumps(config, indent=2) + '\n')
target.chmod(0o600)
print('本机路径已保存。菜单栏和终端启动入口共用此配置。')
