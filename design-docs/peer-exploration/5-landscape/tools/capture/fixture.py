"""Build the fake session every statusline is shown: a home with a Claude config directory and a
transcript, a project that is a small git repository mid-change, stub tools, and the hook JSON.

    python3 -I fixture.py <fixture-dir>

The runner copies this directory once per capture, so a statusline can scribble on it freely. Paths
inside the hook JSON and the transcript are written with the token __RUN__, which the runner
replaces with the copy's real path. One fixture for every project [LAW:one-source-of-truth]: what
differs between captures is the statusline, never the session it sees.
"""
import json, os, shutil, stat, subprocess, sys, time

ROOT = sys.argv[1]
SESSION = '7f3a9c2e-5b1d-4e8a-9f6c-2d4b8a1e3c5f'
PROMPT = '550e8400-e29b-41d4-a716-446655440000'
NOW = 1761580800  # 2026-10-27 16:00:00 UTC, so relative clocks in captures agree
PROJECT = '__RUN__/work/candybar-demo'
HOME = '__RUN__/home'
TRANSCRIPT = HOME + '/.claude/projects/-__RUN__-work-candybar-demo/' + SESSION + '.jsonl'

shutil.rmtree(ROOT, ignore_errors=True)
os.makedirs(ROOT)


def write(rel, text, exe=False):
    p = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write(text)
    if exe:
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)


# The project: a git repository on a feature branch with a modified file, a staged file and an untracked one.
proj = os.path.join(ROOT, 'work', 'candybar-demo')
os.makedirs(proj)
env = dict(os.environ, GIT_AUTHOR_DATE='2026-10-20T10:00:00Z', GIT_COMMITTER_DATE='2026-10-20T10:00:00Z',
           GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null', HOME=ROOT)
git = lambda *a: subprocess.run(['git', *a], cwd=proj, env=env, check=True, capture_output=True)
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'dev@example.com')
git('config', 'user.name', 'Dev')
git('remote', 'add', 'origin', 'git@github.com:acme/candybar-demo.git')
write('work/candybar-demo/README.md', '# candybar-demo\n\nA small project to show a statusline against.\n')
write('work/candybar-demo/package.json', json.dumps({'name': 'candybar-demo', 'version': '1.4.2', 'scripts': {'test': 'vitest'}}, indent=2) + '\n')
write('work/candybar-demo/src/index.ts', 'export const greet = (name: string) => `hello ${name}`;\n')
write('work/candybar-demo/src/graph.ts', 'export function layout(n: number) {\n  return n * 2;\n}\n')
write('work/candybar-demo/.gitignore', 'node_modules\ndist\n')
git('add', '-A')
git('commit', '-q', '-m', 'Initial commit')
for i, msg in enumerate(['Add graph layout', 'Wire the lens', 'Fix label overlap'], 1):
    write('work/candybar-demo/src/graph.ts', 'export function layout(n: number) {\n  return n * %d;\n}\n' % (i + 2))
    env['GIT_AUTHOR_DATE'] = env['GIT_COMMITTER_DATE'] = '2026-10-2%dT10:00:00Z' % (i + 1)
    git('commit', '-q', '-am', msg)
git('checkout', '-q', '-b', 'feature/graph-lens')
write('work/candybar-demo/src/lens.ts', 'export const LENS = 600;\n')
git('add', 'src/lens.ts')
git('commit', '-q', '-m', 'Add the lens constant')
git('commit', '-q', '--allow-empty', '-m', 'Tune the ramp')
# working tree: one modified, one staged, one untracked
write('work/candybar-demo/src/index.ts', 'export const greet = (name: string) => `hello, ${name}!`;\n')
write('work/candybar-demo/src/graph.ts', 'export function layout(n: number) {\n  return n * 5;\n}\n')
git('add', 'src/graph.ts')
write('work/candybar-demo/notes.md', 'todo: push labels apart\n')
shutil.rmtree(os.path.join(proj, '.git', 'hooks'))

# The home: a Claude config directory with settings, a transcript and a usage history.
write('home/.claude/settings.json', json.dumps({'statusLine': {'type': 'command', 'command': 'statusline'}, 'model': 'opus'}, indent=2) + '\n')
write('home/.claude.json', json.dumps({'numStartups': 42, 'oauthAccount': {'emailAddress': 'dev@example.com', 'organizationName': 'Acme'}}, indent=2) + '\n')
write('home/.gitconfig', '[user]\n\tname = Dev\n\temail = dev@example.com\n')


def turn(i, role, text, inp=0, out=0, cache_read=0, cache_create=0):
    t = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(NOW - 2700 + i * 90))
    base = {'parentUuid': None if i == 0 else 'u%03d' % (i - 1), 'isSidechain': False, 'userType': 'external',
            'cwd': PROJECT, 'sessionId': SESSION, 'version': '2.1.90', 'gitBranch': 'feature/graph-lens',
            'uuid': 'u%03d' % i, 'timestamp': t, 'type': role}
    if role == 'user':
        base['message'] = {'role': 'user', 'content': text}
    else:
        base['requestId'] = 'req_%03d' % i
        base['message'] = {'id': 'msg_%03d' % i, 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5-5',
                           'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn',
                           'usage': {'input_tokens': inp, 'cache_creation_input_tokens': cache_create,
                                     'cache_read_input_tokens': cache_read, 'output_tokens': out,
                                     'service_tier': 'standard'}}
    return json.dumps(base)


lines = [json.dumps({'type': 'summary', 'summary': 'Graph lens and label overlap', 'leafUuid': 'u029'})]
exchanges = [('Add a lens that grows labels near the cursor', 'I added the lens: labels within 600px of the cursor grow toward full size.'),
             ('The labels overlap each other', 'Labels now push each other apart inside the force simulation.'),
             ('Text should keep its size when I zoom', 'The stylesheet is divided by the zoom level, so text stays the same size on screen.'),
             ('Make the sidebar collapsible', 'The panel folds away behind a toggle, and the graph takes the full width.'),
             ('Run the tests', 'All 14 tests pass.')]
for i, (q, a) in enumerate(exchanges):
    lines.append(turn(2 * i, 'user', q))
    lines.append(turn(2 * i + 1, 'assistant', a, inp=900 + 40 * i, out=800 + 120 * i, cache_read=14000 + 2200 * i, cache_create=1100))
write(TRANSCRIPT.replace(HOME, 'home'), '\n'.join(lines) + '\n')

# Stub tools a statusline shells out to. Each prints a fixed, plausible answer; none reach the network.
write('bin/ccusage', '#!/bin/bash\n# stub: fixed usage figures, any subcommand\ncat <<EOF\n{"blocks":[{"id":"2026-10-27T11:00:00.000Z","startTime":"2026-10-27T11:00:00.000Z","endTime":"2026-10-27T16:00:00.000Z","isActive":true,"totalTokens":184320,"costUSD":4.37,"burnRate":{"tokensPerMinute":614,"costPerHour":1.46},"projection":{"totalTokens":368000,"totalCost":8.74,"remainingMinutes":212}}],"daily":[{"date":"2026-10-27","totalTokens":184320,"totalCost":4.37}],"totals":{"totalTokens":184320,"totalCost":4.37}}\nEOF\n', exe=True)
write('bin/gh', '#!/bin/bash\n# stub: one open PR for the branch; auth status succeeds\ncase "$1 $2" in\n  "pr list"|"pr view"|"pr status") echo \'[{"number":438,"title":"Survey: statusline landscape explorer","state":"OPEN","url":"https://github.com/acme/candybar-demo/pull/438","reviewDecision":"REVIEW_REQUIRED","isDraft":false,"headRefName":"feature/graph-lens"}]\' ;;\n  "auth status") echo "Logged in to github.com account dev" >&2 ;;\n  "api "*) echo \'{"login":"dev"}\' ;;\n  *) echo "gh: stub" >&2; exit 1 ;;\nesac\n', exe=True)
write('bin/claude', '#!/bin/bash\n# stub: the claude CLI is not available inside a capture\necho "claude: not available in capture" >&2\nexit 1\n', exe=True)
write('bin/tmux', '#!/bin/bash\n# stub: no tmux server inside a capture\necho "no server running" >&2\nexit 1\n', exe=True)

hook = {
    'hook_event_name': 'Status', 'session_id': SESSION, 'session_name': 'graph lens', 'prompt_id': PROMPT,
    'transcript_path': TRANSCRIPT, 'cwd': PROJECT,
    'model': {'id': 'claude-opus-5-5', 'display_name': 'Opus'},
    'workspace': {'current_dir': PROJECT, 'project_dir': PROJECT, 'added_dirs': [],
                  'repo': {'host': 'github.com', 'owner': 'acme', 'name': 'candybar-demo'}},
    'version': '2.1.90', 'output_style': {'name': 'default'},
    'cost': {'total_cost_usd': 4.3721, 'total_duration_ms': 2712000, 'total_api_duration_ms': 418300,
             'total_lines_added': 156, 'total_lines_removed': 23},
    'context_window': {'total_input_tokens': 112400, 'total_output_tokens': 9800, 'context_window_size': 200000,
                       'used_percentage': 61, 'remaining_percentage': 39,
                       'current_usage': {'input_tokens': 1060, 'output_tokens': 1280,
                                         'cache_creation_input_tokens': 1100, 'cache_read_input_tokens': 22800}},
    'exceeds_200k_tokens': False,
    'prompt_cache': {'warm': True, 'caching_observed': True, 'ttl': '1h', 'expires_at': NOW + 3100, 'requests': 14,
                     'misses': 2, 'expected_rebuilds': 1, 'hit_ratio': 0.91, 'cache_write_tokens': 352000,
                     'miss_recache_tokens': 310200, 'last_miss_at': NOW - 2400,
                     'last_miss_cause': {'causes': ['tools_changed'], 'tools_added': 2, 'tools_removed': 0},
                     'miss_causes': {'tools_changed': 2}, 'recache_tokens_if_cold': 45000},
    'fast_mode': False, 'effort': {'level': 'high'}, 'thinking': {'enabled': True},
    'rate_limits': {'five_hour': {'used_percentage': 23.5, 'resets_at': NOW + 7200},
                    'seven_day': {'used_percentage': 41.2, 'resets_at': NOW + 3 * 86400 + 1800}},
    'vim': {'mode': 'NORMAL'},
    'pr': {'number': 438, 'url': 'https://github.com/acme/candybar-demo/pull/438', 'review_state': 'pending'},
}
write('hook.json', json.dumps(hook, indent=2) + '\n')
print('fixture at', ROOT)
