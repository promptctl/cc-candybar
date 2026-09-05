#!/usr/bin/env bash
# Render the wizard's template config against a fixture session so the user can
# see a real bar before committing to a theme, style, charset, or preset.
#
# The config rendered here IS the template the wizard writes — templates/config.json
# with its four placeholders filled by the same substitution the wizard performs —
# so the preview cannot drift from what the wizard installs.
# (test/plugin-templates.test.ts drives every name below through `cc-candybar check`.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly PLUGIN_ROOT="${SCRIPT_DIR}/.."
readonly TEMPLATE="${PLUGIN_ROOT}/templates/config.json"

# The options the wizard offers, one list per template placeholder. Each name
# must be one the daemon accepts; the test pins that against the real domains.
readonly THEMES=(dark light nord tokyo-night rose-pine gruvbox catppuccin-mocha dracula solarized-dark monokai)
readonly STYLES=(powerline capsule plain)
readonly CHARSETS=(unicode ascii)
readonly PRESETS=(default compact verbose)

THEME="${THEMES[0]}"
STYLE="${STYLES[0]}"
CHARSET="${CHARSETS[0]}"
PRESET="${PRESETS[0]}"
COMPARE=""

WORK="$(mktemp -d)"
readonly WORK
readonly REPO="${WORK}/my-project"
readonly TRANSCRIPT="${WORK}/preview.jsonl"
CLIENT=()

# shellcheck disable=SC2329
cleanup() {
    rm -rf "${WORK}"
}
trap cleanup EXIT

# The statusline client: this checkout's shim (developing against a checkout),
# an installed cc-candybar on PATH, else the published package via npx.
find_client() {
    local checkout_bin="${PLUGIN_ROOT}/../bin/cc-candybar"
    if [[ -x "${checkout_bin}" ]] && [[ -f "${PLUGIN_ROOT}/../dist/index.mjs" ]]; then
        CLIENT=("${checkout_bin}")
        return 0
    fi
    local path_bin
    if path_bin="$(command -v cc-candybar)"; then
        CLIENT=("${path_bin}")
        return 0
    fi
    CLIENT=(npx -y @promptctl/cc-candybar@latest)
}

# A git repo on a feature branch with one untracked file, so the git segment has
# something to show, and a two-turn transcript for the session-derived segments.
make_fixture() {
    mkdir -p "${REPO}"
    git -C "${REPO}" init -b main --quiet
    git -C "${REPO}" -c user.name="User" -c user.email="u@e.co" commit --allow-empty -m "init" --quiet
    git -C "${REPO}" checkout -b feat/my-feature --quiet
    touch "${REPO}/newfile.txt"

    local now_iso
    now_iso="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
    printf '{"timestamp":"%s","type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n' "${now_iso}" >"${TRANSCRIPT}"
    printf '{"timestamp":"%s","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n' "${now_iso}" >>"${TRANSCRIPT}"
}

# One Claude Code status hook payload, shaped like the daemon's required input.
sample_json() {
    printf '{"hook_event_name":"Status","session_id":"preview-123","transcript_path":"%s","cwd":"%s","workspace":{"current_dir":"%s","project_dir":"%s"},"model":{"id":"claude-opus-4-8","display_name":"Opus 4.8"},"version":"1.0.47","cost":{"total_cost_usd":2.85,"total_duration_ms":16200000,"total_api_duration_ms":480000,"total_lines_added":342,"total_lines_removed":87},"context_window":{"context_window_size":200000,"used_percentage":42,"total_input_tokens":72000,"total_output_tokens":12000,"current_usage":{"input_tokens":72000,"output_tokens":12000,"cache_creation_input_tokens":15000,"cache_read_input_tokens":8000}},"rate_limits":{"five_hour":{"used_percentage":35,"resets_at":%d},"seven_day":{"used_percentage":28,"resets_at":%d}}}' \
        "${TRANSCRIPT}" "${REPO}" "${REPO}" "${REPO}" \
        "$(($(date +%s) + 15480))" "$(($(date +%s) + 432000))"
}

# The one render request, sent from inside the fixture repo (the daemon reads
# git state from the client's working directory).
render_request() {
    (cd "${REPO}" && sample_json | "${CLIENT[@]}" "$@")
}

probe_daemon() {
    { "${CLIENT[@]}" daemon-stats --json >/dev/null; } 2>&1
}

# The first request on a cold daemon spawns it in the background and prints an
# empty line; a preview must not be that line. Kick once, then wait until the
# daemon answers or the deadline passes. The bound is wall-clock, not a probe
# count: a probe through npx costs seconds, a native one milliseconds.
ensure_daemon() {
    local probe deadline=$((SECONDS + 15))
    if probe="$(probe_daemon)"; then
        return 0
    fi
    render_request >/dev/null
    until probe="$(probe_daemon)"; do
        if ((SECONDS >= deadline)); then
            printf 'preview: the cc-candybar daemon did not start within 15s: %s\n' "${probe}" >&2
            exit 1
        fi
        sleep 0.1
    done
}

# The wizard's substitution, exactly: the template with its four placeholders
# filled. Prints the written path.
fill_template() {
    local theme="$1" style="$2" charset="$3" preset="$4"
    local out="${WORK}/config-${theme}-${style}-${charset}-${preset}.json"
    sed -e "s/replace:THEME/${theme}/" \
        -e "s/replace:STYLE/${style}/" \
        -e "s/replace:CHARSET/${charset}/" \
        -e "s/replace:PRESET/${preset}/" \
        "${TEMPLATE}" >"${out}"
    printf '%s' "${out}"
}

render() {
    render_request --config="$(fill_template "$@")"
    printf '\n'
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --theme=*) THEME="${1#*=}" ;;
            --style=*) STYLE="${1#*=}" ;;
            --charset=*) CHARSET="${1#*=}" ;;
            --preset=*) PRESET="${1#*=}" ;;
            --compare-themes) COMPARE="themes" ;;
            --compare-styles) COMPARE="styles" ;;
            --compare-charsets) COMPARE="charsets" ;;
            --compare-presets) COMPARE="presets" ;;
            *)
                printf 'Unknown option: %s\n' "$1" >&2
                printf 'Usage: preview.sh [--theme=NAME] [--style=NAME] [--charset=NAME] [--preset=NAME] [--compare-themes|--compare-styles|--compare-charsets|--compare-presets]\n' >&2
                exit 2
                ;;
        esac
        shift
    done
}

main() {
    parse_args "$@"
    find_client
    make_fixture
    ensure_daemon
    # The flag values are checked once, as the wizard's user would see them
    # (exit 1 names the error). A compare varies one axis over its array, whose
    # members test/plugin-templates.test.ts pins to the loader's own domain.
    "${CLIENT[@]}" check "$(fill_template "${THEME}" "${STYLE}" "${CHARSET}" "${PRESET}")" >/dev/null

    local name
    case "${COMPARE}" in
        "") render "${THEME}" "${STYLE}" "${CHARSET}" "${PRESET}" ;;
        themes) for name in "${THEMES[@]}"; do printf '%s:\n' "${name}"; render "${name}" "${STYLE}" "${CHARSET}" "${PRESET}"; printf '\n'; done ;;
        styles) for name in "${STYLES[@]}"; do printf '%s:\n' "${name}"; render "${THEME}" "${name}" "${CHARSET}" "${PRESET}"; printf '\n'; done ;;
        charsets) for name in "${CHARSETS[@]}"; do printf '%s:\n' "${name}"; render "${THEME}" "${STYLE}" "${name}" "${PRESET}"; printf '\n'; done ;;
        presets) for name in "${PRESETS[@]}"; do printf '%s:\n' "${name}"; render "${THEME}" "${STYLE}" "${CHARSET}" "${name}"; printf '\n'; done ;;
    esac
}

main "$@"
