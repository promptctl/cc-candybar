"""The shapes of a credential, checked on every captured frame before it is published. A bar runs
on a real machine before it is sandboxed and scrubbed, and scrubbing knows only the user, host and
run path: a token it printed would ship in a public bundle. A hit is never redacted, because a
redacted frame hides that the sandbox let a secret through; export stops and names the project.

Run directly over committed bundles to check what is already published:
    python3 -I credentials.py ../explorer/public/bars/*.js
"""
import base64, gzip, json, math, re, sys
from collections import Counter

SHAPES = [
    ('Anthropic key or OAuth token', re.compile(r'sk-ant-[A-Za-z0-9_-]{16,}')),
    ('GitHub token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})')),
    ('AWS access key', re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b')),
    ('bearer token', re.compile(r'[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}')),
    ('JWT', re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}')),
    ('private key', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
]
# A long run of base64 or hex with near-random spread. Git object names (40 hex) are what a bar
# prints most, and they are public, so a hex run is a candidate only past that length. A slash is
# also a path separator, and paths are what bars print, so each segment between slashes is judged
# on its own: a token that happens to hold a slash is still caught by its longest segment.
LONG = re.compile(r'[A-Za-z0-9+_-]{32,}={0,2}|[0-9a-f]{48,}')
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]')


def entropy(s):
    n = len(s)
    return -sum(c / n * math.log2(c / n) for c in Counter(s).values())


def find(text):
    """Every credential-shaped string in text, as (kind, match)."""
    text = ANSI.sub('', text)
    hits = [(kind, m.group()) for kind, rx in SHAPES for m in rx.finditer(text)]
    for m in LONG.finditer(text):
        s = m.group()
        if re.fullmatch(r'[0-9a-f]{,47}', s):
            continue
        mixed = re.search(r'[a-z]', s) and re.search(r'[A-Z]', s) and re.search(r'\d', s)
        if (re.fullmatch(r'[0-9a-f]+', s) or mixed) and entropy(s) > (3.5 if re.fullmatch(r'[0-9a-f]+', s) else 4.5):
            hits.append(('high-entropy token', s))
    return hits


def check(by_repo):
    """Fails loudly, naming every project whose frames hold a credential shape."""
    bad = {}
    for repo, widths in by_repo.items():
        hits = {h for frames in widths.values() for _, f in frames for h in find(f)}
        if hits:
            bad[repo] = sorted(hits)
    if bad:
        lines = ['%s: %s %s' % (repo, kind, s[:12] + '…') for repo, hs in bad.items() for kind, s in hs]
        raise SystemExit('credential-shaped text in captured bars; nothing published:\n  ' + '\n  '.join(lines))


if __name__ == '__main__':
    for path in sys.argv[1:]:
        packed = re.search(r'"([A-Za-z0-9+/=]{100,})"', open(path).read()).group(1)
        try:
            check(json.loads(gzip.decompress(base64.b64decode(packed))))
        except SystemExit as e:
            raise SystemExit('%s\n%s' % (path, e))
    print('clean:', len(sys.argv) - 1, 'bundles')
