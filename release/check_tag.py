"""Read the remote tag just before a draft release; never create or move it."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def check_tag(tag, commit, repo=ROOT):
    ref = f'refs/tags/{tag}'
    result = subprocess.check_output(
        ['git', 'ls-remote', '--tags', 'origin', ref, ref + '^{}'], cwd=repo, text=True)
    # Annotated tags point to a tag object. Its peeled ref names the actual commit.
    refs = {refname: sha for sha, refname in (line.split() for line in result.splitlines())}
    target = refs.get(ref + '^{}', refs.get(ref))
    if target is not None and target != commit:
        raise SystemExit(f'{tag} 指向 {target}，与安装包的提交 {commit} 不一致。')


if __name__ == '__main__':
    check_tag(*sys.argv[1:])
