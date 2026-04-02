#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/.."
IMAGES="${PROJECT_ROOT}/images"
BG="#1D1D29"

generate_gif() {
    local tape="$1"
    printf 'Generating GIF from %s...\n' "${tape}"
    vhs "${tape}"
}

extract_frame() {
    local gif="$1"
    local dst="$2"
    local top="$3"
    local bottom_chop="$4"

    local frame_count
    frame_count=$(ffprobe -v error -count_frames -select_streams v:0 \
        -show_entries stream=nb_read_frames -of csv=p=0 "${gif}" | tr -d ' ')

    local tmp
    tmp="$(mktemp /tmp/frame-XXXXXX.png)"

    ffmpeg -y -v error \
        -i "${gif}" \
        -vf "select='eq(n\,${frame_count}-1)'" \
        -frames:v 1 -update 1 "${tmp}"

    magick "${tmp}" \
        -crop "2000x960+0+${top}" +repage \
        -gravity South -chop "0x${bottom_chop}" +repage \
        -fuzz 3% -trim +repage \
        -bordercolor "${BG}" -border 30 \
        \( +clone -alpha extract \
            -draw "fill black polygon 0,0 0,20 20,0 fill white circle 20,20 20,0" \
            -draw "fill black polygon %[fx:w-1],0 %[fx:w-20],0 %[fx:w-1],20 fill white circle %[fx:w-21],20 %[fx:w-21],0" \
            -draw "fill black polygon 0,%[fx:h-1] 0,%[fx:h-20] 20,%[fx:h-1] fill white circle 20,%[fx:h-21] 20,%[fx:h-1]" \
            -draw "fill black polygon %[fx:w-1],%[fx:h-1] %[fx:w-1],%[fx:h-20] %[fx:w-20],%[fx:h-1] fill white circle %[fx:w-21],%[fx:h-21] %[fx:w-1],%[fx:h-21]" \
        \) -alpha off -compose CopyOpacity -composite \
        "${dst}"

    rm -f "${tmp}"
    printf 'Saved %s (%s)\n' "${dst}" "$(magick identify -format '%wx%h' "${dst}")"
}

main() {
    cd "${PROJECT_ROOT}"

    generate_gif scripts/screenshot-themes.tape
    generate_gif scripts/screenshot-styles.tape

    extract_frame "${IMAGES}/themes-all.gif" "${IMAGES}/claude-powerline-themes.png" 105 300
    extract_frame "${IMAGES}/styles-all.gif" "${IMAGES}/claude-powerline-styles.png" 100 380

    rm -f "${IMAGES}/themes-all.gif" "${IMAGES}/styles-all.gif"

    printf 'Done.\n'
    exit 0
}

main "$@"
