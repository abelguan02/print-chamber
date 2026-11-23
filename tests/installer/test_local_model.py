"""HTTP-only installer contract. Neither the real uv nor a real model environment is installed."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
REV = 'e7b7dc27f91deacad38e78976d1f2b499d76a294'
FILES = {name: (name.encode() * 9) for name in
         ['LICENSE.md', 'model_index.json', 'scheduler/cfg', 'text_encoder/cfg', 'tokenizer/cfg', 'vae/cfg']}
FILES['transformer/weights'] = b'fake' * (4 * 1024 * 1024)

def hub_metadata():
    entries = []
    for name, data in FILES.items():
        entry = {'rfilename': name, 'size': len(data)}
        if name == 'transformer/weights':
            entry['lfs'] = {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'pointerSize': 132}
        else:
            entry['blobId'] = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        entries.append(entry)
    return entries


# Only the Hub HTTP transport and metadata object are substituted. The production
# Python worker selects files, checks ranges, streams, checkpoints and publishes.
HUB = """
import json
from types import SimpleNamespace
from urllib.request import urlopen
def hf_hub_url(repo, filename, revision):
    assert repo == 'black-forest-labs/FLUX.2-klein-4B'
    return BASE + '/' + revision + '/' + filename
class HfApi:
    def model_info(self, repo, revision, files_metadata, token):
        assert files_metadata and token is False
        with urlopen(BASE + '/metadata') as r: result = json.load(r)
        siblings = [SimpleNamespace(rfilename=x['rfilename'], size=x['size'], blob_id=x.get('blobId'),
                                   lfs=SimpleNamespace(**x['lfs']) if 'lfs' in x else None)
                    for x in result['siblings']]
        return SimpleNamespace(sha=result['sha'], siblings=siblings)
"""
TRANSPORT = """
from contextlib import contextmanager
from urllib.request import Request, urlopen
class Client:
    @contextmanager
    def stream(self, method, url, headers, follow_redirects, timeout):
        with urlopen(Request(url, headers=headers),timeout=timeout) as r:
            r.status_code=r.status
            r.raise_for_status=lambda:None
            r.iter_bytes=lambda chunk_size: iter(lambda:r.read(chunk_size), b'')
            yield r
def get_session(): return Client()
"""


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(tmp.cleanup)
        folder = Path(tmp.name)
        app = folder / 'Fixture.app/Contents'
        cls.resources = app / 'Resources'
        cls.binary = app / 'MacOS/Runner'
        cls.resources.mkdir(parents=True)
        cls.binary.parent.mkdir()
        (app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable': 'Runner', 'PrintChamberMode': 'app',
                                                        'CFBundleIdentifier': 'local.printchamber.installtest'}))
        (cls.resources / 'extension').mkdir()
        (cls.resources / 'requirements-macos-arm64.txt').write_text('fixture==1')
        shutil.copytree(ROOT / 'installer', cls.resources / 'installer')
        source = (ROOT / 'menu-helper/main.swift').read_text().split('// Exercise the packaged startup paths')[0]
        main = folder / 'main.swift'
        main.write_text(source + Path(__file__).with_name('scenario.swift').read_text())
        subprocess.run(['xcrun','swiftc','-swift-version','5','-module-cache-path',str(folder / 'modules'),
                        str(main),str(ROOT / 'menu-helper/ModelInstaller.swift'),'-o',str(cls.binary)],check=True)

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name).resolve()
        self.state = self.home / 'data'
        self.state.mkdir()
        self.config = self.state / 'runtime.json'
        self.config.write_text(json.dumps({'samples':'keep'}))
        self.calls = []
        self.fail = False
        self.corrupt = None
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                resource = self.path
                offset = int(self.headers.get('Range', 'bytes=0-')[6:-1])
                owner.calls.append((resource,offset))
                if resource == '/uv': data = owner.archive
                elif resource in ['/python','/deps']: data = b'fixture'
                elif resource == '/metadata':
                    data = json.dumps({'sha':REV,'siblings':hub_metadata()
                                        + [{'rfilename':'duplicate.safetensors','size':999}]}).encode()
                elif resource.startswith('/'+REV+'/'):
                    name = resource[len(REV)+2:]
                    data = FILES[name]
                    if name == owner.corrupt:
                        data = data[:-1] + bytes([data[-1] ^ 1])
                else: self.send_error(404); return
                if owner.fail and resource.endswith('/weights'):
                    self.send_error(503); return
                self.send_response(206 if offset else 200)
                self.send_header('Content-Length',str(len(data)-offset))
                if offset: self.send_header('Content-Range',f'bytes {offset}-{len(data)-1}/{len(data)}')
                self.end_headers()
                try:
                    for i in range(offset,len(data),65536):
                        self.wfile.write(data[i:i+65536])
                        if resource.endswith('/weights'): time.sleep(0.008)
                except (BrokenPipeError,ConnectionResetError): pass
            def log_message(self,*args): pass
        server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        base = f'http://127.0.0.1:{server.server_port}'
        self.base = base
        hub = self.home / 'modules/huggingface_hub'
        hub.mkdir(parents=True)
        (hub/'__init__.py').write_text('BASE='+repr(base)+'\n'+HUB)
        (hub/'utils.py').write_text(TRANSPORT)
        runner = self.home / 'fake-python'
        runner.write_text('#!'+sys.executable+'\n'+
            'import json, os, sys\nfrom pathlib import Path\n'+
            'if sys.argv[1].endswith("controller.py"):\n'
            ' state=Path(os.environ["PRINT_CHAMBER_STATE"])\n'
            ' with (state/"calls").open("a") as f: print(sys.argv[2],file=f)\n'
            ' print(json.dumps({"state":"busy" if (state/"busy").exists() else "stopped","label":"fixture"}))\n'
            'else:\n os.environ["PYTHONPATH"]='+repr(str(hub.parent))+'\n os.execv(sys.executable,[sys.executable]+sys.argv[1:])\n')
        runner.chmod(0o700)
        self.runner = runner
        uv = ('#!'+sys.executable+'\nimport sys,shutil,os\nfrom pathlib import Path\nfrom urllib.request import urlopen\n'
              'args=sys.argv[1:]\n'
              'if args==["python","install","3.12.14"]: urlopen('+repr(base+'/python')+').read()\n'
              'elif args[:3]==["venv","--python","3.12.14"]:\n'
              ' p=Path(args[-1])/"bin/python";p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2('+repr(str(runner))+',p)\n'
              'elif args[:3]==["pip","install","--python"] and Path(args[3]).is_file() and Path(args[5]).read_text()=="fixture==1" and args[6:]==["--only-binary",":all:"]: urlopen('+repr(base+'/deps')+').read()\n'
              'else: sys.exit(3)\n').encode()
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w:gz') as tar:
            member=tarfile.TarInfo('uv-aarch64-apple-darwin/uv');member.size=len(uv)
            tar.addfile(member,io.BytesIO(uv))
        self.archive=buffer.getvalue()

    def scenario(self,name,capacity=None):
        env={'HOME':str(self.home),'PATH':'/usr/bin:/bin','PRINT_CHAMBER_STATE':str(self.state),
             'FIXTURE_CAPACITY':str(capacity if capacity is not None else (19_999_999_999 if name=='space' else 30_000_000_000)),
             'FIXTURE_PYTHON':str(self.runner), 'FIXTURE_URL':self.base+'/uv','FIXTURE_HASH':'0'*64 if name=='bad' else hashlib.sha256(self.archive).hexdigest()}
        result=subprocess.run([self.binary,name],env=env,capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr+result.stdout)
        return result.stdout

    def test_status_timer_discovers_changes_after_starting_uninstalled(self):
        self.scenario('timer')
        self.assertEqual(self.calls, [])

    def test_checksum_and_space_stop_before_uv_runs(self):
        self.scenario('space')
        self.assertEqual(self.calls,[])
        self.assertIn('校验失败',self.scenario('bad'))
        self.assertEqual(self.calls,[('/uv',0)])
        self.assertFalse((self.state/'python').exists())

    def test_resume_checks_remaining_bytes_and_reserve(self):
        self.assertIn('已暂停', self.scenario('pause', capacity=26_000_000_000))
        # Model byte counts are simulated; the retained HTTP fixture stays small.
        progress = self.state / 'model-installer/progress.json'
        progress.write_text(json.dumps({'total': 16_000_000_000, 'downloaded': 10_000_000_000}))
        calls = self.calls.copy()
        self.scenario('resume-short', capacity=7_999_999_999)
        self.assertEqual(self.calls, calls)
        self.scenario('resume', capacity=16_000_000_000)
        self.assertTrue(Path(json.loads(self.config.read_text())['model']).is_dir())

    def test_completed_uv_archive_survives_interruption_before_checkpoint(self):
        work = self.state / 'model-installer'
        work.mkdir()
        (work / 'pending').touch()
        (work / 'uv.tar.gz').write_bytes(self.archive)
        self.scenario('resume')
        self.assertNotIn('/uv', [url for url, _ in self.calls])
        self.assertEqual(self.calls.count(('/deps', 0)), 1)

    def test_network_failure_then_resume_and_publish(self):
        self.fail=True
        self.assertIn('可继续',self.scenario('network'))
        self.assertEqual(json.loads(self.config.read_text()),{'samples':'keep'})
        self.fail=False
        self.scenario('resume')
        config=json.loads(self.config.read_text())
        self.assertEqual(Path(config['model'],'LICENSE.md').read_bytes(),FILES['LICENSE.md'])
        self.assertTrue(Path(config['python']).is_file())
        for file in ['/uv','/python','/deps','/'+REV+'/LICENSE.md']: self.assertEqual(self.calls.count((file,0)),1)

    def test_close_keeps_downloading_and_reopen_shows_current_progress(self):
        self.scenario('close')
        self.assertEqual([n for path, n in self.calls if path.endswith('/weights')], [0])
        self.assertIn('model', json.loads(self.config.read_text()))

    def test_pause_and_quit_resume_partial_file_after_relaunch(self):
        for action in ['pause','quit']:
            self.assertIn('已暂停',self.scenario(action))
            self.assertTrue((self.state/'model-installer/pending').exists())
        self.scenario('resume')
        offsets=[n for p,n in self.calls if p.endswith('/weights')]
        self.assertEqual(len(offsets),3)
        self.assertEqual(offsets[0],0)
        self.assertGreater(offsets[1],0)
        self.assertTrue(all(b > a for a,b in zip(offsets, offsets[1:])))
        self.assertEqual((self.state/'models/FLUX.2-klein-4B/transformer/weights').read_bytes(),FILES['transformer/weights'])

    def test_same_size_bad_weight_removed_then_only_that_file_retried(self):
        name = 'transformer/weights'
        self.corrupt = name
        self.assertIn('校验失败 · 可继续', self.scenario('checksum'))
        snapshot = self.state / 'model-installer/snapshot'
        self.assertFalse((snapshot / name).exists())
        self.assertFalse((snapshot / (name + '.partial')).exists())
        self.assertTrue((snapshot / 'model_index.json').is_file())
        progress = json.loads((snapshot.parent / 'progress.json').read_text())
        self.assertEqual(progress['downloaded'], progress['total'] - len(FILES[name]))
        self.assertEqual(json.loads(self.config.read_text()), {'samples': 'keep'})

        self.corrupt = None
        self.calls.clear()
        self.scenario('resume')
        self.assertEqual(self.calls, [('/metadata', 0), (f'/{REV}/{name}', 0)])
        self.assertEqual((self.state / 'models/FLUX.2-klein-4B' / name).read_bytes(), FILES[name])

    def test_preexisting_same_size_git_file_checked_before_reuse(self):
        self.fail = True
        self.scenario('network')
        self.fail = False
        name = 'model_index.json'
        staged = self.state / 'model-installer/snapshot' / name
        staged.write_bytes(b'x' * len(FILES[name]))
        self.calls.clear()
        self.assertIn('校验失败 · 可继续', self.scenario('checksum'))
        self.assertFalse(staged.exists())
        self.assertEqual(self.calls, [('/metadata', 0)])
        self.scenario('resume')
        self.assertEqual((self.state / 'models/FLUX.2-klein-4B' / name).read_bytes(), FILES[name])

    def test_immediate_menu_install_and_delete_in_one_process(self):
        self.scenario('roundtrip')
        self.assertIn('stop',(self.state/'calls').read_text().splitlines())
        self.assertEqual(json.loads(self.config.read_text()),{'samples':'keep'})
        for p in ['python','models','model-installer']: self.assertFalse((self.state/p).exists())

    def test_existing_external_configuration_and_busy_delete(self):
        external=self.home/'external-model'
        external.mkdir()
        self.config.write_text(json.dumps({'python':str(self.runner),'model':str(external),'samples':'keep'}))
        (self.state/'busy').touch()
        self.scenario('busy')
        self.assertIn('model',json.loads(self.config.read_text()))
        (self.state/'busy').unlink()
        self.scenario('external')
        self.assertTrue(external.exists() and self.runner.exists())
        self.assertEqual(self.calls,[])
        self.assertEqual(json.loads(self.config.read_text()),{'samples':'keep'})


if __name__=='__main__': unittest.main()
