#!/usr/bin/env python3
"""Create release tar archives without local owners, timestamps or extended attributes."""
import gzip
import pathlib
import sys
import tarfile


def package(root, output, members):
    root = pathlib.Path(root).resolve()
    output = pathlib.Path(output).resolve()
    for name in members:
        member = pathlib.PurePosixPath(name)
        if member.is_absolute() or '..' in member.parts or str(member) == '.':
            raise ValueError('Archive members must be relative paths within the package')

    def clean(info):
        if info.issym() and pathlib.PurePosixPath(info.linkname).is_absolute():
            raise ValueError('Absolute symlinks cannot be distributed')
        info.uid = info.gid = info.mtime = 0
        info.uname = info.gname = ''
        info.pax_headers = {}
        return info

    with output.open('wb') as raw:
        stream = gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) if output.name.endswith('.gz') else raw
        try:
            with tarfile.open(fileobj=stream, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for name in sorted(members):
                    archive.add(root / name, arcname=name, filter=clean)
        finally:
            if stream is not raw:
                stream.close()


if __name__ == '__main__':
    if len(sys.argv) < 4:
        raise SystemExit('Usage: package-archive.py ROOT OUTPUT MEMBER [MEMBER ...]')
    package(sys.argv[1], sys.argv[2], sys.argv[3:])
