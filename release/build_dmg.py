"""Build the release bundle, then package it with a link to Applications."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def source_commit():
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def release_command(version, image_name, commit):
    tag = f'v{version}'
    return (f'python3 -B release/check_tag.py {tag} {commit} && '
            f'gh release create {tag} dist/{image_name} dist/SHA256SUMS '
            f'--notes-file release/RELEASE_NOTES.md --draft --target {commit}')


def main():
    commit = source_commit()
    build = subprocess.run([sys.executable, '-B', ROOT / 'menu-helper/build.py', '--release'])
    if build.returncode:
        sys.exit(build.returncode)
    version = json.loads((ROOT / 'extension/manifest.json').read_text())['version']
    dist = ROOT / 'dist'
    image_name = f'PrintChamber-{version}-arm64.dmg'
    with tempfile.TemporaryDirectory(dir=dist) as temp:
        staging = Path(temp)
        contents = staging / 'contents'
        contents.mkdir()
        subprocess.run(['ditto', dist / 'Print Chamber.app', contents / 'Print Chamber.app'], check=True)
        (contents / 'Applications').symlink_to('/Applications', target_is_directory=True)
        image = staging / image_name
        subprocess.run(['hdiutil', 'create', '-quiet', '-srcfolder', contents, '-volname', 'Print Chamber',
                        '-fs', 'HFS+', '-format', 'UDZO', image], check=True)
        checksum = staging / 'SHA256SUMS'
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        checksum.write_text(f'{digest}  {image_name}\n')
        if source_commit() != commit:
            raise SystemExit('构建期间 Git 提交发生变化，请重新打包。')
        image.replace(dist / image_name)
        checksum.replace(dist / 'SHA256SUMS')
    print(f'dist/{image_name} ({(dist / image_name).stat().st_size:,} bytes)')
    print(f'dist/SHA256SUMS  {digest}')
    print(release_command(version, image_name, commit))


if __name__ == '__main__':
    main()
