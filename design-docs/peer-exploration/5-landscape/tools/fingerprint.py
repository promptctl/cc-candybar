"""Measure each downloaded project and find shared code across them (MOSS-style winnowing).

Outputs measure.json (or the path in argv[1]): per slug, repo source LOC, statusline-file LOC, the
statusline files, the projects it shares most code with, and its overlap with the
Claude Code docs examples.
"""
import json, os, re, sys, hashlib
from collections import defaultdict

SRC = '/tmp/ccland/src'
CODE = re.compile(r'\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|tsx|jsx|mts|cts|go|rs|rb|lua|ps1|psm1|swift|kt|java|c|cc|cpp|h|hpp|zig|nu|pl|php|ex|exs|hs|dart|cs|scala|clj|nim|cr|v|odin|jl|r|awk)$', re.I)
SHEBANG = re.compile(rb'^#!.*\b(sh|bash|zsh|python3?|node|bun|deno|ruby|perl|fish)\b')
MARK = re.compile(r'display_name|transcript_path|context_window|total_cost_usd|used_percentage|current_dir|workspace\.|rate_limits|exceeds_200k')
NAMED = re.compile(r'status.?line|statusbar|status.?bar', re.I)
TESTY = re.compile(r'(^|/)(tests?|__tests__|spec|e2e|fixtures?|examples?|docs?|benchmarks?)(/|$)|\.(test|spec)\.', re.I)
TOK = re.compile(r'[A-Za-z_][A-Za-z0-9_]*|\d+|[^\sA-Za-z0-9_]')
K, W = 15, 8


def is_code(path, head):
    return bool(CODE.search(path)) or bool(SHEBANG.match(head))


def norm_lines(text):
    out = []
    for l in text.splitlines():
        s = l.strip()
        if not s or s.startswith(('#', '//', '/*', '*', '--')) and not s.startswith('#!'):
            continue
        out.append(s)
    return out


def fingerprints(lines):
    toks = [t.lower() for l in lines for t in TOK.findall(l)]
    hs = [int.from_bytes(hashlib.blake2b(' '.join(toks[i:i + K]).encode(), digest_size=8).digest(), 'big')
          for i in range(len(toks) - K + 1)]
    fp = set()
    for i in range(max(1, len(hs) - W + 1)):
        win = hs[i:i + W]
        if win:
            fp.add(min(win))
    return fp


def scan(slug):
    root = os.path.join(SRC, slug)
    repo_loc, sl_loc, sl_files, fp = 0, 0, [], set()
    for dp, dn, fn in os.walk(root):
        for f in fn:
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, root)
            if rel == '.done':
                continue
            try:
                b = open(p, 'rb').read()
            except OSError:
                continue
            if not is_code(rel, b[:120]):
                continue
            t = b.decode('utf-8', 'replace')
            lines = norm_lines(t)
            if not TESTY.search(rel):
                repo_loc += len(lines)
            named = bool(NAMED.search(rel))
            marks = len(set(MARK.findall(t)))
            if (named or marks >= 2) and not TESTY.search(rel):
                sl_loc += len(lines)
                sl_files.append((rel, len(lines), named, marks))
                fp |= fingerprints(lines)
    sl_files.sort(key=lambda x: (not x[2], -x[3], -x[1]))
    return dict(repo_loc=repo_loc, sl_loc=sl_loc, sl_files=[(r, n) for r, n, _, _ in sl_files[:15]],
                n_sl_files=len(sl_files)), fp


def docs_fp():
    t = open('/tmp/ccland/ref/statusline-docs.md').read()
    blocks = re.findall(r'```(\w+)?[^\n]*\n(.*?)```', t, re.S)
    fp = set()
    for lang, body in blocks:
        if lang in ('bash', 'sh', 'python', 'javascript', 'js', 'ts', 'typescript', 'powershell', 'ps1', None, ''):
            fp |= fingerprints(norm_lines(body))
    return fp


slugs = sorted(d for d in os.listdir(SRC) if os.path.exists(os.path.join(SRC, d, '.done')))
meas, fps = {}, {}
for s in slugs:
    meas[s], fps[s] = scan(s)
dfp = docs_fp()
index = defaultdict(set)
for s, fp in fps.items():
    for h in fp:
        index[h].add(s)
for s, fp in fps.items():
    m = meas[s]
    m['n_fp'] = len(fp)
    m['docs_overlap'] = round(len(fp & dfp) / len(fp), 2) if fp else 0
    shared = defaultdict(int)
    for h in fp:
        for o in index[h]:
            if o != s:
                shared[o] += 1
    rel = []
    for o, n in shared.items():
        mn = min(len(fp), len(fps[o]))
        if n >= 25 and mn and n / mn >= 0.3:
            rel.append((o, n, round(n / len(fp), 2), round(n / len(fps[o]), 2)))
    rel.sort(key=lambda x: -x[1])
    m['shares'] = rel[:10]
json.dump(meas, open(sys.argv[1] if len(sys.argv) > 1 else '/tmp/ccland/measure.json', 'w'))
print(len(meas), 'projects measured', file=sys.stderr)
