#!/bin/bash
# Generate WebP thumbnails used to texture the WebGL grid.
#
# The full-resolution covers are committed alongside these (that is the
# archive); these thumbs exist because a 1600x2184 RGBA texture is ~14MB, so
# ~60 visible covers would need ~840MB of VRAM. The grid renders thumbs and
# links out to the full-res file.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HERE/../../covers}"
DST="${2:-$HERE/../public/covers}"
W="${3:-280}"
Q="${4:-62}"
mkdir -p "$DST"
find "$SRC" -type f \( -name '*.jpg' -o -name '*.png' -o -name '*.gif' \) -print0 \
  | xargs -0 -n 1 -P 8 "$HERE/one.sh" "$SRC" "$DST" "$W" "$Q"
echo "thumbs: $(find "$DST" -name '*.webp' | wc -l | tr -d ' ') in $DST"
du -sh "$DST"
