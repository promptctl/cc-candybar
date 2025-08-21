#!/usr/bin/env bash

set -euo pipefail

readonly BLUE='\033[0;34m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly RESET='\033[0m'

readonly TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT INT TERM

log() {
    local level=$1
    shift
    local color
    case "$level" in
        INFO) color="$GREEN" ;;
        WARN) color="$YELLOW" ;;
        *) color="$BLUE" ;;
    esac
    echo -e "${color}[$(date +'%Y-%m-%dT%H:%M:%S')] ${level}: $*${RESET}" >&2
}

ensure_command() {
    command -v "$1" >/dev/null 2>&1 || { log ERROR "Required command not found: $1"; exit 1; }
}

print_banner() {
    echo -e "${BLUE}=== Claude Powerline Benchmark ===${RESET}"
    echo "Working directory: $(pwd)"
    echo "Git commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'not a git repo')"
    echo "Test timestamp: $(date)"
    echo
}

run_benchmark() {
    local runs=$1
    local description=$2
    local theme_flag=${3:-""}
    
    local test_json='{"session_id":"test-session","workspace":{"project_dir":"'$(pwd)'","current_dir":"'$(pwd)'"},"model":{"id":"claude-3-5-sonnet","display_name":"Claude"},"transcript_path":"/dev/null","cwd":"'$(pwd)'"}'
    
    echo -e "${BLUE}--- $description ---${RESET}"
    
    if [[ $runs -eq 1 ]]; then
        echo "Single execution timing:"
        local result
        result=$(time -p (echo "$test_json" | node dist/index.js $theme_flag > /dev/null) 2>&1)
        local real_time user_time sys_time
        real_time=$(echo "$result" | grep "^real " | awk '{print $2}')
        user_time=$(echo "$result" | grep "^user " | awk '{print $2}')
        sys_time=$(echo "$result" | grep "^sys " | awk '{print $2}')
        
        local real_ms user_ms sys_ms
        real_ms=$(echo "$real_time * 1000" | bc | cut -d. -f1)
        user_ms=$(echo "$user_time * 1000" | bc | cut -d. -f1)
        sys_ms=$(echo "$sys_time * 1000" | bc | cut -d. -f1)
        
        echo "  Real time: ${real_ms}ms"
        echo "  User time: ${user_ms}ms"
        echo "  Sys time:  ${sys_ms}ms"
    else
        echo "Running $runs executions..."
        
        local total_real=0 total_user=0 total_sys=0
        
        for i in $(seq 1 $runs); do
            local result real_time user_time sys_time
            result=$(time -p (echo "$test_json" | node dist/index.js $theme_flag > /dev/null) 2>&1)
            real_time=$(echo "$result" | grep "^real " | awk '{print $2}')
            user_time=$(echo "$result" | grep "^user " | awk '{print $2}')
            sys_time=$(echo "$result" | grep "^sys " | awk '{print $2}')
            
            total_real=$(echo "$total_real + $real_time" | bc)
            total_user=$(echo "$total_user + $user_time" | bc)
            total_sys=$(echo "$total_sys + $sys_time" | bc)
            
            local run_ms
            run_ms=$(echo "$real_time * 1000" | bc | cut -d. -f1)
            echo "  Run $i: ${run_ms}ms"
        done
        
        local avg_real avg_user avg_sys
        avg_real=$(echo "scale=3; $total_real / $runs" | bc)
        avg_user=$(echo "scale=3; $total_user / $runs" | bc)
        avg_sys=$(echo "scale=3; $total_sys / $runs" | bc)
        
        echo
        local avg_real_ms avg_user_ms avg_sys_ms total_real_ms
        avg_real_ms=$(echo "$avg_real * 1000" | bc | cut -d. -f1)
        avg_user_ms=$(echo "$avg_user * 1000" | bc | cut -d. -f1)
        avg_sys_ms=$(echo "$avg_sys * 1000" | bc | cut -d. -f1)
        total_real_ms=$(echo "$total_real * 1000" | bc | cut -d. -f1)
        
        echo -e "${GREEN}Summary:${RESET}"
        echo "  Average real time: ${avg_real_ms}ms"
        echo "  Average user time: ${avg_user_ms}ms"
        echo "  Average sys time:  ${avg_sys_ms}ms"
        echo "  Total time: ${total_real_ms}ms"
    fi
    echo
}

main() {
    ensure_command node
    ensure_command bc
    ensure_command npm
    
    print_banner
    
    log INFO "Building project..."
    npm run build > /dev/null 2>&1
    
    run_benchmark 1 "Single Execution"
    run_benchmark 10 "10 Executions"
    
    echo -e "${GREEN}=== Benchmark Complete ===${RESET}"
}

main "$@"