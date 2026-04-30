#!/usr/bin/env bash
# Per-client loop for soak.sh. Picks a random repo each iteration, generates
# synthetic hookData with a fixed sessionId (so usageCache is exercised under
# its real key), pipes it to claude-powerline, saves output, sleeps 1-5s.
#
# Usage: soak-client.sh REPOS_FILE SESSION_ID OUT_DIR CLIENT_ID
#
# The session id is fixed per client so the daemon's usageCache (keyed by
# sessionId) sees stable keys across iterations — which is what production
# does. Repo varies per iteration to exercise gitCache sharing across clients
# all hitting the same repoRoot.

set -euo pipefail

REPOS_FILE="$1"
SESSION_ID="$2"
OUT_DIR="$3"
CLIENT_ID="$4"

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BIN="${REPO_ROOT}/dist/index.mjs"

mapfile -t REPOS < "$REPOS_FILE"
N_REPOS="${#REPOS[@]}"
if (( N_REPOS == 0 )); then
  echo "no repos in $REPOS_FILE" >&2
  exit 1
fi

ITER_OUT="${OUT_DIR}/client-${CLIENT_ID}.last"
ERR_LOG="${OUT_DIR}/client-${CLIENT_ID}.err"
: > "$ERR_LOG"

trap 'exit 0' TERM INT

iter=0
while :; do
  iter=$((iter + 1))
  repo="${REPOS[$(( RANDOM % N_REPOS ))]}"
  hook="$(jq -cn --arg repo "$repo" --arg sid "$SESSION_ID" '{
    hook_event_name: "Status",
    session_id: $sid,
    transcript_path: "/dev/null",
    cwd: $repo,
    model: {id: "claude-3-5-sonnet", display_name: "Claude"},
    workspace: {current_dir: $repo, project_dir: $repo}
  }')"
  if ! printf '%s' "$hook" | node "$BIN" > "$ITER_OUT" 2>>"$ERR_LOG"; then
    echo "iter=$iter render failed" >> "$ERR_LOG"
  fi
  # 1-5s random sleep matches statusline refresh cadence variance.
  sleep "$(( 1 + RANDOM % 5 ))"
done
