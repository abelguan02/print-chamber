"""Local-only lifecycle control; never stop an unverified port owner."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from runtime_config import STATE, settings
PYTHON = settings()['python']
PORT = 8877

def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=5)
    # lsof uses exit 1 when no process matches, but diagnostic failures are errors.
    no_match = args[0] == '/usr/sbin/lsof' and result.returncode == 1 and not result.stderr and not result.stdout
    if result.returncode and not no_match:
        raise RuntimeError(f'{Path(args[0]).name} process inspection failed (exit {result.returncode})')
    return result.stdout.strip()

def owner():
    pids = command('/usr/sbin/lsof', '-nP', '-tiTCP:8877', '-sTCP:LISTEN').splitlines()
    if not pids:
        return None
    pid = int(pids[0])
    args = command('/bin/ps', '-p', str(pid), '-o', 'command=')
    cwd = command('/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn')
    expected = str(ROOT / 'service.py')
    known = (args.endswith(' ' + expected) or
             (args.endswith(' service.py') and ('n' + str(ROOT)) in cwd.splitlines()))
    return pid, known

def status():
    process = owner()
    if process is None:
        return {'state': 'stopped', 'label': '模型已停止'}
    if not process[1]:
        return {'state': 'conflict', 'label': '端口被其他程序占用'}
    try:
        token = (STATE / 'token').read_text().strip()
        request = urllib.request.Request(f'http://127.0.0.1:{PORT}/health',
                                        headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=2) as response:
            health = json.load(response)
        state = 'failed' if health['failed'] else ('loading' if not health['ready'] else ('busy' if health['busy'] else 'ready'))
        return {'state': state, 'label': {'failed': '模型加载失败', 'loading': '模型准备中…', 'busy': '正在生成图片…', 'ready': '模型已就绪'}[state]}
    except Exception:
        return {'state': 'unreachable', 'label': '服务无响应，请查看日志'}

def start():
    current = status()
    if current['state'] != 'stopped':
        return current
    if not PYTHON.exists() or not (ROOT / 'service.py').exists():
        return {'state': 'error', 'label': '找不到本机模型运行环境'}
    logpath = STATE / 'service.log'
    with logpath.open('ab') as log:
        os.chmod(logpath, 0o600)
        child = subprocess.Popen([str(PYTHON), str(ROOT / 'service.py')], cwd=ROOT,
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 start_new_session=True)
    for _ in range(30):
        if child.poll() is not None:
            return {'state': 'error', 'label': '启动失败，请查看日志'}
        if owner():
            return status()
        time.sleep(.1)
    return {'state': 'loading', 'label': '模型准备中…'}

def stop():
    current = status()
    if current['state'] == 'busy':
        return {**current, 'message': '请等当前图片生成完毕后再停止'}
    process = owner()
    if process is None:
        return status()
    if not process[1]:
        return {'state': 'conflict', 'label': '其他程序占用端口，未停止它'}
    # Recheck identity immediately before signaling.
    if owner() != process:
        return {'state': 'error', 'label': '服务状态变化，请重试'}
    os.kill(process[0], signal.SIGTERM)
    for _ in range(50):
        if owner() is None:
            return status()
        time.sleep(.1)
    return {'state': 'error', 'label': '停止尚未完成，请稍后查看'}

if __name__ == '__main__':
    STATE.mkdir(exist_ok=True, mode=0o700)
    try:
        with (STATE / 'menu-helper.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            action = sys.argv[1] if len(sys.argv) > 1 else 'status'
            print(json.dumps({'status': status, 'start': start, 'stop': stop}[action](), ensure_ascii=False))
    except Exception as exc:
        print('CONTROL_FAILED: ' + type(exc).__name__, file=sys.stderr, flush=True)
        print(json.dumps({'state': 'error', 'code': 'CONTROL_FAILED', 'label': '操作失败，请查看运行日志'}, ensure_ascii=False))
