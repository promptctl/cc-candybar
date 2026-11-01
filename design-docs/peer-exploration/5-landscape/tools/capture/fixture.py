"""Build the fake session every statusline is shown, as a 120-second timeline: one directory per
tick, each holding the hook JSON, the transcript so far, and the project tree as it stands.

    python3 -I fixture.py <fixture-dir>

The window opens on a session already forty minutes old, so the figures are those of real work.
Over two minutes: a prompt arrives, a turn reads and edits files while context and cost climb,
a commit lands and a pull request appears, the tests fail and then pass, a compact drops the
context, and a short final turn closes the loop. Claude Code re-runs a statusline on events,
not on a clock, so the hook data only changes at those events; the ticks between them are what a
script with its own refresh timer sees.

Paths inside the hook JSON and the transcript are written with the token __RUN__, which the runner
replaces with the run copy's real path. One timeline for every project [LAW:one-source-of-truth]:
what differs between captures is the statusline, never the session it sees.
"""
import json, os, shutil, stat, subprocess, sys, time

ROOT = sys.argv[1]
TICK, TICKS = 2, 60  # seconds per tick, ticks per loop
SESSION = '7f3a9c2e-5b1d-4e8a-9f6c-2d4b8a1e3c5f'
PROJECT = '__RUN__/work/candybar-demo'
HOME = '__RUN__/home'
TRANSCRIPT = HOME + '/.claude/projects/-__RUN__-work-candybar-demo/' + SESSION + '.jsonl'
WINDOW = 200_000
AGE = 40 * 60  # seconds the session has been running when the window opens

shutil.rmtree(ROOT, ignore_errors=True)
os.makedirs(ROOT)


def write(root, rel, text, exe=False):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write(text)
    if exe:
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)


# ---- the conversation: every event the session sees, at the second it happens ------------------
# kind: prompt | text | tool | result | commit | compact. Token figures are the context after the call.
# ctx is cache_read + cache_create + input; out is output tokens; cost is the running total.
EVENTS = [
    (0,   'prompt',  'Add a lens that grows labels near the cursor'),
    (3,   'text',    'I will add a lens: labels within a fixed distance of the cursor grow toward full size.', 116_200, 90, 3.91),
    (5,   'tool',    'Read', {'file_path': PROJECT + '/src/graph.ts'}),
    (6,   'result',  'export function layout(n: number) {\n  return n * 5;\n}\n'),
    (9,   'text',    'The force simulation owns positions, so the lens belongs in the tick.', 123_900, 140, 3.98),
    (11,  'tool',    'Edit', {'file_path': PROJECT + '/src/graph.ts', 'old_string': 'return n * 5;', 'new_string': 'return n * 5 + lens(n);'}),
    (12,  'result',  'The file has been updated.'),
    (15,  'tool',    'Write', {'file_path': PROJECT + '/src/lens.ts', 'content': 'export const LENS = 600;\nexport const lens = (n: number) => Math.min(LENS, n);\n'}),
    (16,  'result',  'File created successfully.'),
    (20,  'text',    'Both files are in. Running the tests.', 141_300, 410, 4.12),
    (22,  'tool',    'Bash', {'command': 'pnpm test', 'description': 'Run the test suite'}),
    (27,  'result',  'FAIL test/graph.test.ts > layout grows near the cursor\n  expected 11, received 10\n\n13 passed, 1 failed'),
    (31,  'text',    'One test expects the lens to add one at the edge. Fixing the boundary.', 152_800, 520, 4.19),
    (33,  'tool',    'Edit', {'file_path': PROJECT + '/src/lens.ts', 'old_string': 'Math.min(LENS, n)', 'new_string': 'Math.min(LENS, n) + 1'}),
    (34,  'result',  'The file has been updated.'),
    (36,  'tool',    'Bash', {'command': 'pnpm test', 'description': 'Run the test suite'}),
    (41,  'result',  '14 passed'),
    (44,  'text',    'All 14 tests pass. Committing.', 160_100, 610, 4.24),
    (46,  'tool',    'Bash', {'command': 'git add -A && git commit -m "Add the lens"', 'description': 'Commit the lens'}),
    (48,  'commit',  'Add the lens'),
    (48,  'result',  '[feature/graph-lens 9c1e2f4] Add the lens\n 2 files changed, 5 insertions(+), 1 deletion(-)'),
    (52,  'text',    'Committed on feature/graph-lens. The branch is one ahead of origin.', 166_400, 660, 4.28),
    (58,  'prompt',  'The labels overlap each other. Make them push each other apart'),
    (61,  'text',    'Labels can join the simulation as boxes that repel along the axis with less overlap.', 172_900, 720, 4.33),
    (63,  'tool',    'Read', {'file_path': PROJECT + '/src/graph.ts'}),
    (64,  'result',  'export function layout(n: number) {\n  return n * 5 + lens(n);\n}\n'),
    (68,  'tool',    'Edit', {'file_path': PROJECT + '/src/graph.ts', 'old_string': 'return n * 5 + lens(n);', 'new_string': 'return n * 5 + lens(n) + push(n);'}),
    (69,  'result',  'The file has been updated.'),
    (74,  'text',    'The push force is in. Context is getting full, so I will compact before the next step.', 181_600, 830, 4.41),
    (80,  'compact', 'Graph lens and label overlap: the lens grows labels within 600px of the cursor; a push force in src/graph.ts separates overlapping labels; 14 tests pass; one commit on feature/graph-lens.'),
    (84,  'text',    'Compacted. Running the tests on the push force.', 46_800, 60, 4.43),
    (86,  'tool',    'Bash', {'command': 'pnpm test', 'description': 'Run the test suite'}),
    (91,  'result',  '14 passed'),
    (95,  'text',    'All green. Labels now push each other apart and the lens still works.', 52_200, 170, 4.46),
    (104, 'prompt',  'Great, push it'),
    (107, 'tool',    'Bash', {'command': 'git push', 'description': 'Push the branch'}),
    (110, 'result',  'To github.com:acme/candybar-demo.git\n   3b2a1c0..9c1e2f4  feature/graph-lens -> feature/graph-lens'),
    (114, 'text',    'Pushed. PR #438 is up to date with the branch.', 57_900, 230, 4.49),
]
LINES = {0: (156, 23), 11: (157, 24), 15: (159, 24), 33: (159, 24), 68: (160, 24)}  # lines added/removed after an edit


def before(t):
    return [e for e in EVENTS if e[0] <= t]


def state(t):
    """The session as the hook JSON describes it at second t of the window."""
    ev = before(t)
    texts = [e for e in ev if e[1] == 'text']
    ctx, out, cost = (texts[-1][3], texts[-1][4], texts[-1][5]) if texts else (112_400, 1280, 3.89)
    prompts = [e for e in ev if e[1] == 'prompt']
    committed = any(e[1] == 'commit' for e in ev)
    lines = LINES[max(k for k in LINES if k <= t)]
    compacted = any(e[1] == 'compact' for e in ev)
    cache_read = int(ctx * (0.3 if compacted and t < 84 else 0.95))
    now = int(time.time())
    return {
        'hook_event_name': 'Status', 'session_id': SESSION, 'session_name': 'graph lens',
        'prompt_id': '550e8400-e29b-41d4-a716-%012d' % (440000 + len(prompts)),
        'transcript_path': TRANSCRIPT, 'cwd': PROJECT,
        'model': {'id': 'claude-opus-5-5', 'display_name': 'Opus'},
        'workspace': {'current_dir': PROJECT, 'project_dir': PROJECT, 'added_dirs': [],
                      'repo': {'host': 'github.com', 'owner': 'acme', 'name': 'candybar-demo'}},
        'version': '2.1.90', 'output_style': {'name': 'default'},
        'cost': {'total_cost_usd': round(cost, 4), 'total_duration_ms': (AGE + t) * 1000,
                 'total_api_duration_ms': int((AGE + t) * 1000 * 0.16), 'total_lines_added': lines[0], 'total_lines_removed': lines[1]},
        'context_window': {'total_input_tokens': ctx, 'total_output_tokens': 9800 + sum(e[4] for e in texts),
                           'context_window_size': WINDOW, 'used_percentage': round(100 * ctx / WINDOW),
                           'remaining_percentage': 100 - round(100 * ctx / WINDOW),
                           'current_usage': {'input_tokens': ctx - cache_read - 2440, 'output_tokens': out,
                                             'cache_creation_input_tokens': 2440, 'cache_read_input_tokens': cache_read}},
        'exceeds_200k_tokens': False,
        'prompt_cache': {'warm': True, 'caching_observed': True, 'ttl': '1h', 'expires_at': now + 3100, 'requests': 14 + len(texts),
                         'misses': 2 + int(compacted), 'expected_rebuilds': 1, 'hit_ratio': 0.91, 'cache_write_tokens': 352000,
                         'miss_recache_tokens': 310200, 'last_miss_at': now - 2400,
                         'last_miss_cause': {'causes': ['tools_changed'], 'tools_added': 2, 'tools_removed': 0},
                         'miss_causes': {'tools_changed': 2}, 'recache_tokens_if_cold': 45000},
        'fast_mode': False, 'effort': {'level': 'high'}, 'thinking': {'enabled': True},
        'rate_limits': {'five_hour': {'used_percentage': round(23.5 + t * 0.02, 1), 'resets_at': now + 7200 - t},
                        'seven_day': {'used_percentage': round(41.2 + t * 0.005, 1), 'resets_at': now + 3 * 86400 + 1800 - t}},
        'vim': {'mode': 'NORMAL'},
        'pr': {'number': 438, 'url': 'https://github.com/acme/candybar-demo/pull/438', 'review_state': 'pending'},
    }, committed


def transcript(t):
    """The transcript as written up to second t, in Claude Code's JSONL shape."""
    now = int(time.time())
    base = lambda i, kind: {'parentUuid': None if i == 0 else 'u%03d' % (i - 1), 'isSidechain': False, 'userType': 'external',
                            'cwd': PROJECT, 'sessionId': SESSION, 'version': '2.1.90', 'gitBranch': 'feature/graph-lens',
                            'uuid': 'u%03d' % i, 'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(now - (t - EVENTS[i][0]) if i < len(EVENTS) else now)), 'type': kind}
    lines = [json.dumps({'type': 'summary', 'summary': 'Graph lens and label overlap', 'leafUuid': 'u%03d' % (len(EVENTS) - 1)})]
    pending_tool = None
    for i, e in enumerate(before(t)):
        at, kind = e[0], e[1]
        if kind == 'prompt':
            d = base(i, 'user'); d['message'] = {'role': 'user', 'content': e[2]}
        elif kind == 'text':
            d = base(i, 'assistant'); d['requestId'] = 'req_%03d' % i
            cache_read = int(e[3] * 0.95)
            d['message'] = {'id': 'msg_%03d' % i, 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5-5',
                            'content': [{'type': 'text', 'text': e[2]}], 'stop_reason': 'end_turn',
                            'usage': {'input_tokens': e[3] - cache_read - 2440, 'cache_creation_input_tokens': 2440,
                                      'cache_read_input_tokens': cache_read, 'output_tokens': e[4], 'service_tier': 'standard'}}
        elif kind == 'tool':
            d = base(i, 'assistant'); d['requestId'] = 'req_%03d' % i
            pending_tool = 'toolu_%03d' % i
            d['message'] = {'id': 'msg_%03d' % i, 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5-5',
                            'content': [{'type': 'tool_use', 'id': pending_tool, 'name': e[2], 'input': e[3]}], 'stop_reason': 'tool_use',
                            'usage': {'input_tokens': 900, 'cache_creation_input_tokens': 600, 'cache_read_input_tokens': 110_000, 'output_tokens': 80, 'service_tier': 'standard'}}
        elif kind == 'result':
            d = base(i, 'user')
            d['message'] = {'role': 'user', 'content': [{'tool_use_id': pending_tool, 'type': 'tool_result', 'content': e[2]}]}
            d['toolUseResult'] = {'stdout': e[2], 'stderr': '', 'interrupted': False}
        elif kind == 'compact':
            d = base(i, 'summary'); d['summary'] = e[2]; d['isCompactSummary'] = True
        else:
            continue
        lines.append(json.dumps(d))
    return '\n'.join(lines) + '\n'


# ---- the project tree: a git repository on a feature branch, changing as the edits land -------------
BASE = os.path.join(ROOT, 'base')
proj = os.path.join(BASE, 'work', 'candybar-demo')
os.makedirs(proj)
env = dict(os.environ, GIT_AUTHOR_DATE='2026-10-20T10:00:00Z', GIT_COMMITTER_DATE='2026-10-20T10:00:00Z',
           GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null', HOME=BASE)


def git(cwd, *a):
    subprocess.run(['git', *a], cwd=cwd, env=env, check=True, capture_output=True)


git(proj, 'init', '-q', '-b', 'main')
git(proj, 'config', 'user.email', 'dev@example.com')
git(proj, 'config', 'user.name', 'Dev')
git(proj, 'remote', 'add', 'origin', 'git@github.com:acme/candybar-demo.git')
write(BASE, 'work/candybar-demo/README.md', '# candybar-demo\n\nA small project to show a statusline against.\n')
write(BASE, 'work/candybar-demo/package.json', json.dumps({'name': 'candybar-demo', 'version': '1.4.2', 'scripts': {'test': 'vitest'}}, indent=2) + '\n')
write(BASE, 'work/candybar-demo/src/index.ts', 'export const greet = (name: string) => `hello ${name}`;\n')
write(BASE, 'work/candybar-demo/src/graph.ts', 'export function layout(n: number) {\n  return n * 2;\n}\n')
write(BASE, 'work/candybar-demo/.gitignore', 'node_modules\ndist\n')
git(proj, 'add', '-A')
git(proj, 'commit', '-q', '-m', 'Initial commit')
for i, msg in enumerate(['Add graph layout', 'Wire the simulation', 'Fix label overlap'], 1):
    write(BASE, 'work/candybar-demo/src/graph.ts', 'export function layout(n: number) {\n  return n * %d;\n}\n' % (i + 2))
    env['GIT_AUTHOR_DATE'] = env['GIT_COMMITTER_DATE'] = '2026-10-2%dT10:00:00Z' % (i + 1)
    git(proj, 'commit', '-q', '-am', msg)
git(proj, 'checkout', '-q', '-b', 'feature/graph-lens')
write(BASE, 'work/candybar-demo/src/index.ts', 'export const greet = (name: string) => `hello, ${name}!`;\n')
git(proj, 'commit', '-q', '-am', 'Greet with punctuation')
git(proj, 'update-ref', 'refs/remotes/origin/feature/graph-lens', 'HEAD')
git(proj, 'update-ref', 'refs/remotes/origin/main', 'main')
git(proj, 'branch', '-q', '--set-upstream-to=origin/feature/graph-lens')
shutil.rmtree(os.path.join(proj, '.git', 'hooks'))
# the home: a Claude config directory with settings
write(BASE, 'home/.claude/settings.json', json.dumps({'statusLine': {'type': 'command', 'command': 'statusline'}, 'model': 'opus'}, indent=2) + '\n')
write(BASE, 'home/.claude.json', json.dumps({'numStartups': 42, 'oauthAccount': {'emailAddress': 'dev@example.com', 'organizationName': 'Acme'}}, indent=2) + '\n')
write(BASE, 'home/.gitconfig', '[user]\n\tname = Dev\n\temail = dev@example.com\n')
# The real git binary, ahead of Apple's xcrun shim on the PATH: the shim consults the user's temp
# directory, which the sandbox refuses, and stalls a second on every call.
os.makedirs(os.path.join(BASE, 'bin'))
os.symlink(os.path.realpath(subprocess.check_output(['xcrun', '--find', 'git'], text=True).strip()), os.path.join(BASE, 'bin', 'git'))
# Stub tools a statusline shells out to. Each prints a fixed, plausible answer; none reach the network.
write(BASE, 'bin/ccusage', '#!/bin/bash\n# stub: fixed usage figures, any subcommand\ncat <<EOF\n{"blocks":[{"id":"2026-10-27T11:00:00.000Z","startTime":"2026-10-27T11:00:00.000Z","endTime":"2026-10-27T16:00:00.000Z","isActive":true,"totalTokens":184320,"costUSD":4.37,"burnRate":{"tokensPerMinute":614,"costPerHour":1.46},"projection":{"totalTokens":368000,"totalCost":8.74,"remainingMinutes":212}}],"daily":[{"date":"2026-10-27","totalTokens":184320,"totalCost":4.37}],"totals":{"totalTokens":184320,"totalCost":4.37}}\nEOF\n', exe=True)
write(BASE, 'bin/gh', '#!/bin/bash\n# stub: one open PR for the branch; auth status succeeds\ncase "$1 $2" in\n  "pr list"|"pr view"|"pr status") echo \'[{"number":438,"title":"Survey: statusline landscape explorer","state":"OPEN","url":"https://github.com/acme/candybar-demo/pull/438","reviewDecision":"REVIEW_REQUIRED","isDraft":false,"headRefName":"feature/graph-lens"}]\' ;;\n  "auth status") echo "Logged in to github.com account dev" >&2 ;;\n  "api "*) echo \'{"login":"dev"}\' ;;\n  *) echo "gh: stub" >&2; exit 1 ;;\nesac\n', exe=True)
write(BASE, 'bin/claude', '#!/bin/bash\n# stub: the claude CLI is not available inside a capture\necho "claude: not available in capture" >&2\nexit 1\n', exe=True)
write(BASE, 'bin/tmux', '#!/bin/bash\n# stub: no tmux server inside a capture\necho "no server running" >&2\nexit 1\n', exe=True)

# ---- one directory per tick: the tree as the edits leave it, the transcript so far, the hook -------
for k in range(TICKS):
    t = k * TICK
    tick = os.path.join(ROOT, 'tick', '%02d' % k)
    os.makedirs(tick)
    shutil.copytree(os.path.join(BASE, 'work'), os.path.join(tick, 'work'), symlinks=True)
    p = os.path.join(tick, 'work', 'candybar-demo')
    done = {e[0]: e for e in before(t) if e[1] in ('tool', 'commit')}
    if t >= 11:
        write(tick, 'work/candybar-demo/src/graph.ts', 'export function layout(n: number) {\n  return n * 5 + lens(n);\n}\n')
    if t >= 15:
        write(tick, 'work/candybar-demo/src/lens.ts', 'export const LENS = 600;\nexport const lens = (n: number) => Math.min(LENS, n);\n')
    if t >= 33:
        write(tick, 'work/candybar-demo/src/lens.ts', 'export const LENS = 600;\nexport const lens = (n: number) => Math.min(LENS, n) + 1;\n')
    if t >= 48:
        git(p, 'add', '-A')
        env['GIT_AUTHOR_DATE'] = env['GIT_COMMITTER_DATE'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - (t - 48)))
        git(p, 'commit', '-q', '-m', 'Add the lens')
    if t >= 68:
        write(tick, 'work/candybar-demo/src/graph.ts', 'export function layout(n: number) {\n  return n * 5 + lens(n) + push(n);\n}\n')
    if t >= 110:
        git(p, 'update-ref', 'refs/remotes/origin/feature/graph-lens', 'HEAD')
    write(tick, 'work/candybar-demo/notes.md', 'todo: push labels apart\n')
    hook, _ = state(t)
    write(tick, 'hook.json', json.dumps(hook, indent=2) + '\n')
    write(tick, TRANSCRIPT.replace(HOME, 'home'), transcript(t))
print('fixture at', ROOT, 'ticks', TICKS, 'every', TICK, 's')
