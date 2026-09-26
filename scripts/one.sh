#!/bin/bash
# Convert one cover to WebP. Invoked by thumbs.sh as:
#   one.sh <src> <dst> <width> <quality> <file>
# xargs -n 1 APPENDS the path, so the file is the LAST argument here.
set -u
SRC="$1"; DST="$2"; W="$3"; Q="$4"
for f in "$@"; do FILE="$f"; done   # last arg is the file

rel="${FILE#"$SRC"/}"
y="$(dirname "$rel")"
b="$(basename "$FILE")"; b="${b%.*}"
mkdir -p "$DST/$y"
[ -s "$DST/$y/$b.webp" ] && exit 0
cwebp -quiet -resize "$W" 0 -q "$Q" "$FILE" -o "$DST/$y/$b.webp" 2>/dev/null
