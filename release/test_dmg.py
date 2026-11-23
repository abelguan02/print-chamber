"""Verify the built DMG and exercise its copied app in an isolated home."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist'


class DiskImageTests(unittest.TestCase):
    def test_mount_and_copy_release(self):
        version = json.loads((ROOT / 'extension/manifest.json').read_text())['version']
        image = DIST / f'PrintChamber-{version}-arm64.dmg'
        self.assertLess(image.stat().st_size, 80_000_000)
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        self.assertEqual((DIST / 'SHA256SUMS').read_text(), f'{digest}  {image.name}\n')
        subprocess.run(['hdiutil', 'verify', image], check=True)
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            state = home / 'data'
            env = dict(HOME=str(home), PATH='/usr/bin:/bin', PRINT_CHAMBER_STATE=str(state))
            mount = home / 'mount'
            mount.mkdir()
            subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen',
                            '-mountpoint', mount, image], check=True)
            try:
                self.assertEqual(os.readlink(mount / 'Applications'), '/Applications')
                app = home / 'Print Chamber.app'
                subprocess.run(['ditto', mount / app.name, app], check=True)
            finally:
                subprocess.run(['hdiutil', 'detach', mount], check=True)
            contents = app / 'Contents'
            info = plistlib.loads((contents / 'Info.plist').read_bytes())
            self.assertEqual(info['CFBundleShortVersionString'], version)
            subprocess.run(['codesign', '--verify', '--strict', app], check=True)
            report = subprocess.check_output([contents / 'MacOS/PrintChamberHelper', '--self-test'],
                                             env=env, text=True)
            self.assertEqual(json.loads(report)['state'], str(state))
            print('Copied app --self-test: OK', flush=True)
            subprocess.run([contents / 'Resources/node/bin/node', '--version'], env=env, check=True)


if __name__ == '__main__':
    unittest.main()
