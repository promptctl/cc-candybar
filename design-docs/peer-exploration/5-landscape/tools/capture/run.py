"""Run every resolved entry inside the sandbox, once per terminal width, and keep what it printed.

    python3 -I run.py <entries.json> <fixture-dir> <src-root> <runs-dir> <captures.json> [slug ...]

Each run gets a fresh copy of the fixture and of the project tree under <runs-dir>/<slug>, and
the sandbox profile beside this file confines the process to that copy: no network, no reads
outside it except the runtimes, no writes outside it. The command runs with the hook JSON on
stdin, the fixture home as HOME, and the terminal size Claude Code advertises. A terminal reflows
by re-running the script at the new width, so each width is its own run on its own fresh copy.

Every entry produces a record, success or not [LAW:no-silent-failure]:
  {"ok": true,  "ms": n, "bars": {"80": "<bytes as text>", "120": ..., "160": ...}, "cmd": "<shell>"}
  {"ok": false, "ms": n, "bars": {...}, "err": "<stderr tail>", "exit": n | "timeout", "cmd": "<shell>"}
ok is the verdict of the 120-column run, the width Claude Code most often advertises; bars holds
every width that printed something and exited 0. A run whose exit code is 0 but printed nothing
is not ok: a blank bar is a failure to show anything.
"""
import json, os, shutil, subprocess, sys, time
import concurrent.futures as cf

ENTRIES, FIXTURE, SRC, RUNS, DEST = sys.argv[1:6]
ONLY = set(sys.argv[6:])
HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.path.join(HERE, 'sandbox.sb')
TIMEOUT = 20
WIDTHS, MAIN, ROWS = (80, 120, 160), 120, 40
HOME_SHOWN = '/Users/dev'
MAX_TREE = 200_000_000
WORKERS = 6


def real(p):
    return os.path.realpath(p)


def tree_size(root):
    total = 0
    for d, dirs, files in os.walk(root):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(d, f))
            except OSError:
                pass
            if total > MAX_TREE:
                return total
    return total


def capture(slug, entry):
    src = os.path.join(SRC, slug)
    if tree_size(src) > MAX_TREE:
        return {'ok': False, 'ms': 0, 'bars': {}, 'err': 'project tree over %d MB' % (MAX_TREE // 1_000_000), 'exit': 'skipped', 'cmd': entry['cmd']}
    runs = {w: run_once(slug, entry, src, w) for w in WIDTHS}
    main = runs[MAIN]
    rec = {'ok': main['ok'], 'ms': sum(r['ms'] for r in runs.values()), 'cmd': entry['cmd'],
           'bars': {str(w): r['out'] for w, r in runs.items() if r['ok']}}
    if not main['ok']:
        rec['exit'] = main['exit']
        rec['err'] = main['err']
    return rec


def run_once(slug, entry, src, width):
    run = real(os.path.join(RUNS, '%s-%d' % (slug, width)))
    shutil.rmtree(run, ignore_errors=True)
    shutil.copytree(FIXTURE, run, symlinks=True)
    proj = os.path.join(run, 'proj')
    shutil.copytree(src, proj, symlinks=True)
    hook = open(os.path.join(FIXTURE, 'hook.json')).read().replace('__RUN__', run)
    tp = os.path.join(run, 'home/.claude/projects')
    for d in os.listdir(tp):
        if '__RUN__' in d:
            os.rename(os.path.join(tp, d), os.path.join(tp, d.replace('__RUN__', run.replace('/', '-'))))
    home = os.path.join(run, 'home')
    cwd = os.path.join(run, 'work', 'candybar-demo')
    cmd = entry['cmd'].replace('__PROJ__', proj)
    env = {'HOME': home, 'USER': 'dev', 'LOGNAME': 'dev', 'SHELL': '/bin/bash', 'TMPDIR': os.path.join(run, 'tmp'),
           'PATH': os.path.join(run, 'bin') + ':' + os.path.join(proj, 'node_modules/.bin') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:' + os.path.expanduser('~/.bun/bin'),
           'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8', 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
           'COLUMNS': str(width), 'LINES': str(ROWS), 'CLAUDE_PLUGIN_ROOT': proj, 'CLAUDE_CONFIG_DIR': os.path.join(home, '.claude'),
           'CLAUDE_CODE_ENTRYPOINT': 'cli', 'CLAUDECODE': '1', 'NO_COLOR': '', 'FORCE_COLOR': '1', 'PWD': cwd}
    os.makedirs(env['TMPDIR'])
    argv = ['sandbox-exec', '-f', PROFILE, '-D', 'RUN=' + run, '-D', 'SRC=' + real(src), 'bash', '-c', cmd]
    t0 = time.time()
    try:
        p = subprocess.run(argv, input=hook.encode(), capture_output=True, cwd=cwd, env=env, timeout=TIMEOUT, start_new_session=True)
        exit_code, out, err = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        exit_code, out, err = 'timeout', e.stdout or b'', e.stderr or b''
    ms = int((time.time() - t0) * 1000)
    shutil.rmtree(run, ignore_errors=True)
    # The run directory stands in for the user's home, so a bar that prints a path shows a home-like one.
    text = out.decode('utf-8', errors='replace').replace(run, HOME_SHOWN)
    return {'ok': exit_code == 0 and text.strip() != '', 'ms': ms, 'out': text[:20000], 'exit': exit_code,
            'err': err.decode('utf-8', errors='replace')[-2000:] or ('printed nothing' if exit_code == 0 else '')}


entries = {k: v for k, v in json.load(open(ENTRIES)).items() if 'cmd' in v and (not ONLY or k in ONLY)}
captures = json.load(open(DEST)) if os.path.exists(DEST) and not ONLY else {}
os.makedirs(RUNS, exist_ok=True)
done = 0
with cf.ThreadPoolExecutor(WORKERS) as pool:
    futures = {pool.submit(capture, slug, e): slug for slug, e in entries.items()}
    for f in cf.as_completed(futures):
        slug = futures[f]
        captures[slug] = f.result()
        done += 1
        if done % 100 == 0 or ONLY:
            print(done, slug, 'ok' if captures[slug]['ok'] else captures[slug].get('exit'), flush=True)
            json.dump(captures, open(DEST, 'w'))
json.dump(captures, open(DEST, 'w'))
ok = sum(1 for c in captures.values() if c['ok'])
print('captured %d of %d' % (ok, len(captures)))
