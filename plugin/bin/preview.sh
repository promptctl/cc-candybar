#!/usr/bin/env bash
# Draw the wizard's template choices or its written config in a fixture session
# using the ordinary statusline client and daemon.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly PLUGIN_ROOT="${SCRIPT_DIR}/.."
readonly TEMPLATE="${PLUGIN_ROOT}/templates/config.json"

# The options the wizard offers, one list per template placeholder. Each name
# must be one the daemon accepts; the test pins that against the real domains.
readonly THEMES=(textual-dark textual-light nord tokyo-night rose-pine gruvbox catppuccin-mocha dracula solarized-dark monokai)
readonly ENDCAPS_SHAPES=(powerline prism slant backslant flame pixel ice bubble capsule wrapper metro stitch torn plain)
readonly PRESETS=(default compact verbose zen git usage dense)

THEME="${THEMES[0]}"
ENDCAPS="${ENDCAPS_SHAPES[0]}"
PRESET="${PRESETS[0]}"
COMPARE=""
CONFIG_FILE=""
HAS_CHOICES=false
CLIENT=()

# shellcheck disable=SC2329
cleanup() {
    rm -rf "${WORK}"
}

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

# [LAW:no-ambient-temporal-coupling] A cold statusline request can start the
# daemon and return blank. Wait for readiness only after a blank response.
# The first usable answer is the preview, whether the daemon was warm or cold.
render_config() {
    local file="$1" frame probe deadline=$((SECONDS + 15))
    while ((SECONDS < deadline)); do
        frame="$(render_request --config-only="${file}")"
        if [[ -n "${frame}" ]]; then
            printf '%s\n\n' "${frame}"
            return 0
        fi
        until probe="$(probe_daemon)"; do
            if ((SECONDS >= deadline)); then
                printf 'preview: the cc-candybar daemon did not start within 15s: %s\n' "${probe}" >&2
                return 1
            fi
            sleep 0.1
        done
        sleep 0.1
    done
    printf 'preview: the cc-candybar daemon returned no frame within 15s\n' >&2
    return 1
}

usage() {
    printf 'Usage: preview.sh [--config-only=PATH | [--theme=NAME] [--endcaps=NAME] [--preset=NAME] [--compare-themes|--compare-endcaps|--compare-presets]]\n' >&2
}

invalid() {
    printf 'preview: %s\n' "$1" >&2
    usage
    exit 2
}

# [LAW:parse-dont-validate] Wizard choices admit exact members of the lists
# that the comparison prints. A missing, partial or unlisted name fails before
# it reaches a template filename, the substitution or the statusline client.
require_choice() {
    local flag="$1" value="$2" choice
    shift 2
    for choice in "$@"; do
        if [[ "${value}" == "${choice}" ]]; then
            return 0
        fi
    done
    invalid "unknown ${flag} choice: ${value}"
}

# The wizard's substitution, exactly: the template with its three placeholders
# filled. Prints the written path.
fill_template() {
    local theme="$1" endcaps="$2" preset="$3"
    local out="${WORK}/config-${theme}-${endcaps}-${preset}.json"
    sed -e "s/replace:THEME/${theme}/" \
        -e "s/replace:ENDCAPS/${endcaps}/" \
        -e "s/replace:PRESET/${preset}/" \
        "${TEMPLATE}" >"${out}" || return
    printf '%s' "${out}"
}

render() {
    local config
    config="$(fill_template "$@")"
    render_config "${config}"
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --theme=*) THEME="${1#*=}"; HAS_CHOICES=true ;;
            --endcaps=*) ENDCAPS="${1#*=}"; HAS_CHOICES=true ;;
            --preset=*) PRESET="${1#*=}"; HAS_CHOICES=true ;;
            --compare-themes) COMPARE="themes" ;;
            --compare-endcaps) COMPARE="endcaps" ;;
            --compare-presets) COMPARE="presets" ;;
            --config-only=) invalid "--config-only needs a path" ;;
            --config-only=*) CONFIG_FILE="${1#*=}" ;;
            *) invalid "unknown option: $1" ;;
        esac
        shift
    done
}

main() {
    parse_args "$@"
    # [LAW:types-are-the-program] A written config is its own preview input.
    # Template choices describe the other input and cannot modify that file.
    if [[ -n "${CONFIG_FILE}" ]]; then
        if [[ "${HAS_CHOICES}" == true || -n "${COMPARE}" ]]; then
            invalid "--config-only cannot be combined with template choices"
        fi
        if [[ "${CONFIG_FILE}" != /* ]]; then
            CONFIG_FILE="${PWD}/${CONFIG_FILE}"
        fi
        if [[ ! -f "${CONFIG_FILE}" || ! -r "${CONFIG_FILE}" ]]; then
            invalid "cannot read config file: ${CONFIG_FILE}"
        fi
    else
        require_choice theme "${THEME}" "${THEMES[@]}"
        require_choice endcaps "${ENDCAPS}" "${ENDCAPS_SHAPES[@]}"
        require_choice preset "${PRESET}" "${PRESETS[@]}"
    fi

    WORK="$(mktemp -d)"
    readonly WORK
    readonly REPO="${WORK}/my-project"
    readonly TRANSCRIPT="${WORK}/preview.jsonl"
    trap cleanup EXIT
    find_client
    make_fixture

    if [[ -n "${CONFIG_FILE}" ]]; then
        render_config "${CONFIG_FILE}"
        return
    fi

    local name
    case "${COMPARE}" in
        "") render "${THEME}" "${ENDCAPS}" "${PRESET}" ;;
        themes) for name in "${THEMES[@]}"; do printf '%s:\n' "${name}"; render "${name}" "${ENDCAPS}" "${PRESET}"; done ;;
        endcaps) for name in "${ENDCAPS_SHAPES[@]}"; do printf '%s:\n' "${name}"; render "${THEME}" "${name}" "${PRESET}"; done ;;
        presets) for name in "${PRESETS[@]}"; do printf '%s:\n' "${name}"; render "${THEME}" "${ENDCAPS}" "${name}"; done ;;
    esac
}

main "$@"
