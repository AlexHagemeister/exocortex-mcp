#!/usr/bin/env bash
# Consume remote captures from the inbox-drops branch into the vault.
#
# Run locally (the machine that has the vault). The vault is itself a clone of
# the private repo, so git operations run in the vault by default. Intended to
# be invoked manually or by the vault-snapshot routine, before its commit so
# captures ride along in the same snapshot.
#
#   ./scripts/consume-inbox-drops.sh
#
# Reads the vault root from ~/.claude/exocortex-vault-path (override with
# VAULT_DIR; MIRROR_DIR overrides where git commands run, defaults to the vault).
set -euo pipefail

VAULT_DIR="${VAULT_DIR:-$(cat "$HOME/.claude/exocortex-vault-path")}"
MIRROR_DIR="${MIRROR_DIR:-$VAULT_DIR}"
BRANCH="inbox-drops"

cd "$MIRROR_DIR"
git fetch origin

if ! git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
  echo "No $BRANCH branch on origin — nothing to consume."
  exit 0
fi

# Files present on inbox-drops but not on origin/main are the pending captures.
# (while-read instead of mapfile: macOS ships bash 3.2)
#
# -z with core.quotepath=false is the only unambiguous form: git C-quotes
# non-ASCII paths by default, so a capture titled "NuHaus" with an umlaut
# arrived as a quoted string with literal backslash escapes. Used verbatim it
# created a directory named '"sources', wrote a 0-byte file, and killed the
# loop when git show could not find the quoted path in the tree.
count=0
failed=0
while IFS= read -r -d '' f; do
  [ -n "$f" ] || continue
  count=$((count + 1))
  dest="$VAULT_DIR/$f"
  if [ -e "$dest" ]; then
    echo "SKIP (already exists in vault): $f"
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  # Stage to a temp file and move it into place only once git has succeeded.
  # Redirecting straight to $dest creates the file before git runs, so a
  # failure leaves a 0-byte corpse that the [ -e ] guard above reads as a
  # successful consume on every later run.
  tmp="$(mktemp "${TMPDIR:-/tmp}/consume-inbox-drops.XXXXXX")"
  if git show "origin/$BRANCH:$f" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$dest"
    echo "Consumed: $f"
  else
    rm -f "$tmp"
    failed=$((failed + 1))
    echo "FAILED to read from $BRANCH: $f" >&2
  fi
done < <(git -c core.quotepath=false diff -z --name-only --diff-filter=A "origin/main...origin/$BRANCH" -- 'sources/inbox/')

if [ "$count" -eq 0 ]; then
  echo "No pending captures on $BRANCH."
fi

# Reset the branch to main so the next capture starts clean. The captures are
# now in the vault's sources/inbox/ and will reach the mirror via the next
# snapshot like any other vault content.
#
# Never reset after a failure: the branch holds the only remote copy of a
# capture this script could not read, and the force-push would destroy it.
if [ "$failed" -gt 0 ]; then
  echo "HALT: $failed capture(s) failed to consume — leaving $BRANCH intact for retry." >&2
  exit 1
fi

git push origin "origin/main:refs/heads/$BRANCH" --force
echo "Reset $BRANCH to origin/main."
