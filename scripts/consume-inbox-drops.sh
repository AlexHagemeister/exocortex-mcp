#!/usr/bin/env bash
# Consume remote captures from the mirror's inbox-drops branch into the vault.
#
# Run locally (the machine that has the vault + mirror). Intended to be invoked
# manually or hooked into the mirror-snapshot routine, BEFORE the snapshot's
# rsync so captures survive the --delete pass by already being in the vault.
#
#   ./scripts/consume-inbox-drops.sh
#
# Reads the vault root from ~/.claude/exocortex-vault-path and the mirror from
# ~/exocortex-mirror (override with VAULT_DIR / MIRROR_DIR).
set -euo pipefail

VAULT_DIR="${VAULT_DIR:-$(cat "$HOME/.claude/exocortex-vault-path")}"
MIRROR_DIR="${MIRROR_DIR:-$HOME/exocortex-mirror}"
BRANCH="inbox-drops"

cd "$MIRROR_DIR"
git fetch origin

if ! git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
  echo "No $BRANCH branch on origin — nothing to consume."
  exit 0
fi

# Files present on inbox-drops but not on origin/main are the pending captures.
# (while-read instead of mapfile: macOS ships bash 3.2)
count=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  count=$((count + 1))
  dest="$VAULT_DIR/$f"
  if [ -e "$dest" ]; then
    echo "SKIP (already exists in vault): $f"
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  git show "origin/$BRANCH:$f" > "$dest"
  echo "Consumed: $f"
done < <(git diff --name-only --diff-filter=A "origin/main...origin/$BRANCH" -- 'sources/inbox/')

if [ "$count" -eq 0 ]; then
  echo "No pending captures on $BRANCH."
fi

# Reset the branch to main so the next capture starts clean. The captures are
# now in the vault's sources/inbox/ and will reach the mirror via the next
# snapshot like any other vault content.
git push origin "origin/main:refs/heads/$BRANCH" --force
echo "Reset $BRANCH to origin/main."
