"""Run every resolved entry inside the sandbox through the fixture's timeline, at each terminal
width, and keep every frame the bar changed to.

    python3 -I run.py <entries.json> <fixture-dir> <src-root> <runs-dir> <captures.json> [slug ...]

Each width gets one run copy under <runs-dir>/<slug>-<width>: the fixture's home, stub tools and
a copy of the project tree. The copy lives for the whole timeline, so a script that keeps state in
its home (a pet, a spinner, a cache) keeps it between ticks, as it would under Claude Code. At
each tick only what the session changes is swapped in: the project tree and the transcript. The
sandbox profile beside this file confines the process to the copy: no network, no reads outside
it except the runtimes, no writes outside it. The command runs with the tick's hook JSON on
stdin, the copy's home as HOME, and the terminal size Claude Code advertises.

Every entry produces a record, success or not [LAW:no-silent-failure]:
  {"ok": true,  "ms": n, "cmd": "<shell>",
   "frames": {"80": [[tick, "<bytes as text>"], ...], "120": [...], "160": [...]}}
  {"ok": false, "ms": n, "cmd": "<shell>", "frames": {...}, "err": "<stderr tail>", "exit": n | "timeout"}
A frame is recorded at a tick when the output differs from the previous tick's, so a static bar
is one frame and an animated one is many. ok is the verdict of the first tick at 120 columns, the
width Claude Code most often advertises; a tick whose exit code is 0 but printed nothing is not
ok: a blank bar is a failure to show anything. Ticks that fail after the first are left out of
the frames.
"""
import json, os, shutil, signal, subprocess, sys, time
import concurrent.futures as cf

ENTRIES, FIXTURE, SRC, RUNS, DEST = sys.argv[1:6]
ONLY = set(sys.argv[6:])
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I leaves the script's own directory off the path
from scrub import scrub  # noqa: E402
PROFILE = os.path.join(HERE, 'sandbox.sb')
TIMEOUT = 20
SLOW_MS = 3000  # average per tick above which the timeline is cut short
PROJECT_TIMEOUT = 900  # seconds for one project at every width before its child runner is killed
WIDTHS, MAIN, ROWS = (80, 120, 160), 120, 40
MAX_TREE = 600_000_000  # node_modules fetched by deps.py count; a bigger tree is only slower to copy
WORKERS = 8
TICKS = sorted(os.listdir(os.path.join(FIXTURE, 'tick')))
# this user's temp directory, by its real path, for the sandbox to deny
UTMP = os.path.realpath(subprocess.check_output(['getconf', 'DARWIN_USER_TEMP_DIR'], text=True).strip())
TRANSCRIPT_DIR = 'home/.claude/projects'


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
        return {'ok': False, 'ms': 0, 'cmd': entry['cmd'], 'frames': {}, 'err': 'project tree over %d MB' % (MAX_TREE // 1_000_000), 'exit': 'skipped'}
    runs = {w: run_timeline(slug, entry, src, w) for w in WIDTHS}
    first = runs[MAIN]['first']
    rec = {'ok': first['ok'], 'ms': sum(r['ms'] for r in runs.values()), 'cmd': entry['cmd'],
           'frames': {str(w): r['frames'] for w, r in runs.items()}}
    if not first['ok']:
        rec['exit'] = first['exit']
        rec['err'] = first['err']
    return rec


def run_timeline(slug, entry, src, width):
    run = real(os.path.join(RUNS, '%s-%d' % (slug, width)))
    shutil.rmtree(run, ignore_errors=True)
    os.makedirs(run)
    for d in ('home', 'bin'):
        shutil.copytree(os.path.join(FIXTURE, 'base', d), os.path.join(run, d), symlinks=True)
    proj = os.path.join(run, 'proj')
    shutil.copytree(src, proj, symlinks=True)
    os.makedirs(os.path.join(run, 'tmp'))
    home = os.path.join(run, 'home')
    cwd = os.path.join(run, 'work', 'candybar-demo')
    cmd = entry['cmd'].replace('__PROJ__', proj)
    env = {'HOME': home, 'USER': 'dev', 'LOGNAME': 'dev', 'SHELL': '/bin/bash', 'TMPDIR': os.path.join(run, 'tmp'),
           'PATH': os.path.join(run, 'bin') + ':' + os.path.join(proj, 'node_modules/.bin') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:' + os.path.expanduser('~/.bun/bin'),
           'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8', 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
           'COLUMNS': str(width), 'LINES': str(ROWS), 'CLAUDE_PLUGIN_ROOT': proj, 'CLAUDE_CONFIG_DIR': os.path.join(home, '.claude'),
           'CLAUDE_CODE_ENTRYPOINT': 'cli', 'CLAUDECODE': '1', 'NO_COLOR': '', 'FORCE_COLOR': '1', 'PWD': cwd}
    argv = ['sandbox-exec', '-f', PROFILE, '-D', 'RUN=' + run, '-D', 'SRC=' + real(src), '-D', 'UTMP=' + UTMP, 'bash', '-c', cmd]
    frames, last, first, ms = [], None, None, 0
    for k, tick in enumerate(TICKS):
        td = os.path.join(FIXTURE, 'tick', tick)
        # what the session changed since the last tick: the project tree and the transcript
        shutil.rmtree(os.path.join(run, 'work'), ignore_errors=True)
        shutil.copytree(os.path.join(td, 'work'), os.path.join(run, 'work'), symlinks=True)
        tdir = os.path.join(run, TRANSCRIPT_DIR)
        shutil.rmtree(tdir, ignore_errors=True)
        for d in os.listdir(os.path.join(td, TRANSCRIPT_DIR)):
            shutil.copytree(os.path.join(td, TRANSCRIPT_DIR, d), os.path.join(tdir, d.replace('__RUN__', run.replace('/', '-'))))
        hook = open(os.path.join(td, 'hook.json')).read().replace('__RUN__', run)
        t0 = time.time()
        p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd, env=env, start_new_session=True)
        try:
            out, err = p.communicate(hook.encode(), timeout=TIMEOUT)
            exit_code = p.returncode
        except subprocess.TimeoutExpired:
            exit_code = 'timeout'
        # A bar that leaves a helper running in the background (a cache refresher, a daemon) would hold
        # the pipes open into the next tick and outlive the sweep; the whole session is ended each tick.
        # A helper that made its own session survives that and keeps the pipes, so after a timeout
        # nothing waits on the pipes again: they are closed and only the direct child is reaped.
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):  # gone already, or holding a member the runner may not signal
            p.kill()
        if exit_code == 'timeout':
            out, err = b'', b''
            p.stdout.close()
            p.stderr.close()
            p.wait()
        ms += int((time.time() - t0) * 1000)
        text = scrub(out.decode('utf-8', errors='replace'), run)[:20000]
        ok = exit_code == 0 and text.strip() != ''
        if first is None:
            first = {'ok': ok, 'exit': exit_code, 'err': err.decode('utf-8', errors='replace')[-2000:] or ('printed nothing' if exit_code == 0 else '')}
            if not ok:
                break
        if ok and text != last:
            frames.append([k, text])
            last = text
        # Claude Code re-runs a bar on every change; one that takes seconds per run is not a bar
        # that works there, and walking it through sixty ticks would take an hour. Its first
        # frame is kept and the timeline stops.
        if ms > SLOW_MS * (k + 1):
            break
    shutil.rmtree(run, ignore_errors=True)
    return {'first': first, 'frames': frames, 'ms': ms}


def in_own_process(slug, entry):
    """One project captured by a child runner, so a stall can be ended. A bar's helper that puts the
    runner into an uninterruptible wait cannot be escaped from inside; the child and its whole
    session are killed at the limit and the project is recorded as having stalled the runner."""
    out = os.path.join(RUNS, slug + '.json')
    child = subprocess.Popen([sys.executable, '-I', os.path.abspath(__file__), ENTRIES, FIXTURE, SRC, RUNS, out, slug],
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    try:
        _, err = child.communicate(timeout=PROJECT_TIMEOUT)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        for w in WIDTHS:
            shutil.rmtree(os.path.join(RUNS, '%s-%d' % (slug, w)), ignore_errors=True)
        return {'ok': False, 'ms': PROJECT_TIMEOUT * 1000, 'cmd': entry['cmd'], 'frames': {}, 'err': 'stalled the runner', 'exit': 'stalled'}
    if not os.path.exists(out):
        return {'ok': False, 'ms': 0, 'cmd': entry['cmd'], 'frames': {}, 'err': err.decode('utf-8', errors='replace')[-2000:], 'exit': 'runner-error'}
    rec = json.load(open(out))[slug]
    os.remove(out)
    return rec


entries = {k: v for k, v in json.load(open(ENTRIES)).items() if 'cmd' in v and (not ONLY or k in ONLY)}
captures = json.load(open(DEST)) if os.path.exists(DEST) and not ONLY else {}
os.makedirs(RUNS, exist_ok=True)
done = 0
# Given slugs, this process captures them itself; given none, it drives a child per project.
work = capture if ONLY else in_own_process
with cf.ThreadPoolExecutor(WORKERS) as pool:
    futures = {pool.submit(work, slug, e): slug for slug, e in entries.items()}
    for f in cf.as_completed(futures):
        slug = futures[f]
        captures[slug] = f.result()
        done += 1
        if done % 50 == 0 or ONLY:
            print(done, slug, 'ok' if captures[slug]['ok'] else captures[slug].get('exit'), flush=True)
            json.dump(captures, open(DEST, 'w'))
json.dump(captures, open(DEST, 'w'))
ok = sum(1 for c in captures.values() if c['ok'])
print('captured %d of %d' % (ok, len(captures)))
