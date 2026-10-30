"""Stamp every surveyed project with one risk tier, from a read of its statusline files.

    python3 -I triage.py <data.json> <measure.json> <src-root> <tiers.json>

A project lands in exactly one tier, least to most risky:

  skip       boring, or not a statusline: nothing worth rendering
  unlocated  the survey found no statusline file, so there is nothing to run
  safe       readable interpreted source with no signal below
  review     a legitimate-looking reach outside the sandbox (network, settings writes), for a reviewer
  risky      obfuscation, destruction, credentials, persistence, or compiled code we cannot read

Only the statusline files the survey identified are read (the code the harness would execute), not the
whole tree: a statusline inside a larger tool is judged on the statusline, not on the tool's website.
The output records the signals that put each project where it is, so a reviewer sees the evidence
rather than the verdict. This is a pure read of the files: it runs nothing. [LAW:effects-at-boundaries]
"""
import json, os, re, sys

DATA, MEASURE, SRC, DEST = sys.argv[1:5]

# File extensions the capture harness can run from source without a build step.
INTERPRETED = {'sh', 'bash', 'zsh', 'py', 'js', 'mjs', 'cjs', 'ts', 'mts', 'tsx', 'jsx', ''}
# Extensions that need a compiler or a runtime we will not read into: the binary is not the source.
COMPILED = {'go', 'rs', 'swift', 'cs', 'zig', 'c', 'h', 'cpp', 'hs', 'nim', 'java', 'kt', 'ps1', 'rb', 'lua', 'awk'}

# Each signal is (tier it forces, name, pattern). The worst tier among the signals that fire wins.
SIGNALS = [
    ('risky', 'obfuscation:base64-exec', re.compile(r'base64\s+(-d|--decode)\s*\|\s*(ba|z)?sh|atob\([^)]*\)\s*\)|exec\(\s*(base64|codecs|zlib|bytes\.fromhex)|Function\(\s*atob')),
    ('risky', 'obfuscation:eval', re.compile(r'(^|[^.\w])eval\s*\(\s*["\'$`(]', re.M)),
    ('risky', 'obfuscation:hex-blob', re.compile(r'(\\x[0-9a-fA-F]{2}){24,}')),
    ('risky', 'obfuscation:long-line', re.compile(r'^.{3000,}$', re.M)),
    ('risky', 'destructive:rm-rf-home', re.compile(r'rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+["\']?(~|\$HOME|/\s|/[a-z]+\s)')),
    ('risky', 'destructive:sudo', re.compile(r'^\s*(?:[\w=]+\s+)*sudo\s|(?:&&|\|\||;)\s*sudo\s', re.M)),
    ('risky', 'destructive:dd', re.compile(r'(^|[;&|\s])dd\s+if=', re.M)),
    ('risky', 'credentials:ssh-keys', re.compile(r'\.ssh/(id_|authorized|known)')),
    ('risky', 'credentials:keychain', re.compile(r'security\s+find-(generic|internet)-password\s+(?!-s\s+"Claude Code-credentials")|keytar|\.aws/credentials|\.netrc|\.npmrc|\.pypirc')),
    ('risky', 'credentials:token-exfil', re.compile(r'(ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_SECRET)[^\n]{0,80}(curl|fetch|http|post|send)', re.I)),
    ('risky', 'persistence:scheduler', re.compile(r'crontab\s|launchctl\s+(load|bootstrap)|systemctl\s+(enable|start)|LaunchAgents')),
    ('risky', 'pipe-to-shell', re.compile(r'(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh')),
    # Reading the Claude Code OAuth token from the keychain is how a statusline calls the usage API: common, and
    # inert in a sandbox with no keychain and no network, but still a credential read a reviewer should see.
    ('review', 'credentials:claude-oauth', re.compile(r'security\s+find-generic-password\s+-s\s+"Claude Code-credentials"|\.credentials\.json')),
    ('review', 'persistence:detach', re.compile(r'(^|[;&|\s])(nohup|setsid|disown)\s', re.M)),
    ('review', 'network', re.compile(r'(^|[;&|\s(])(curl|wget)\s|fetch\(|https?\.(get|request)\(|urllib\.request|requests\.(get|post)|net/http|reqwest|WebSocket|socket\.connect|axios|got\(|undici', re.M)),
    ('review', 'settings-write', re.compile(r'(>>?|writeFile\w*\(|open\([^)]*["\']w|write_text\(|fs\.write)[^\n]{0,120}(settings(\.local)?\.json|\.claude/)')),
    ('review', 'spawns-claude', re.compile(r'(^|[;&|\s(])claude\s+(-p|--print)', re.M)),
    ('review', 'reads-transcript-dir', re.compile(r'\.claude/projects')),
    ('review', 'cloud-cli', re.compile(r'(^|[;&|\s(])(gcloud|aws|az|kubectl|docker)\s', re.M)),
]
RANK = {'skip': 0, 'unlocated': 0, 'safe': 1, 'review': 2, 'risky': 3}


def ext(name):
    base = name.rsplit('/', 1)[-1]
    return base.rsplit('.', 1)[-1].lower() if '.' in base else ''


def scan(root, files):
    """One pass over the statusline files: the signals that fired, each with the file that fired it,
    and the language mix."""
    found, langs = {}, {}
    for rel in files:
        e = ext(rel)
        langs[e] = langs.get(e, 0) + 1
        text = open(os.path.join(root, rel), encoding='utf-8', errors='replace').read()
        for tier, name, rx in SIGNALS:
            if name not in found and rx.search(text):
                found[name] = (tier, rel)
    return found, langs


def tier_of(project, found, langs):
    if project['boring'] or project['kind'] == 'not a statusline':
        return 'skip'
    if not langs:
        return 'unlocated'
    tier = 'risky' if set(langs) & COMPILED and not set(langs) & (INTERPRETED - {''}) else 'safe'
    for t, _ in found.values():
        tier = max(tier, t, key=RANK.get)
    return tier


measure = json.load(open(MEASURE))
out, missing = {}, []
for p in json.load(open(DATA))['projects']:
    slug = re.sub(r'[^A-Za-z0-9._-]+', '__', p['repo'])
    root = os.path.join(SRC, slug)
    if not os.path.isdir(root):
        missing.append(p['repo'])
        continue
    files = [f for f, _ in measure.get(slug, {}).get('sl_files', []) if os.path.isfile(os.path.join(root, f))]
    found, langs = scan(root, files)
    out[slug] = {'repo': p['repo'], 'tier': tier_of(p, found, langs), 'files': files, 'langs': langs,
                 'signals': {k: v[1] for k, v in sorted(found.items())}}

json.dump(out, open(DEST, 'w'), indent=0)
counts = {}
for v in out.values():
    counts[v['tier']] = counts.get(v['tier'], 0) + 1
print('tiers:', counts)
print('no source tree:', len(missing), missing[:5])
