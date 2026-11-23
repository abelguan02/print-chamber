"""Build the release bundle, then package it with a link to Applications."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    version = json.loads((ROOT / 'extension/manifest.json').read_text())['version']
    dist = ROOT / 'dist'
    image_name = f'PrintChamber-{version}-arm64.dmg'
    subprocess.run([sys.executable, '-B', ROOT / 'menu-helper/build.py', '--release'], check=True)
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
        image.replace(dist / image_name)
        checksum.replace(dist / 'SHA256SUMS')
    print(f'dist/{image_name} ({(dist / image_name).stat().st_size:,} bytes)')
    print(f'dist/SHA256SUMS  {digest}')
    # Avoid attaching an older build if the developer kept multiple DMGs in dist.
    asset = 'dist/*.dmg' if len(list(dist.glob('*.dmg'))) == 1 else f'dist/{image_name}'
    print(f'gh release create v{version} {asset} dist/SHA256SUMS --notes-file release/RELEASE_NOTES.md --draft')


if __name__ == '__main__':
    main()
