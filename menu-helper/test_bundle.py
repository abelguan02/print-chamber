"""After build.py --release, test the moved bundle without installing or showing the app."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest

import build

ROOT = build.ROOT
MODEL_ACTIONS = {'启动模型', '停止模型', '重启模型', '复制插件连接码'}


def files(folder):
    return {p.relative_to(folder): hashlib.sha256(p.read_bytes()).digest()
            for p in folder.rglob('*') if p.is_file() and p.name != '.DS_Store'}


class BundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temp.cleanup)
        cls.folder = Path(temp.name).resolve()
        cls.app = cls.folder / 'Moved elsewhere' / 'Print Chamber.app'
        cls.app.parent.mkdir()
        subprocess.run(['ditto', ROOT / 'dist/Print Chamber.app', cls.app], check=True)
        cls.resources = cls.app / 'Contents/Resources'

    def setUp(self):
        temp = tempfile.TemporaryDirectory(dir=self.folder)
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name) / 'test state'

    def launch(self, app=None, **overrides):
        env = {'PATH': '/usr/bin:/bin', 'PRINT_CHAMBER_STATE': str(self.state), **overrides}
        executable = (app or self.app) / 'Contents/MacOS/PrintChamberHelper'
        output = subprocess.check_output([executable, '--self-test'], cwd=self.folder,
                                         env=env, text=True, timeout=15)
        return json.loads(output)

    def test_release_contents_architecture_and_signatures(self):
        info = plistlib.loads((self.app / 'Contents/Info.plist').read_bytes())
        self.assertEqual(info['PrintChamberMode'], 'app')
        self.assertNotIn('ProjectRoot', info)
        self.assertEqual(info['CFBundleIdentifier'], 'local.printchamber.app')
        self.assertEqual(info['CFBundleShortVersionString'], json.loads((ROOT / 'extension/manifest.json').read_text())['version'])
        self.assertEqual(info['LSMinimumSystemVersion'], '13.0')
        helper = self.app / 'Contents/MacOS/PrintChamberHelper'
        self.assertEqual(subprocess.check_output(['lipo', '-archs', helper], text=True).strip(), 'arm64')
        self.assertRegex(subprocess.check_output(['otool', '-l', helper], text=True), r'minos\s+13\.0\b')
        for folder in ['extension', 'native']:
            self.assertEqual(files(self.resources / folder), files(ROOT / folder))
        for name in ['service.py', 'runtime_config.py', 'benchmark_local.py', 'demo.html', 'requirements-macos-arm64.txt',
                     'menu-helper/controller.py', 'menu-helper/AppIcon.icns', 'menu-helper/使用说明.txt']:
            self.assertEqual((self.resources / Path(name).name).read_bytes(), (ROOT / name).read_bytes())
        node = self.resources / 'node/bin/node'
        self.assertEqual(subprocess.check_output([node, '--version'], text=True).strip(), 'v' + build.NODE_VERSION)
        release = f'node-v{build.NODE_VERSION}-darwin-arm64'
        with tarfile.open(ROOT / '.cache/node' / (release + '.tar.gz'), 'r:gz') as archive:
            with archive.extractfile(release + '/bin/node') as upstream:
                self.assertEqual(hashlib.sha256(upstream.read()).digest(), hashlib.sha256(node.read_bytes()).digest())
        for target in [node, self.app]:
            subprocess.run(['codesign', '--verify', '--strict', target], check=True)
        signature = subprocess.check_output(['codesign', '-dv', '--verbose=4', self.app], stderr=subprocess.STDOUT)
        self.assertIn(b'Signature=adhoc', signature)

    def test_moved_app_missing_model_creates_private_state_and_menu(self):
        result = self.launch()
        self.assertEqual(result['mode'], 'app')
        self.assertEqual(Path(result['resources']).resolve(), self.resources)
        self.assertEqual(Path(result['state']).resolve(), self.state)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        self.assertEqual(Path(result['controller']).resolve(), self.resources / 'controller.py')
        self.assertTrue(Path(result['help']).is_file())
        self.assertEqual(files(self.state / 'extension'), files(self.resources / 'extension'))
        self.assertIn('设置…', result['menu'])
        self.assertIn('本地模型未安装', result['menu'])
        self.assertFalse(MODEL_ACTIONS.intersection(result['menu']))
        self.assertIsNone(result['python'])
        self.assertEqual(result['controllerStarts'], 0)
        self.assertFalse((self.state / 'helper.log').exists())

    def test_sync_repairs_changed_files_and_leaves_other_data_alone(self):
        self.state.mkdir()
        preserved = {'runtime.json': '{}', 'token': 'fixture', 'models/fixture': 'model fixture'}
        (self.state / 'models').mkdir()
        for name, value in preserved.items():
            path = self.state / name
            path.write_text(value)
            os.utime(path, (1000, 1000))
        self.launch()
        extension = self.state / 'extension'
        marker = extension / 'manifest.json'
        os.utime(marker, (1000, 1000))
        (extension / 'popup.html').write_text('outdated')
        (extension / 'old.js').touch()
        # A link in the mirror must never allow edits outside the mirror.
        external = self.state / 'my files'
        external.mkdir()
        keep = external / 'untouched.txt'
        keep.write_text('keep')
        shutil.rmtree(extension / 'icons')
        (extension / 'icons').symlink_to(external, target_is_directory=True)
        self.launch()
        self.assertEqual(files(extension), files(self.resources / 'extension'))
        self.assertEqual(marker.stat().st_mtime, 1000)
        self.assertFalse((extension / 'icons').is_symlink())
        self.assertEqual(list(external.iterdir()), [keep])
        self.assertEqual(keep.read_text(), 'keep')
        for name, value in preserved.items():
            self.assertEqual((self.state / name).read_text(), value)
            self.assertEqual((self.state / name).stat().st_mtime, 1000)

    def test_configured_python_and_model_use_bundled_controller(self):
        self.state.mkdir()
        model = self.state / 'custom model'
        python = self.state / 'fake interpreter'
        python.write_text('#!/bin/sh\nprintf "%s\\n" "$1" "$2" "$PRINT_CHAMBER_MODE" "$PRINT_CHAMBER_STATE" > "$PRINT_CHAMBER_STATE/call"\necho \'{"state":"stopped","label":"模拟控制器已返回"}\'\n')
        python.chmod(0o700)
        (self.state / 'runtime.json').write_text(json.dumps({'python': str(python), 'model': str(model)}))
        self.assertEqual(self.launch()['controllerStarts'], 0)
        model.mkdir()
        result = self.launch()
        self.assertEqual(result['controllerStarts'], 1)
        self.assertTrue(MODEL_ACTIONS.issubset(result['menu']))
        self.assertIn('模拟控制器已返回', result['menu'])
        controller, action, mode, state = (self.state / 'call').read_text().splitlines()
        self.assertEqual(Path(controller).resolve(), self.resources / 'controller.py')
        self.assertEqual((action, mode, Path(state).resolve()), ('status', 'app', self.state))
        for unusable in ['/missing/override', '/usr/bin/python3']:
            self.assertEqual(self.launch(FLUX_PYTHON=unusable)['controllerStarts'], 0)

    def test_packaged_controller_resolves_service_without_repository(self):
        script = ("import json, runpy, sys; "
                  "controller = runpy.run_path(sys.argv[1]); "
                  "print(json.dumps([str(controller[k]) for k in ('ROOT', 'STATE', 'PYTHON')]))")
        env = {'PATH': '/usr/bin:/bin', 'PRINT_CHAMBER_MODE': 'app', 'PRINT_CHAMBER_STATE': str(self.state)}
        output = subprocess.check_output([sys.executable, '-I', '-B', '-c', script,
                                          self.resources / 'controller.py'], cwd=self.folder, env=env)
        root, state, python = map(Path, json.loads(output))
        self.assertEqual(root, self.resources)
        self.assertTrue((root / 'service.py').is_file())
        self.assertEqual(state, self.state)
        self.assertEqual(python, self.state / 'python/bin/python')

    def test_dev_build_keeps_repository_paths(self):
        # Use the default builder's assembly step; keep Launch Services registration untouched.
        dev = self.folder / 'Print Chamber 小助手.app'
        build.assemble(dev, False)
        info = plistlib.loads((dev / 'Contents/Info.plist').read_bytes())
        self.assertEqual(info['PrintChamberMode'], 'dev')
        self.assertEqual(info['ProjectRoot'], str(ROOT))
        self.assertEqual(info['CFBundleIdentifier'], 'local.printchamber.helper')
        result = self.launch(dev, FLUX_PYTHON='/missing/test-interpreter')
        self.assertEqual(Path(result['controller']), ROOT / 'menu-helper/controller.py')
        self.assertEqual(Path(result['help']), ROOT / '菜单栏小助手说明.txt')
        self.assertFalse((self.state / 'extension').exists())
        self.assertNotIn('设置…', result['menu'])


if __name__ == '__main__':
    unittest.main()
