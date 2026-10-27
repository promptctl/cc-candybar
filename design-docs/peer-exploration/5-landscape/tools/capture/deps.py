"""Fetch the dependencies a project's statusline imports, so the sandbox run can find them.

    python3 -I deps.py <entries.json> <src-root> <deps.json> [slug ...]

The sandbox has no network, so a bar that imports a package it expects installed fails there.
This runs on the host, with network, and only downloads: bun with lifecycle scripts off, and uv
with wheels only, so no project code and no package code runs outside the sandbox. The manifest
nearest the entry file is used: package.json for node and bun entries, requirements.txt or a
pyproject's dependency list for python entries, installed into a venv at .ccland-venv in the
project root, which resolve.py's launch picks up.

Every project asked for gets a record [LAW:no-silent-failure]:
  {"js": "ok" | "<stderr tail>" | null, "py": "ok" | "<stderr tail>" | null}
null where the entry has no manifest of that kind.
"""
import json, os, subprocess, sys, tomllib

ENTRIES, SRC, DEST = sys.argv[1:4]
ONLY = set(sys.argv[4:])
TIMEOUT = 180
VENV = '.ccland-venv'


def nearest(root, rel, names):
    """The closest ancestor directory of rel holding one of names, as (dir, name)."""
    d = os.path.dirname(rel)
    while True:
        for n in names:
            if os.path.exists(os.path.join(root, d, n)):
                return d, n
        if not d:
            return None
        d = os.path.dirname(d)


def sh(argv, cwd):
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, timeout=TIMEOUT, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return 'timeout'
    return 'ok' if p.returncode == 0 else (p.stderr.decode('utf-8', errors='replace').strip()[-300:] or 'exit %d' % p.returncode)


def js_deps(root, rel):
    hit = nearest(root, rel, ['package.json'])
    if not hit:
        return None
    return sh(['bun', 'install', '--ignore-scripts', '--no-progress'], os.path.join(root, hit[0]))


def py_requirements(root, rel):
    hit = nearest(root, rel, ['requirements.txt', 'pyproject.toml'])
    if not hit:
        return None, None
    d, name = hit
    if name == 'requirements.txt':
        return d, ['-r', os.path.join(root, d, name)]
    with open(os.path.join(root, d, name), 'rb') as fh:
        try:
            deps = tomllib.load(fh).get('project', {}).get('dependencies', [])
        except tomllib.TOMLDecodeError as e:
            return d, e
    return d, list(deps)


def py_deps(root, rel):
    d, want = py_requirements(root, rel)
    if want is None:
        return None
    if isinstance(want, Exception):
        return 'pyproject: %s' % want
    if not want:
        return 'ok'
    venv = os.path.join(root, VENV)
    r = sh(['uv', 'venv', '--quiet', venv], root)
    if r != 'ok':
        return r
    return sh(['uv', 'pip', 'install', '--quiet', '--python', os.path.join(venv, 'bin', 'python3'), '--only-binary', ':all:'] + want, root)


entries = {k: v for k, v in json.load(open(ENTRIES)).items() if 'cmd' in v and (not ONLY or k in ONLY)}
deps = json.load(open(DEST)) if os.path.exists(DEST) else {}
for n, (slug, e) in enumerate(entries.items(), 1):
    root = os.path.join(SRC, slug)
    runner = e['cmd'].split()[0]
    rec = {'js': js_deps(root, e['file']) if runner in ('node', 'bun') else None,
           'py': py_deps(root, e['file']) if 'python3' in e['cmd'] else None}
    deps[slug] = rec
    print(n, slug, rec['js'] if rec['js'] in ('ok', None) else 'js-fail', rec['py'] if rec['py'] in ('ok', None) else 'py-fail', flush=True)
    if n % 20 == 0:
        json.dump(deps, open(DEST, 'w'), indent=0)
json.dump(deps, open(DEST, 'w'), indent=0)
print('js ok', sum(1 for r in deps.values() if r['js'] == 'ok'), 'py ok', sum(1 for r in deps.values() if r['py'] == 'ok'))
