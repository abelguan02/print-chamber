"""Extract the user-supplied design, preserving its original templates and fonts."""
import base64
import gzip
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent
DEST = ROOT / 'design-reference'
DEST.mkdir(exist_ok=True)
source = (DEST / 'original.html').read_text()

def section(text, name):
    match = re.search(r'<script[^>]*type="__bundler/' + name + r'"[^>]*>(.*?)</script>', text, re.S)
    return json.loads(match.group(1)) if match else None

def decode(asset):
    data = base64.b64decode(asset['data'])
    return gzip.decompress(data) if asset.get('compressed') else data

names = ['printer', 'states', 'site', 'popup', 'gallery']
for name, asset in zip(names, section(source, 'manifest').values()):
    page = decode(asset).decode()
    template = section(page, 'template')
    (DEST / (name + '.html')).write_text(template)
    if name == 'printer':
        fonts = [decode(a) for a in section(page, 'manifest').values() if a['mime'] == 'font/woff2']
        fontdir = ROOT / 'extension' / 'fonts'
        fontdir.mkdir(exist_ok=True)
        for filename, data in zip(['doto.woff2', 'ibm-plex-mono.woff2'], fonts):
            (fontdir / filename).write_bytes(data)
(DEST / 'original.html').write_text(source)
print('Extracted five templates and two bundled fonts from the supplied design.')
