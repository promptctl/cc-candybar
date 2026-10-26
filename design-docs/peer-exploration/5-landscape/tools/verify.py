"""Grep a downloaded project's source for a pattern, printing file:line hits (read only).

usage: verify.py CHECKS   (each line: <slug>\t<regex>[\t<max>])
"""
import os, re, sys


def grep(slug, pat, cap):
    root = os.path.join('/tmp/ccland/src', slug)
    rx = re.compile(pat, re.I)
    n = 0
    print('==', slug, pat)
    for d, _, fs in os.walk(root):
        if '/.git' in d or 'node_modules' in d:
            continue
        for f in fs:
            p = os.path.join(d, f)
            try:
                if os.path.getsize(p) > 2_000_000:
                    continue
                for i, l in enumerate(open(p, errors='replace'), 1):
                    if rx.search(l):
                        print('  %s:%d: %s' % (os.path.relpath(p, root), i, l.strip()[:160]))
                        n += 1
                        if n >= cap:
                            return
            except OSError:
                pass
    if not n:
        print('  no hits; dir exists:', os.path.isdir(root))


for line in open(sys.argv[1]):
    if line.strip():
        parts = line.rstrip('\n').split('\t')
        grep(parts[0], parts[1], int(parts[2]) if len(parts) > 2 else 4)
