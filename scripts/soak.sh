#!/usr/bin/env bash
# 24h soak test harness for the claude-powerline daemon.
#
# Spawns N concurrent client loops against a shared daemon, samples RSS over
# time, periodically asserts daemon-rendered output matches the inline-render
# path, and at the end reports pass/fail against:
#   - final RSS < 100MB
#   - RSS slope < 1MB/hr (per daemon PID segment)
#   - zero output divergences
#
# Usage:
#   scripts/soak.sh [--duration=SEC] [--clients=N] [--out=DIR] [--skip-build]
#                   [--sample-interval=SEC] [--diverge-interval=SEC]
#
# Defaults: 24h, 30 clients, /tmp/claude-powerline-soak-<ts>, build first,
# 60s RSS sampling, 300s divergence checks.
#
# Verifying leak detection (acceptance criterion):
#   1. Add to src/daemon/server.ts (top of handleRequest's render branch):
#        const __leak: Buffer[] = (globalThis as any).__leak ??= [];
#        __leak.push(Buffer.alloc(1 * 1024 * 1024));
#   2. npm run build && scripts/soak.sh --duration=3600 --clients=30
#   3. Expect summary FAIL with "peak slope >= 1 MB/hr" — leak is detected.
#   4. Revert the change.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly DAEMON_DIR="${HOME}/.claude/powerline"
readonly PID_FILE="${DAEMON_DIR}/pid"

DURATION=86400
CLIENTS=30
OUT_DIR=""
SKIP_BUILD=0
SAMPLE_INTERVAL=60
DIVERGE_INTERVAL=300

usage() {
  sed -n '2,16p' "$0"
  exit 2
}

for arg in "$@"; do
  case "$arg" in
    --duration=*)         DURATION="${arg#*=}" ;;
    --clients=*)          CLIENTS="${arg#*=}" ;;
    --out=*)              OUT_DIR="${arg#*=}" ;;
    --skip-build)         SKIP_BUILD=1 ;;
    --sample-interval=*)  SAMPLE_INTERVAL="${arg#*=}" ;;
    --diverge-interval=*) DIVERGE_INTERVAL="${arg#*=}" ;;
    -h|--help)            usage ;;
    *) echo "unknown arg: $arg" >&2; usage ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="/tmp/claude-powerline-soak-$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "$OUT_DIR"
readonly OUT_DIR

readonly FIXTURES_DIR="${OUT_DIR}/fixtures"
readonly DIVERGE_DIR="${OUT_DIR}/divergence"
readonly CLIENT_OUT_DIR="${OUT_DIR}/clients"
readonly RSS_CSV="${OUT_DIR}/soak.csv"
readonly DAEMON_LOG="${OUT_DIR}/daemon.log"
readonly SUMMARY="${OUT_DIR}/summary.txt"
readonly REPOS_LIST="${OUT_DIR}/repos.txt"
readonly CANARY_REPO="${FIXTURES_DIR}/canary"

mkdir -p "$FIXTURES_DIR" "$DIVERGE_DIR" "$CLIENT_OUT_DIR"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

require() {
  command -v "$1" >/dev/null 2>&1 || { log "missing required tool: $1"; exit 1; }
}

require node
require jq
require git
require ps
require uuidgen

# --- fixture creation ---------------------------------------------------------
# We create synthetic git repos with varied state so the gitCache exercises its
# branches/dirty/ahead/stash code paths. The "canary" repo is reserved for the
# divergence checker — no client touches it, so its state is quiescent and the
# daemon's cached view matches the inline view byte-for-byte.

mk_fixture() {
  local name="$1"; shift
  local dir="${FIXTURES_DIR}/${name}"
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email soak@test
  git -C "$dir" config user.name soak
  echo "hello" > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -q -m "init"
  "$@" "$dir"
  echo "$dir" >> "$REPOS_LIST"
}

state_clean() { :; }
state_dirty() { echo "dirty" > "$1/work.txt"; }
state_ahead() {
  # synthetic upstream so "ahead" reads sensibly
  git -C "$1" remote add origin "$1/.git"
  git -C "$1" branch --set-upstream-to=main main 2>/dev/null || true
  echo "more" > "$1/more.txt"
  git -C "$1" add more.txt
  git -C "$1" commit -q -m "ahead"
}
state_branch() {
  git -C "$1" checkout -q -b feature/soak
  echo "feat" > "$1/feat.txt"
  git -C "$1" add feat.txt
  git -C "$1" commit -q -m "feat"
}
state_stash() {
  echo "stashed" > "$1/work.txt"
  git -C "$1" stash push -q -u -m "soak-stash"
}

create_fixtures() {
  rm -f "$REPOS_LIST"
  mk_fixture clean   state_clean
  mk_fixture dirty   state_dirty
  mk_fixture ahead   state_ahead
  mk_fixture branch  state_branch
  mk_fixture stash   state_stash
  # Canary is a clean repo; intentionally NOT added to REPOS_LIST so clients
  # never touch it. The divergence checker uses it directly.
  #
  # Commit is backdated 30 days so the renderer's "time since last commit"
  # segment reads "30d" or similar — a string stable across the few-second gap
  # between daemon and inline calls. A fresh "init" commit instead reads
  # "16s" vs "31s" between calls and produces spurious mismatches.
  rm -rf "$CANARY_REPO"
  mkdir -p "$CANARY_REPO"
  git -C "$CANARY_REPO" init -q -b main
  git -C "$CANARY_REPO" config user.email soak@test
  git -C "$CANARY_REPO" config user.name soak
  echo "canary" > "$CANARY_REPO/README.md"
  git -C "$CANARY_REPO" add README.md
  GIT_AUTHOR_DATE="$(date -u -v-30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
  GIT_COMMITTER_DATE="$(date -u -v-30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
    git -C "$CANARY_REPO" commit -q -m "init"
}

# --- daemon lifecycle ---------------------------------------------------------

stop_existing_daemon() {
  if [[ ! -f "$PID_FILE" ]]; then return 0; fi
  local pid
  pid="$(jq -r '.pid // empty' "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then return 0; fi
  if kill -0 "$pid" 2>/dev/null; then
    log "stopping existing daemon pid=$pid"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

# Ensure a daemon is up and (best-effort) record whether *we* spawned it.
# Ownership matters for divergence checking: the config loader resolves files
# relative to process.cwd() (src/config/loader.ts findConfigFile), so an
# externally-spawned daemon with a different CWD will legitimately produce
# different output from our inline-render path. We auto-disable divergence
# checks when we don't own the daemon, rather than reporting false positives.
WE_OWN_DAEMON=0
start_daemon() {
  if daemon_is_up; then
    log "observing already-running daemon (pid=$(read_daemon_pid)) — divergence checks disabled"
    WE_OWN_DAEMON=0
    return 0
  fi
  log "spawning daemon"
  ( cd "$REPO_ROOT" && exec node dist/index.mjs daemon ) >>"$DAEMON_LOG" 2>&1 &
  local spawn_pid=$!
  disown "$spawn_pid" 2>/dev/null || true
  for _ in $(seq 1 100); do
    if daemon_is_up; then
      local fpid
      fpid="$(read_daemon_pid)"
      WE_OWN_DAEMON=$([[ "$fpid" == "$spawn_pid" ]] && echo 1 || echo 0)
      return 0
    fi
    sleep 0.1
  done
  log "daemon failed to come up within 10s"
  return 1
}

daemon_is_up() {
  [[ -f "$PID_FILE" ]] || return 1
  [[ -S "${DAEMON_DIR}/socket" ]] || return 1
  local pid
  pid="$(jq -r '.pid // empty' "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

read_daemon_pid() {
  jq -r '.pid // empty' "$PID_FILE" 2>/dev/null || true
}

# --- background workers -------------------------------------------------------

# Sampler: every $SAMPLE_INTERVAL seconds, read pidfile, append timestamp/pid/rss
# to CSV. PID is tracked so the analyzer can segment by daemon-restart events
# (the daemon self-shuts down at age 24h).
sampler_loop() {
  echo "ts_unix,pid,rss_kb" > "$RSS_CSV"
  while :; do
    local pid rss ts
    ts="$(date +%s)"
    pid="$(read_daemon_pid)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
      if [[ -n "$rss" ]]; then
        printf '%s,%s,%s\n' "$ts" "$pid" "$rss" >> "$RSS_CSV"
      fi
    fi
    sleep "$SAMPLE_INTERVAL"
  done
}

# Divergence checker: every $DIVERGE_INTERVAL run the canary hookData through
# both the daemon path and the inline path; if outputs differ OR either path
# errors, save full context (hookData, both stdouts, both stderrs, both exit
# codes) to disk and increment the mismatch counter. We do NOT swallow render
# failures — a daemon that errors on canary input is a regression worth
# surfacing as forcefully as a byte-divergence.
divergence_loop() {
  local check_id=0
  local mismatches_file="${DIVERGE_DIR}/mismatches"
  local checks_file="${DIVERGE_DIR}/checks"
  printf 0 > "$mismatches_file"
  printf 0 > "$checks_file"
  while :; do
    sleep "$DIVERGE_INTERVAL"
    check_id=$((check_id + 1))
    local d="${DIVERGE_DIR}/check-${check_id}"
    mkdir -p "$d"
    local hook
    hook="$(make_hookdata "$CANARY_REPO" "soak-canary-$(uuidgen)")"
    printf '%s' "$hook" > "$d/hookData.json"

    local drc=0 irc=0
    printf '%s' "$hook" | node "${REPO_ROOT}/dist/index.mjs" \
      >"$d/daemon.out" 2>"$d/daemon.err" || drc=$?
    printf '%s' "$hook" | env CLAUDE_POWERLINE_NO_DAEMON=1 node "${REPO_ROOT}/dist/index.mjs" \
      >"$d/inline.out" 2>"$d/inline.err" || irc=$?
    printf '%d %d\n' "$drc" "$irc" > "$d/exit_codes"

    printf '%s' "$(($(cat "$checks_file") + 1))" > "$checks_file"

    local diverged=0
    if [[ "$drc" -ne 0 ]] || [[ "$irc" -ne 0 ]]; then
      diverged=1
    elif ! cmp -s "$d/daemon.out" "$d/inline.out"; then
      diverged=1
    fi

    if [[ "$diverged" -eq 1 ]]; then
      printf '%s' "$(($(cat "$mismatches_file") + 1))" > "$mismatches_file"
    else
      # Pass — clean up the noise so failed checks stand out in DIVERGE_DIR.
      rm -rf "$d"
    fi
  done
}

# --- hookData helper ----------------------------------------------------------

make_hookdata() {
  local repo="$1"; local sid="$2"
  jq -cn --arg repo "$repo" --arg sid "$sid" '{
    hook_event_name: "Status",
    session_id: $sid,
    transcript_path: "/dev/null",
    cwd: $repo,
    model: {id: "claude-3-5-sonnet", display_name: "Claude"},
    workspace: {current_dir: $repo, project_dir: $repo}
  }'
}

# --- orchestrate --------------------------------------------------------------

CHILD_PIDS=()

cleanup() {
  log "cleanup: stopping background workers"
  for p in "${CHILD_PIDS[@]:-}"; do
    [[ -n "$p" ]] || continue
    kill -TERM "$p" 2>/dev/null || true
  done
  sleep 1
  for p in "${CHILD_PIDS[@]:-}"; do
    [[ -n "$p" ]] || continue
    kill -KILL "$p" 2>/dev/null || true
  done
  local dpid
  dpid="$(read_daemon_pid)"
  if [[ -n "$dpid" ]] && kill -0 "$dpid" 2>/dev/null; then
    kill -TERM "$dpid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# export helpers for client subshells
export -f make_hookdata
export REPO_ROOT

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  log "building project"
  ( cd "$REPO_ROOT" && npm run build >>"$OUT_DIR/build.log" 2>&1 )
fi

if [[ ! -f "${REPO_ROOT}/dist/index.mjs" ]]; then
  log "dist/index.mjs not found; run with build or build manually first"
  exit 1
fi

log "out dir: $OUT_DIR"
log "duration: ${DURATION}s clients: $CLIENTS sample: ${SAMPLE_INTERVAL}s diverge: ${DIVERGE_INTERVAL}s"

create_fixtures
log "fixtures created: $(wc -l <"$REPOS_LIST" | tr -d ' ') repos"

stop_existing_daemon
start_daemon
log "daemon up: pid=$(read_daemon_pid)"

# spawn clients
for i in $(seq 1 "$CLIENTS"); do
  sid="soak-$(uuidgen)"
  "${SCRIPT_DIR}/soak-client.sh" \
    "$REPOS_LIST" "$sid" "$CLIENT_OUT_DIR" "$i" \
    >"${CLIENT_OUT_DIR}/client-${i}.log" 2>&1 &
  CHILD_PIDS+=("$!")
done
log "spawned $CLIENTS clients"

# spawn sampler + divergence checker. Divergence is skipped when we don't own
# the daemon — see start_daemon for why.
sampler_loop &
CHILD_PIDS+=("$!")
if [[ "$WE_OWN_DAEMON" -eq 1 ]]; then
  divergence_loop &
  CHILD_PIDS+=("$!")
else
  log "divergence loop skipped (we do not own the daemon)"
  printf 'skipped\n' > "${DIVERGE_DIR}/skipped"
fi

# Wait for duration with periodic progress.
END_TS=$(( $(date +%s) + DURATION ))
PROGRESS_EVERY=$(( SAMPLE_INTERVAL * 5 ))
NEXT_PROGRESS=$(( $(date +%s) + PROGRESS_EVERY ))
while :; do
  now="$(date +%s)"
  if (( now >= END_TS )); then break; fi
  if (( now >= NEXT_PROGRESS )); then
    remaining=$(( END_TS - now ))
    dpid="$(read_daemon_pid)"
    rss="?"
    if [[ -n "$dpid" ]]; then
      rss="$(ps -o rss= -p "$dpid" 2>/dev/null | tr -d ' ' || echo '?')"
    fi
    log "progress: remaining=${remaining}s daemon_pid=${dpid:-none} rss_kb=${rss}"
    NEXT_PROGRESS=$(( now + PROGRESS_EVERY ))
  fi
  sleep 5
done

log "soak duration elapsed; tearing down"
cleanup
trap - EXIT INT TERM
sleep 2

log "running analyzer"
node "${SCRIPT_DIR}/soak-analyze.mjs" "$OUT_DIR" | tee "$SUMMARY"
status=${PIPESTATUS[0]}
exit "$status"
