#!/usr/bin/env bash
# Structure check for every skill: frontmatter, name equals folder, no dangling /skill references, size.
set -u
cd "$(dirname "$0")"
bad=0
names=$(for d in */; do [ -f "$d/SKILL.md" ] && basename "$d"; done)
for d in */; do
  n=$(basename "$d"); f="$d/SKILL.md"
  [ -f "$f" ] || { echo "FAIL $n: no SKILL.md"; bad=1; continue; }
  [ "$(sed -n 1p "$f")" = "---" ] || { echo "FAIL $n: no frontmatter"; bad=1; }
  fm=$(awk 'NR>1 && /^---$/ {exit} NR>1 {print}' "$f")
  [ "$(echo "$fm" | sed -n 's/^name: *//p' | tr -d '"')" = "$n" ] || { echo "FAIL $n: name does not equal folder"; bad=1; }
  echo "$fm" | grep -q '^description:' || { echo "FAIL $n: no description"; bad=1; }
  size=$(wc -c < "$f"); [ "$size" -gt 9000 ] && echo "WARN $n: $size bytes"
  for ref in $(grep -o -E '\]\(\.\./[a-z0-9-]+/SKILL\.md\)' "$f" | grep -o -E '\.\./[a-z0-9-]+' | sed 's#\.\./##'); do
    echo "$names" | grep -qx "$ref" || { echo "FAIL $n: link to missing skill $ref"; bad=1; }
  done
  for ref in $(grep -o -E '`/[a-z][a-z0-9-]+`' "$f" | tr -d '`/' | sort -u); do
    case "$ref" in glyph-kit|nyx|compact|clear|help|loop|init|review|model|fast) continue;; esac
    echo "$names" | grep -qx "$ref" || echo "NOTE $n: mentions /$ref, which is not in the kit"
  done
  grep -v '^<!--' "$f" | grep -n -i -E 'poteto-mode|setup-pstack|\.cursor|deslop|visualize|arena' | sed "s#^#WARN $n: #" | head -3
done
[ "$bad" = 0 ] && echo "STRUCTURE OK" || { echo "STRUCTURE FAILS"; exit 1; }
