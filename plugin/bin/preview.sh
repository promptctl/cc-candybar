#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly PLUGIN_ROOT="${SCRIPT_DIR}/.."

readonly SAMPLE_JSON='{"model":{"id":"claude-sonnet-4-20250514","display_name":"Sonnet 4"},"cost":{"total_cost_usd":0.42,"message_cost_usd":0.03,"duration":"15m"},"context_window":{"context_window_size":200000,"used_percentage":35,"current_usage":{"input_tokens":50000,"cache_creation_input_tokens":10000,"cache_read_input_tokens":5000}},"cwd":"/home/user/my-project","workspace":{"current_dir":"/home/user/my-project"},"session":{"session_id":"abc123"}}'

readonly PREVIEW_CONFIG='{
  "theme": "dark",
  "display": {
    "style": "minimal",
    "charset": "unicode",
    "colorCompatibility": "auto",
    "autoWrap": true,
    "padding": 1,
    "lines": [
      {
        "segments": {
          "directory": { "enabled": true, "style": "fish" },
          "git": { "enabled": true },
          "model": { "enabled": true },
          "session": { "enabled": true, "type": "cost", "costSource": "calculated" },
          "today": { "enabled": true, "type": "cost" },
          "context": { "enabled": true, "showPercentageOnly": false, "displayStyle": "text", "autocompactBuffer": 33000 }
        }
      }
    ]
  },
  "budget": {
    "session": { "warningThreshold": 80 },
    "today": { "amount": 50, "warningThreshold": 80 }
  }
}'

THEME="dark"
STYLE="minimal"
CHARSET="unicode"
COMPARE_STYLES=false
COMPARE_THEMES=false
BIN=""
TEMP_FILES=()

# shellcheck disable=SC2329
cleanup() {
    for f in "${TEMP_FILES[@]}"; do
        rm -f "${f}"
    done
}
trap cleanup EXIT

test_binary() {
    local bin="$1"
    printf '{}' | "${bin}" --help >/dev/null 2>&1
}

find_binary() {
    local npm_bin="${PLUGIN_ROOT}/../bin/claude-powerline"
    if [[ -f "${npm_bin}" ]] && test_binary "${npm_bin}"; then
        printf '%s' "${npm_bin}"
        return 0
    fi

    local path_bin
    if path_bin="$(command -v claude-powerline 2>/dev/null)" && test_binary "${path_bin}"; then
        printf '%s' "${path_bin}"
        return 0
    fi

    printf 'npx'
    return 0
}

make_temp_config() {
    local preview_theme="$1"
    local preview_style="$2"
    local preview_charset="$3"
    local tmp

    tmp="$(mktemp)"
    TEMP_FILES+=("${tmp}")
    printf '%s' "${PREVIEW_CONFIG}" |
        sed -e "s/\"theme\": \"dark\"/\"theme\": \"${preview_theme}\"/" \
            -e "s/\"style\": \"minimal\"/\"style\": \"${preview_style}\"/" \
            -e "s/\"charset\": \"unicode\"/\"charset\": \"${preview_charset}\"/" \
            >"${tmp}"
    printf '%s' "${tmp}"
}

run_preview() {
    local preview_theme="$1"
    local preview_style="$2"
    local preview_charset="$3"
    local tmp_config

    tmp_config="$(make_temp_config "${preview_theme}" "${preview_style}" "${preview_charset}")"

    if [[ "${BIN}" == "npx" ]]; then
        printf '%s' "${SAMPLE_JSON}" | npx -y @owloops/claude-powerline@latest \
            --config="${tmp_config}"
    else
        printf '%s' "${SAMPLE_JSON}" | "${BIN}" \
            --config="${tmp_config}"
    fi
}

run_compare_styles() {
    local styles=(minimal powerline capsule tui)
    local s

    for s in "${styles[@]}"; do
        printf '%s:\n' "${s}"
        run_preview "${THEME}" "${s}" "${CHARSET}"
        printf '\n\n'
    done
}

run_compare_themes() {
    local themes=(dark light nord tokyo-night rose-pine gruvbox)
    local t

    for t in "${themes[@]}"; do
        printf '%s:\n' "${t}"
        run_preview "${t}" "${STYLE}" "${CHARSET}"
        printf '\n\n'
    done
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --theme=*)
                THEME="${1#*=}"
                shift
                ;;
            --theme)
                [[ $# -ge 2 ]] || {
                    printf 'Missing value for --theme\n' >&2
                    exit 1
                }
                THEME="$2"
                shift 2
                ;;
            --style=*)
                STYLE="${1#*=}"
                shift
                ;;
            --style)
                [[ $# -ge 2 ]] || {
                    printf 'Missing value for --style\n' >&2
                    exit 1
                }
                STYLE="$2"
                shift 2
                ;;
            --charset=*)
                CHARSET="${1#*=}"
                shift
                ;;
            --charset)
                [[ $# -ge 2 ]] || {
                    printf 'Missing value for --charset\n' >&2
                    exit 1
                }
                CHARSET="$2"
                shift 2
                ;;
            --compare-styles)
                COMPARE_STYLES=true
                shift
                ;;
            --compare-themes)
                COMPARE_THEMES=true
                shift
                ;;
            *)
                printf 'Unknown option: %s\n' "$1" >&2
                exit 1
                ;;
        esac
    done
}

main() {
    parse_args "$@"
    BIN="$(find_binary)"

    if [[ "${COMPARE_STYLES}" == "true" ]]; then
        run_compare_styles
        exit 0
    fi

    if [[ "${COMPARE_THEMES}" == "true" ]]; then
        run_compare_themes
        exit 0
    fi

    run_preview "${THEME}" "${STYLE}" "${CHARSET}"
    printf '\n'
    exit 0
}

main "$@"
