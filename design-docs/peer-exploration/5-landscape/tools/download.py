"""Download the source of every selected project into /tmp/ccland/src/<slug>/.

Keeps text source files only (<= 300 KB, no vendored/build dirs). Reruns skip
projects whose directory holds a .done marker.
"""
import io, json, os, re, subprocess, sys, tarfile, urllib.request, urllib.error
import concurrent.futures as cf

SRC = '/tmp/ccland/src'
TOKEN = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()
SKIP_DIR = re.compile(r'(^|/)(node_modules|vendor|dist|build|target|\.git|\.next|coverage|__pycache__|\.venv|venv|site-packages|bower_components|out)(/|$)')
SKIP_FILE = re.compile(r'(\.min\.js|\.map|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|\.lock|\.png|\.jpe?g|\.gif|\.webp|\.ico|\.svg|\.woff2?|\.ttf|\.otf|\.mp4|\.mov|\.gif|\.pdf|\.zip|\.gz|\.tgz|\.wasm|\.so|\.dylib|\.exe|\.bin|\.db|\.sqlite)$', re.I)
MAX_FILE = 300_000
MAX_TOTAL = int(os.environ.get("CCLAND_MAX", "40000000"))


def slug(repo):
    return re.sub(r'[^A-Za-z0-9._-]+', '__', repo)


def keep(name, size):
    return size <= MAX_FILE and not SKIP_DIR.search(name) and not SKIP_FILE.search(name)


def gh_repo(repo, dest):
    url = 'https://codeload.github.com/%s/tar.gz/HEAD' % repo
    r = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'ccland/1.0'}), timeout=300)
    total = 0
    with tarfile.open(fileobj=r, mode='r|gz') as tf:
        for m in tf:
            if not m.isfile():
                continue
            name = m.name.split('/', 1)[1] if '/' in m.name else m.name
            if not keep(name, m.size):
                continue
            data = tf.extractfile(m).read()
            if b'\0' in data[:4096]:
                continue
            total += len(data)
            if total > MAX_TOTAL:
                break
            p = os.path.join(dest, name)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, 'wb').write(data)


def gist(gid, dest):
    req = urllib.request.Request('https://api.github.com/gists/' + gid,
                                 headers={'Authorization': 'token ' + TOKEN, 'User-Agent': 'ccland/1.0'})
    d = json.loads(urllib.request.urlopen(req, timeout=60).read())
    os.makedirs(dest, exist_ok=True)
    for fn, f in d['files'].items():
        c = f.get('content')
        if c is None and f.get('raw_url'):
            c = urllib.request.urlopen(f['raw_url'], timeout=60).read().decode('utf-8', 'replace')
        if c is not None and keep(fn, len(c)):
            open(os.path.join(dest, slug(fn)), 'w').write(c)


def forge(kind, pid, dest):
    if kind == 'gitlab.com':
        o, n = pid.split('/', 1)
        url = 'https://gitlab.com/%s/-/archive/HEAD/%s-HEAD.tar.gz' % (pid, n)
    else:
        url = 'https://codeberg.org/%s/archive/HEAD.tar.gz' % pid
    r = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'ccland/1.0'}), timeout=300)
    with tarfile.open(fileobj=r, mode='r|gz') as tf:
        for m in tf:
            if not m.isfile():
                continue
            name = m.name.split('/', 1)[1] if '/' in m.name else m.name
            if not keep(name, m.size):
                continue
            data = tf.extractfile(m).read()
            if b'\0' in data[:4096]:
                continue
            p = os.path.join(dest, name)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, 'wb').write(data)


def one(p):
    dest = os.path.join(SRC, p['slug'])
    if os.path.exists(os.path.join(dest, '.done')):
        return p['slug'], 'skip'
    os.makedirs(dest, exist_ok=True)
    try:
        if p['kind'] == 'gh':
            gh_repo(p['repo'], dest)
        elif p['kind'] == 'gist':
            gist(p['id'], dest)
        else:
            forge(p['kind'], p['id'], dest)
    except Exception as e:
        return p['slug'], 'error %s' % e
    open(os.path.join(dest, '.done'), 'w').write('')
    return p['slug'], 'ok'


sel = json.load(open('/tmp/ccland/selected.json'))
os.makedirs(SRC, exist_ok=True)
with cf.ThreadPoolExecutor(10) as ex:
    for n, (s, st) in enumerate(ex.map(one, sel)):
        if st != 'ok' and st != 'skip':
            print(s, st, file=sys.stderr)
        if n % 100 == 0:
            print(n, file=sys.stderr)
print('done', file=sys.stderr)
