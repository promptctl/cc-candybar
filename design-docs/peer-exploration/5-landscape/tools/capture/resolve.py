"""Decide how each project of the named tiers is run: a shell command with its paths pointed
into the project tree, or a named reason there is none.

    python3 -I resolve.py <tiers.json> <src-root> <entries.json> <tier> [tier ...]

The review tier's signals (network, transcripts, Claude's credentials file, settings writes,
spawning claude) are each contained by the runner's sandbox and fake home, so it runs the same
way the safe tier does. The risky tier is not resolved here: its code was not read.

An entry is one of two shapes, never both [LAW:parse-dont-validate]:
  {"cmd": "<shell>", "file": "<repo-relative>", "source": "declared" | "guessed"}
  {"reason": "needs-network" | "no-runtime" | "no-file" | "placeholder-only"}

The command text uses the token __PROJ__ for the project copy; the runner substitutes it.

Declared commands come from any statusLine block in the tree (settings, plugin manifests, READMEs).
Authors write them with their own absolute paths, so each path-like word is replaced by the repo
file that shares its basename. A command naming a package to download is not runnable offline.
When nothing is declared, the survey's top statusline file is run under the runtime its extension
names, and the entry says so.
"""
import json, os, re, sys

TIERS, SRC, DEST = sys.argv[1:4]
RUN_TIERS = set(sys.argv[4:])

DECLARED = re.compile(r'"statusLine"\s*:\s*\{[^{}]*?"command"\s*:\s*"((?:[^"\\]|\\.)*)"', re.S)
SKIP_DIR = {'node_modules', '.git', 'dist', 'build', 'target', 'coverage'}
RUNTIME = {'sh': 'bash', 'bash': 'bash', 'zsh': 'zsh', '': 'bash', 'py': 'python3', 'js': 'node', 'mjs': 'node',
           'cjs': 'node', 'ts': 'bun', 'mts': 'bun', 'tsx': 'bun'}
RUNNERS = {'bash', 'sh', 'zsh', 'node', 'bun', 'python', 'python3', 'deno', 'tsx', 'ts-node'}
NOT_A_STATUSLINE = re.compile(r'(^|[/_.-])(test|tests|spec|install|uninstall|setup|configure|build|bench)([/_.-]|$)', re.I)
UNQUOTE = re.compile(r'\\(.)')


def ext(name):
    base = name.rsplit('/', 1)[-1]
    return base.rsplit('.', 1)[-1].lower() if '.' in base else ''


def tree(root):
    """Every file in the project, by basename: the lookup a declared path is resolved against."""
    by_base = {}
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIR]
        for f in files:
            by_base.setdefault(f, []).append(os.path.relpath(os.path.join(d, f), root))
    return by_base


def declared(root):
    out = []
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIR]
        for f in files:
            if f.endswith(('.json', '.json5', '.md', '.jsonc')) and os.path.getsize(os.path.join(d, f)) < 400_000:
                text = open(os.path.join(d, f), encoding='utf-8', errors='replace').read()
                out += [UNQUOTE.sub(r'\1', m.group(1)) for m in DECLARED.finditer(text)]
    return out


def resolve_cmd(root, cmd, by_base, preferred):
    """Rewrite one declared command against the tree. Returns (cmd, file) or a reason."""
    if re.search(r'(^|\s)(npx|bunx|uvx|pipx)\s', cmd):
        return 'needs-network'
    if re.search(r'(^|\s)(powershell|pwsh|cmd|go|cargo)\s', cmd):
        return 'no-runtime'
    cmd = cmd.replace('${CLAUDE_PLUGIN_ROOT}', '__PROJ__').replace('$CLAUDE_PLUGIN_ROOT', '__PROJ__')
    cmd = re.sub(r'\$\{CLAUDE_CONFIG_DIR:-\$HOME/\.claude\}', '~/.claude', cmd)
    words = cmd.split()
    file = None
    out = []
    for i, w in enumerate(words):
        bare = w.strip('"\'')
        if '/' in bare or '\\' in bare or (i == 0 and bare not in RUNNERS):
            base = re.split(r'[/\\]', bare)[-1]
            hits = by_base.get(base, [])
            hits = [h for h in hits if h in preferred] or hits
            if not hits:
                if bare.startswith('__PROJ__'):
                    return 'no-file'
                if i == 0 and '/' not in bare:
                    return 'no-file'
                out.append(w)
                continue
            rel = hits[0]
            if file is None:
                file = rel
            out.append('"__PROJ__/%s"' % rel)
        else:
            out.append(w)
    if file is None:
        return 'placeholder-only'
    # An author who named a runner chose it; only a TypeScript file under node moves to bun. A bare
    # file is run the way launch says.
    at = next((i for i, w in enumerate(out) if w == '"__PROJ__/%s"' % file), None)
    if at is None:  # the file sits inside a quoted shell string; it is left as the author wrote it
        return ' '.join(out), file
    if any(w.strip('"\'') in RUNNERS for w in out[:at]):
        if out[0] == 'node' and ext(file) in ('ts', 'mts', 'tsx'):
            out[0] = 'bun'
        if out[0] in ('python3', 'python') and os.path.exists(os.path.join(root, '.ccland-venv/bin/python3')):
            out[0] = '"__PROJ__/.ccland-venv/bin/python3"'
        return ' '.join(out), file
    how = launch(root, file)
    if how is None:
        return 'no-runtime'
    return ' '.join(out[:at] + [how] + out[at + 1:]), file


def launch(root, file):
    """How one file is run: under the runtime its extension or shebang names, and a module inside a
    Python package as that module, so its relative imports resolve. None when nothing here runs it."""
    e = ext(file)
    if e == 'py':
        # the venv deps.py made, when it made one, so the project's imports resolve
        python = '"__PROJ__/.ccland-venv/bin/python3"' if os.path.exists(os.path.join(root, '.ccland-venv/bin/python3')) else 'python3'
        d, parts = os.path.dirname(file), []
        while d and os.path.exists(os.path.join(root, d, '__init__.py')):
            parts.insert(0, os.path.basename(d))
            d = os.path.dirname(d)
        if parts:
            return 'PYTHONPATH="__PROJ__/%s" %s -m %s' % (d, python, '.'.join(parts + [os.path.basename(file)[:-3]]))
        return '%s "__PROJ__/%s"' % (python, file)
    if e and e in RUNTIME:
        return '%s "__PROJ__/%s"' % (RUNTIME[e], file)
    with open(os.path.join(root, file), 'rb') as fh:
        head = fh.read(120).split(b'\n')[0]
    if head.startswith(b'#!'):
        words = head[2:].decode(errors='replace').split()
        name = os.path.basename(words[-1] if words and words[0].endswith('env') else words[0]) if words else ''
        if name in RUNNERS:
            return '%s "__PROJ__/%s"' % (name, file)
    return None


READS_STDIN = re.compile(r'stdin|readFileSync\(\s*0|\bread\s+-r|\bjq\b|\bcat\b')
STATUSLINE_NAME = re.compile(r'(^|/)[^/]*status[-_]?line[^/]*\.[^/]+$', re.I)
ENTRY_NAME = re.compile(r'(^|/)(index|main|cli|status)\.[^/]+$', re.I)
NOT_ENTRY = re.compile(r'(^|/)(types?|schemas?|config|utils?|helpers?|constants|interfaces|formatters?|stdin|payload|render(er)?)\.[^/]+$', re.I)


BUILT = re.compile(r'(^|/)(dist|build|lib|out)/(.*)\.(c|m)?js$')


def manifest_entries(root, file):
    """What the package.json nearest the survey's file names as its entry, with the weight it earns:
    a bin is what the author runs, a main may be a library's API. A built path that is absent, as in
    a checkout nobody built, is tried as its source under src/."""
    d = os.path.dirname(file)
    while True:
        pj = os.path.join(root, d, 'package.json')
        if os.path.exists(pj):
            break
        if not d:
            return {}
        d = os.path.dirname(d)
    try:
        m = json.load(open(pj, encoding='utf-8', errors='replace'))
    except ValueError:
        return {}
    bins = m.get('bin')
    named = [(b, 2) for b in ([bins] if isinstance(bins, str) else list(bins.values()) if isinstance(bins, dict) else [])] + [(m.get("main") or "", 1)]
    out = {}
    for n, weight in named:
        if not isinstance(n, str) or not n:
            continue
        rel = os.path.normpath(os.path.join(d, n))
        if os.path.isfile(os.path.join(root, rel)):
            out.setdefault(rel, weight)
            continue
        built = BUILT.search(n)
        if built:
            for src in ('src/%s.ts' % built.group(3), 'src/%s.tsx' % built.group(3), 'src/%s.mts' % built.group(3)):
                srel = os.path.normpath(os.path.join(d, src))
                if os.path.isfile(os.path.join(root, srel)):
                    out.setdefault(srel, weight)
                    break
    return out


def guess(root, files):
    """The survey's files for a project, ranked by how much each looks like the entry: the one that
    reads stdin and is named like one, not a types or helpers module. The survey's own order breaks ties.
    A package manifest's bin or main is the fallback: it beats a file with nothing going for it."""
    best = None
    declared = {f: w for f, w in manifest_entries(root, files[0]).items() if ext(f) in ('js', 'mjs', 'cjs', 'ts', 'tsx', 'mts')} if files else {}
    for rank, f in enumerate(list(declared) + list(files)):
        if NOT_A_STATUSLINE.search(f) or f.endswith('.d.ts') or not os.path.isfile(os.path.join(root, f)):
            continue
        how = launch(root, f)
        if how is None:
            continue
        text = open(os.path.join(root, f), encoding='utf-8', errors='replace').read(200_000)
        score = 3 * bool(READS_STDIN.search(text)) + (6 if STATUSLINE_NAME.search(f) else 3 if ENTRY_NAME.search(f) else 0) - 3 * bool(NOT_ENTRY.search(f)) - rank + declared.get(f, 0)
        if best is None or score > best[0]:
            best = (score, how, f)
    return best and best[1:]


tiers = json.load(open(TIERS))
entries = {}
for slug, t in tiers.items():
    if t['tier'] not in RUN_TIERS:
        continue
    root = os.path.join(SRC, slug)
    by_base = tree(root)
    preferred = set(t['files'])
    reasons = []
    chosen = None
    for cmd in declared(root):
        r = resolve_cmd(root, cmd, by_base, preferred)
        if isinstance(r, tuple):
            if chosen is None or (r[1] in preferred and chosen[1] not in preferred):
                chosen = r
        else:
            reasons.append(r)
    if chosen:
        entries[slug] = {'cmd': chosen[0], 'file': chosen[1], 'source': 'declared'}
        continue
    g = guess(root, t["files"])
    if g:
        entries[slug] = {'cmd': g[0], 'file': g[1], 'source': 'guessed'}
    else:
        entries[slug] = {'reason': reasons[0] if reasons else 'no-file'}

json.dump(entries, open(DEST, 'w'), indent=0)
counts = {}
for e in entries.values():
    k = e.get('source') or e['reason']
    counts[k] = counts.get(k, 0) + 1
print('entries:', counts)
