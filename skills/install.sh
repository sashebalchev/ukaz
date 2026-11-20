#!/usr/bin/env bash
# Enable the ukaz skills for the current user by linking them into ~/.claude/skills.
#   ./install.sh            link every skill folder in this directory
#   ./install.sh --dry-run  say what it would do
#   ./install.sh --remove   remove only the links this script made (links that point into this directory)
#   ./install.sh --quiet    install, print nothing (for git hooks)
# It never overwrites or deletes anything that is not a link into this directory. It also points the repository's
# git hooks at .githooks/, which run --quiet after a commit, pull or checkout.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE=install; [ "${1:-}" = "--dry-run" ] && MODE=dry; [ "${1:-}" = "--remove" ] && MODE=remove; [ "${1:-}" = "--quiet" ] && MODE=quiet
SK="$HOME/.claude/skills"
say() { [ "$MODE" = quiet ] || echo "  $*"; }
[ "$MODE" = quiet ] && exec 2>/dev/null
{ [ "$MODE" = install ] || [ "$MODE" = quiet ]; } && git -C "$HERE/.." config core.hooksPath .githooks 2>/dev/null
link() { # link <source> <dest>
  local src="$1" dst="$2"
  if [ -L "$dst" ]; then
    case "$(readlink "$dst")" in
      "$HERE"/*) [ "$MODE" = remove ] && { rm "$dst"; say "removed $dst"; return; }; [ "$(readlink "$dst")" = "$src" ] && { say "ok      $dst"; return; };;
      *) say "SKIP    $dst is a link to somewhere else"; return;;
    esac
  elif [ -e "$dst" ]; then say "SKIP    $dst exists and is not a link"; return; fi
  [ "$MODE" = remove ] && return
  if [ "$MODE" = dry ]; then say "would link $dst -> $src"; else mkdir -p "$(dirname "$dst")"; ln -sfn "$src" "$dst"; say "linked  $dst"; fi
}
# Links this script made for skills that no longer exist (renamed or removed) are dangling: prune them.
for l in "$SK"/*; do
  [ -L "$l" ] || continue
  case "$(readlink "$l")" in "$HERE"/*) [ -e "$l" ] || { if [ "$MODE" = dry ]; then say "would prune $l"; else rm "$l"; say "pruned  $l"; fi; };; esac
done
for d in "$HERE"/*/; do [ -f "$d/SKILL.md" ] && link "${d%/}" "$SK/$(basename "$d")"; done
exit 0
