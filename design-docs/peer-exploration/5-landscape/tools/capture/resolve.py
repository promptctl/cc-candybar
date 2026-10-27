"""Decide how each safe-tier project is run: a shell command with its paths pointed into the
project tree, or a named reason there is none.

    python3 -I resolve.py <tiers.json> <src-root> <entries.json>

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


def resolve_cmd(cmd, by_base, preferred):
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
    e = ext(file)
    if e not in RUNTIME:
        return 'no-runtime'
    if out[0].strip('"') not in RUNNERS and e != '':
        out.insert(0, RUNTIME[e])
    elif out[0] == 'node' and e in ('ts', 'mts', 'tsx'):
        out[0] = 'bun'
    return ' '.join(out), file


def guess(files):
    for f in files:
        if NOT_A_STATUSLINE.search(f):
            continue
        if ext(f) in RUNTIME:
            return '%s "__PROJ__/%s"' % (RUNTIME[ext(f)], f), f
    return None


tiers = json.load(open(TIERS))
entries = {}
for slug, t in tiers.items():
    if t['tier'] != 'safe':
        continue
    root = os.path.join(SRC, slug)
    by_base = tree(root)
    preferred = set(t['files'])
    reasons = []
    chosen = None
    for cmd in declared(root):
        r = resolve_cmd(cmd, by_base, preferred)
        if isinstance(r, tuple):
            if chosen is None or (r[1] in preferred and chosen[1] not in preferred):
                chosen = r
        else:
            reasons.append(r)
    if chosen:
        entries[slug] = {'cmd': chosen[0], 'file': chosen[1], 'source': 'declared'}
        continue
    g = guess(t['files'])
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
