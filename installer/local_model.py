"""Fetch the pinned Diffusers snapshot using the anonymous Hugging Face Hub client."""
import hashlib
import json
from pathlib import Path
import sys
import time

from huggingface_hub import HfApi, hf_hub_url
from huggingface_hub.utils import get_session

REPO = 'black-forest-labs/FLUX.2-klein-4B'
REVISION = 'e7b7dc27f91deacad38e78976d1f2b499d76a294'
COMPONENTS = {'scheduler', 'text_encoder', 'tokenizer', 'transformer', 'vae'}


class ChecksumMismatch(Exception):
    pass


def verify_file(path, item):
    # LFS publishes a content SHA-256. Ordinary Git files publish the ID of
    # the blob, which includes its type and size in the hashed bytes.
    if item.lfs is not None:
        digest = hashlib.sha256()
        expected = item.lfs.sha256
    else:
        digest = hashlib.sha1(f'blob {item.size}\0'.encode())
        expected = item.blob_id
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        path.unlink()
        raise ChecksumMismatch(path.name)


def download(folder, progress_file):
    info = HfApi().model_info(REPO, revision=REVISION, files_metadata=True, token=False)
    files = {}
    for item in info.siblings:
        path = Path(item.rfilename)
        if not path.parts or path.is_absolute() or '..' in path.parts:
            raise ValueError('invalid repository path')
        if str(path) in {'LICENSE.md', 'model_index.json'} or path.parts[0] in COMPONENTS:
            files[path] = item
    if (info.sha != REVISION or not {Path('LICENSE.md'), Path('model_index.json')} <= files.keys()
            or not COMPONENTS <= {p.parts[0] for p in files}
            or any(not isinstance(item.size, int) or item.size <= 0 for item in files.values())):
        raise ValueError('incomplete pinned revision')

    total = sum(item.size for item in files.values())
    complete = sum(item.size for path, item in files.items()
                   if (folder / path).is_file() and (folder / path).stat().st_size == item.size)
    last = 0
    def report(count, force=False):
        nonlocal last
        now = time.monotonic()
        if force or now - last >= 0.25:
            tmp = progress_file.with_suffix('.tmp')
            tmp.write_text(json.dumps({'downloaded': count, 'total': total}) + '\n')
            tmp.replace(progress_file)
            last = now

    retained = sum(min(item.size, part.stat().st_size) for path, item in files.items()
                   if (part := (folder / path).with_name(path.name + '.partial')).is_file())
    report(complete + retained, True)
    for path, item in files.items():
        size = item.size
        dest = folder / path
        if dest.is_file() and dest.stat().st_size == size:
            try:
                verify_file(dest, item)
            except ChecksumMismatch:
                report(complete + retained - size, True)
                raise
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + '.partial')
        offset = part.stat().st_size if part.exists() else 0
        retained -= min(offset, size)
        if offset > size:
            part.unlink()
            offset = 0
        if offset < size:
            headers = {'Accept-Encoding': 'identity'}
            if offset:
                headers['Range'] = f'bytes={offset}-'
            url = hf_hub_url(REPO, str(path), revision=REVISION)
            with get_session().stream('GET', url, headers=headers, follow_redirects=True, timeout=45) as response:
                response.raise_for_status()
                if response.status_code == 200:
                    offset = 0  # Server ignored Range. Replace only the unfinished file.
                elif response.status_code != 206 or response.headers.get('Content-Range') != f'bytes {offset}-{size-1}/{size}':
                    raise ValueError('incorrect range')
                with part.open('ab' if offset else 'wb') as target:
                    for chunk in response.iter_bytes(chunk_size=256 * 1024):
                        if len(chunk) > size - offset:
                            raise ValueError('excess data')
                        target.write(chunk)
                        offset += len(chunk)
                        report(complete + retained + offset)
        if part.stat().st_size != size:
            raise ValueError('incomplete download')
        try:
            verify_file(part, item)
        except ChecksumMismatch:
            report(complete + retained, True)
            raise
        part.replace(dest)
        complete += size
        report(complete + retained, True)


if __name__ == '__main__':
    try:
        download(Path(sys.argv[1]), Path(sys.argv[2]))
    except ChecksumMismatch:
        # ModelInstaller maps this exit status to the recoverable checksum error.
        sys.exit(65)
