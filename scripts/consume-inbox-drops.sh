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

# `cd ""` is a silent no-op, so an empty pointer file would leave git running in
# whatever directory the caller happened to be in. Fail loudly instead.
[ -n "$VAULT_DIR" ] || { echo "ERROR: VAULT_DIR is empty (check ~/.claude/exocortex-vault-path)." >&2; exit 1; }
[ -d "$VAULT_DIR/sources/inbox" ] || { echo "ERROR: no sources/inbox under VAULT_DIR: $VAULT_DIR" >&2; exit 1; }

cd "$MIRROR_DIR"
git fetch origin

if ! git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
  echo "No $BRANCH branch on origin — nothing to consume."
  exit 0
fi

# Pin the branch tip we are about to consume. The reset at the end is leased
# against this sha, so a capture pushed between the fetch above and that reset
# cannot be force-overwritten while it is still the only copy anywhere.
LEASE="$(git rev-parse "origin/$BRANCH")"

# Files present on inbox-drops but not on origin/main are the pending captures.
# (while-read instead of mapfile: macOS ships bash 3.2)
#
# -z is what makes this safe: git C-quotes non-ASCII paths by default, so a
# capture titled "NuHaus" with an umlaut arrived as a quoted string with literal
# backslash escapes. Used verbatim it created a directory named '"sources',
# wrote a 0-byte file, and killed the loop when git show could not find the
# quoted path in the tree. -z emits raw bytes with a NUL terminator instead;
# core.quotepath=false is belt-and-braces, not load-bearing.
#
# The list goes through a file rather than process substitution: `< <(git ...)`
# hides the exit status of the git command from set -e, so a diff that failed
# would read as an empty work list — zero pending captures, and the reset below
# would then destroy every capture on the branch while reporting success.
LIST="$(mktemp "${TMPDIR:-/tmp}/consume-inbox-drops-list.XXXXXX")"
trap 'rm -f "$LIST"' EXIT
git -c core.quotepath=false diff -z --name-only --diff-filter=A \
  "origin/main...origin/$BRANCH" -- 'sources/inbox/' > "$LIST"

count=0
failed=0
while IFS= read -r -d '' f; do
  [ -n "$f" ] || continue
  count=$((count + 1))
  dest="$VAULT_DIR/$f"
  if [ -e "$dest" ]; then
    # Existence alone is not proof the vault holds this capture: a truncated or
    # differing file here would let the reset below destroy the good copy. Only
    # skip when the bytes match; anything else is a failure for a human to look
    # at, with the branch preserved.
    if git show "origin/$BRANCH:$f" | cmp -s - "$dest"; then
      echo "SKIP (already in vault, identical): $f"
    else
      failed=$((failed + 1))
      echo "FAILED: $f exists in the vault but differs from the branch copy — not overwriting." >&2
    fi
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  # Stage to a temp file and move it into place only once git has succeeded.
  # Redirecting straight to $dest creates the file before git runs, so a
  # failure leaves a 0-byte corpse that the [ -e ] guard above reads as a
  # successful consume on every later run. The temp file lives beside the
  # destination so the mv is an atomic rename: via $TMPDIR it could cross
  # filesystems and degrade to copy+unlink, which can be interrupted halfway
  # and leave exactly the partial file the guard above must never see.
  tmp="$(mktemp "$(dirname "$dest")/.consume.XXXXXX")"
  if git show "origin/$BRANCH:$f" > "$tmp"; then
    chmod 644 "$tmp"
    mv "$tmp" "$dest"
    echo "Consumed: $f"
  else
    rm -f "$tmp"
    failed=$((failed + 1))
    echo "FAILED to read from $BRANCH: $f" >&2
  fi
done < "$LIST"

if [ "$count" -eq 0 ]; then
  echo "No pending captures on $BRANCH."
fi

# Reset the branch to main so the next capture starts clean. The captures are
# now in the vault's sources/inbox/ and will reach the mirror via the next
# snapshot like any other vault content.
#
# Note the window this leaves: between here and the caller's commit, the
# consumed captures exist only as untracked files on one disk. A caller that
# can halt before committing (snapshot-lite does, on a credential-shaped
# string) leaves them single-copy until its nightly counterpart adjudicates.
#
# Never reset after a failure: the branch holds the only remote copy of a
# capture this script could not read, and the force-push would destroy it.
if [ "$failed" -gt 0 ]; then
  echo "HALT: $failed capture(s) failed to consume — leaving $BRANCH intact for retry." >&2
  exit 1
fi

# Leased, not blind: if anything landed on the branch since the fetch above,
# this is rejected rather than overwriting a capture nothing else has a copy of.
# The next run consumes it.
if ! git push origin "origin/main:refs/heads/$BRANCH" --force-with-lease="refs/heads/$BRANCH:$LEASE"; then
  echo "HALT: $BRANCH moved since fetch — not resetting. The next run will consume what arrived." >&2
  exit 1
fi
echo "Reset $BRANCH to origin/main."
