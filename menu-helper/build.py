"""Build the repository-backed dev helper or a relocatable Apple Silicon app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
LSREGISTER = ('/System/Library/Frameworks/CoreServices.framework/Frameworks/'
              'LaunchServices.framework/Support/lsregister')
NODE_VERSION = '22.23.3'
# Published in https://nodejs.org/dist/v22.23.3/SHASUMS256.txt
NODE_SHA256 = '23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53'


def cached_download(name, url):
    folder = ROOT / '.cache/node'
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / name
    if not target.exists():
        with tempfile.TemporaryDirectory(dir=folder) as tmp:
            fetched = Path(tmp) / name
            with urllib.request.urlopen(url, timeout=90) as response, fetched.open('wb') as output:
                shutil.copyfileobj(response, output)
            fetched.replace(target)
    return target


def copy_node(resources):
    release = f'node-v{NODE_VERSION}-darwin-arm64'
    base = f'https://nodejs.org/dist/v{NODE_VERSION}/'
    archive = release + '.tar.gz'
    sums = cached_download(f'SHASUMS256-v{NODE_VERSION}.txt', base + 'SHASUMS256.txt')
    if [NODE_SHA256, archive] not in [line.split() for line in sums.read_text().splitlines()]:
        raise RuntimeError('Node 校验清单与固定版本的指纹不符')
    source = cached_download(archive, base + archive)
    if hashlib.sha256(source.read_bytes()).hexdigest() != NODE_SHA256:
        raise RuntimeError(f'Node 下载校验失败，请移除缓存 {source} 后重新构建')
    with tarfile.open(source, 'r:gz') as tar:
        for member in ['bin/node', 'LICENSE']:
            target = resources / 'node' / member
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(f'{release}/{member}') as data, target.open('wb') as output:
                shutil.copyfileobj(data, output)
    binary = resources / 'node/bin/node'
    binary.chmod(0o755)
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', binary], check=True)
    version = subprocess.check_output([binary, '--version'], text=True).strip()
    if version != 'v' + NODE_VERSION:
        raise RuntimeError(f'Node 版本不符：{version}')


def assemble(app, release):
    contents = app / 'Contents'
    resources = contents / 'Resources'
    (contents / 'MacOS').mkdir(parents=True, exist_ok=True)
    resources.mkdir(exist_ok=True)
    shutil.copyfile(ROOT / 'menu-helper/AppIcon.icns', resources / 'AppIcon.icns')
    version = json.loads((ROOT / 'extension/manifest.json').read_text())['version']
    info = dict(CFBundleExecutable='PrintChamberHelper',
                CFBundleIdentifier='local.printchamber.app' if release else 'local.printchamber.helper',
                CFBundleName=app.stem, CFBundlePackageType='APPL', CFBundleIconFile='AppIcon',
                CFBundleShortVersionString=version, CFBundleVersion='1', LSUIElement=True,
                NSHighResolutionCapable=True, LSMinimumSystemVersion='13.0',
                PrintChamberMode='app' if release else 'dev')
    if release:
        for name in ['service.py', 'runtime_config.py', 'requirements-macos-arm64.txt', 'benchmark_local.py', 'demo.html']:
            shutil.copyfile(ROOT / name, resources / name)
        shutil.copyfile(ROOT / 'menu-helper/controller.py', resources / 'controller.py')
        shutil.copyfile(ROOT / 'menu-helper/使用说明.txt', resources / '使用说明.txt')
        for name in ['extension', 'native']:
            shutil.copytree(ROOT / name, resources / name, ignore=shutil.ignore_patterns('.DS_Store', '__pycache__'))
        launcher = resources / 'print-chamber-host'
        shutil.copyfile(ROOT / 'menu-helper/print-chamber-host', launcher)
        launcher.chmod(0o755)
        # Shell scripts are sealed as resources. Chrome uses the stable entry in MacOS.
        (contents / 'MacOS/print-chamber-host').symlink_to('../Resources/print-chamber-host')
        copy_node(resources)
    else:
        info['ProjectRoot'] = str(ROOT)
    (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
    target = ['-target', 'arm64-apple-macos13'] if release else []
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-O', *target, '-module-cache-path',
                    '/tmp/print-chamber-swift-cache', ROOT / 'menu-helper/main.swift',
                    '-o', contents / 'MacOS/PrintChamberHelper'], check=True)
    # Sign the outer app only. Never recursively re-sign the official Node executable.
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', app], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', app], check=True)


def build(release=False):
    if release:
        dist = ROOT / 'dist'
        dist.mkdir(exist_ok=True)
        app = dist / 'Print Chamber.app'
        with tempfile.TemporaryDirectory(dir=dist) as tmp:
            staged = Path(tmp) / app.name
            assemble(staged, True)
            backup = Path(tmp) / 'previous.app'
            if app.exists():
                app.rename(backup)
            try:
                staged.rename(app)
            except OSError:
                if backup.exists():
                    backup.rename(app)
                raise
    else:
        app = ROOT / 'Print Chamber 小助手.app'
        assemble(app, False)
        os.utime(app)
        subprocess.run([LSREGISTER, '-f', app], check=False)
    print(app)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', action='store_true', help='build dist/Print Chamber.app')
    build(parser.parse_args().release)
