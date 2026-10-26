#!/usr/bin/env python3
"""Pinned native sources and notices. Python 3.11+, Git, network for fetch only."""
import argparse, concurrent.futures, gzip, hashlib, io, json, os, pathlib, re, shutil, subprocess, tarfile, tempfile, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[1]
NATIVE = ROOT / 'licenses/native'
CACHE = ROOT / 'dist/native-sources'

def digest(p):
    with open(p, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def read_lock():
    return json.loads((NATIVE / 'sources.lock.json').read_text())

def verify(row):
    p = CACHE / row['archive']
    if not p.is_file() or digest(p) != row['sha256']:
        raise RuntimeError(f"Missing or changed native source: {row['archive']}; run pnpm native:fetch")
    return p

def fetch(row):
    p = CACHE / row['archive']
    if p.exists():
        verify(row)
        return
    part = p.with_suffix(p.suffix + '.part')
    if row.get('kind') == 'git-archive':
        with tempfile.TemporaryDirectory(prefix='kifu-source-') as tmp:
            repo = pathlib.Path(tmp) / 'repo'
            subprocess.run(['git', 'clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', row['tag'], 'https://github.com/' + row['repository'] + '.git', str(repo)], check=True)
            rev = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            if rev != row['revision']:
                raise RuntimeError('Upstream tag changed: ' + row['tag'])
            dirs = subprocess.check_output(['git', '-C', str(repo), 'ls-tree', '-d', '--name-only', 'HEAD'], text=True).splitlines()
            subprocess.run(['git', '-C', str(repo), 'sparse-checkout', 'set', *[d for d in dirs if d in row['paths']]], check=True)
            subprocess.run(['git', '-C', str(repo), 'checkout'], check=True)
            with open(part, 'wb') as f, gzip.GzipFile(filename='', mode='wb', fileobj=f, mtime=0, compresslevel=6) as g:
                proc = subprocess.Popen(['git', '-C', str(repo), 'archive', '--format=tar', '--prefix=' + row['id'] + '/', row['revision'], *row['paths']], stdout=subprocess.PIPE)
                shutil.copyfileobj(proc.stdout, g)
                if proc.wait() != 0:
                    raise RuntimeError('git archive failed')
    else:
        with urllib.request.urlopen(row['url'], timeout=180) as res, open(part, 'wb') as f:
            shutil.copyfileobj(res, f)
    if digest(part) != row['sha256']:
        raise RuntimeError('Downloaded checksum mismatch: ' + row['id'])
    part.rename(p)

NOTICE_NAME = re.compile(r'(?i)^(licen[cs]e|copying|notice|copyright|unlicense)([.-]|$)')
CODE = {'.h', '.hpp', '.c', '.cpp', '.cc', '.zig', '.rs', '.js', '.ts'}

def extract_notices(row):
    """Preserve named notices and leading copyright blocks, deduplicating exact text."""
    found = {}
    with tarfile.open(verify(row)) as t:
        for m in t:
            if not m.isfile() or m.size > 16 * 1024 * 1024:
                continue
            rel = '/'.join(m.name.split('/')[1:])
            if not rel:
                continue
            # Tests/examples are retained in source archives but not declared as linked code.
            if any(p.lower() in {'test', 'tests', 'fixtures', 'bench', 'examples', 'layouttests', 'jstests'} for p in pathlib.PurePosixPath(rel).parts):
                continue
            named = bool(NOTICE_NAME.match(pathlib.PurePosixPath(rel).name))
            readme = pathlib.PurePosixPath(rel).name.lower() == 'readme.md'
            metadata = row['id'].startswith('zig-asar-') and rel == 'package.json'
            if not named and not readme and not metadata and pathlib.PurePosixPath(rel).suffix not in CODE:
                continue
            raw = t.extractfile(m).read() if named else t.extractfile(m).read(32768)
            text = raw.decode('utf-8', errors='replace')
            if readme:
                match = re.search(r'(?im)^#{1,3} License[^\n]*\n', text)
                if not match:
                    continue
                text = text[match.start():]
                named = True
            if metadata:
                named = True
            if not named:
                # A copyright header may precede #include or follow a one-line file banner.
                blocks = re.findall(r'/\*.*?\*/|(?m:^(?://[^\n]*\n)+)', text[:24000], re.S)
                text = '\n\n'.join(b for b in blocks if re.search(r'copyright|SPDX-License-Identifier|public domain', b, re.I))
                if not text:
                    continue
            key = hashlib.sha256(text.encode()).hexdigest()
            found.setdefault(key, {'paths': [], 'text': text})['paths'].append(rel)
    sections = [f"Native source notices: {row['id']}\nSource archive SHA-256: {row['sha256']}\nOriginal terms and copyright statements follow. Coverage includes conservative build/tool dependencies.\n"]
    for v in found.values():
        sections.append('\n' + '=' * 72 + '\n' + '\n'.join(v['paths']) + '\n\n' + v['text'] + '\n')
    return '\n'.join(sections), len(found)

def notices(rows):
    out = NATIVE / 'notices'
    out.mkdir(exist_ok=True)
    records = []
    for r in rows:
        content, count = extract_notices(r)
        if not count:
            # Some registry crates omit workspace licenses; their pinned VCS archive is also included.
            supplements = [s['id'] for s in rows if r['id'] in s.get('parents', [])]
            if not supplements:
                raise RuntimeError('No notice or source supplement: ' + r['id'])
            content += '\nWorkspace notices: ' + ', '.join(supplements) + '\n'
        name = r['id'] + '.txt'
        (out / name).write_text(content)
        records.append({'component': r['id'], 'file': 'notices/' + name, 'sha256': digest(out / name), 'noticeBlocks': count})
    (NATIVE / 'notices.lock.json').write_text(json.dumps(records, indent=2) + '\n')
    print(f'Collected notices for {len(records)} native source archives.')

def bundle(rows):
    for r in rows:
        verify(r)
    dest = ROOT / 'dist/release'
    dest.mkdir(exist_ok=True)
    version = json.loads((ROOT / 'package.json').read_text())['version']
    out = dest / f'kifu-{version}-source-materials.tar.gz'
    # Only Git-visible files; explicitly omit machine-local launch settings.
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
    names = sorted(set(n for n in names if n and not n.startswith(('.git/', '.claude/'))))
    entries = [(ROOT / n, 'kifu/' + n) for n in names]
    entries += [(CACHE / r['archive'], 'native-sources/' + r['archive']) for r in rows]
    manifest = {n: digest(p) for p, n in entries if p.is_file()}
    # Stable timestamps/owners avoid leaking local user identity.
    with open(str(out) + '.part', 'wb') as f, gzip.GzipFile(filename='', mode='wb', fileobj=f, mtime=0, compresslevel=1) as g, tarfile.open(fileobj=g, mode='w|') as t:
        for p, name in entries:
            if not p.is_file() or p.is_symlink():
                raise RuntimeError('Unexpected source entry: ' + name)
            info = t.gettarinfo(str(p), arcname=name)
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ''
            with open(p, 'rb') as source:
                t.addfile(info, source)
        data = (json.dumps(manifest, indent=2) + '\n').encode()
        info = tarfile.TarInfo('SHA256.json')
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
    pathlib.Path(str(out) + '.part').replace(out)
    pathlib.Path(str(out) + '.sha256').write_text(digest(out) + '  ' + out.name + '\n')
    print(f'Source materials: {out.relative_to(ROOT)} ({out.stat().st_size // 1048576} MiB), {len(manifest)} files.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['fetch', 'verify', 'notices', 'bundle'])
    args = parser.parse_args()
    rows = read_lock()
    CACHE.mkdir(parents=True, exist_ok=True)
    if args.command == 'fetch':
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(fetch, rows))
        print(f'Fetched and verified {len(rows)} native source archives.')
    elif args.command == 'verify':
        for row in rows:
            verify(row)
        print(f'Verified {len(rows)} native source archives.')
    elif args.command == 'notices':
        notices(rows)
    else:
        bundle(rows)
