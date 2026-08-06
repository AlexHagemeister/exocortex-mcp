# Changelog

Notable changes to exocortex-mcp, per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/) — pre-1.0, a minor bump means new capability, a patch means fixes and wording. Companion to the [exocortex program](https://github.com/AlexHagemeister/exocortex), which versions independently.

## [Unreleased]

### Security
- `/healthz/deep` could return the GitHub PAT from `MIRROR_REPO_URL` in plaintext to unauthenticated callers (#6). A failed `execFile` puts the full git command line — PAT included — into `err.message`, which `deepHealth()` served verbatim in `degraded[]` and the startup sync logged via `console.error`. Any git failure triggered it: mis-pasted URL, expired PAT, GitHub outage, DNS failure. Credentials are now scrubbed at the source — the `git()` wrapper redacts URL userinfo and GitHub token literals from `message`/`stdout`/`stderr` before rethrowing — and again at the two response boundaries and the startup log as defense in depth. Covered by the repo's first unit tests, which CI now runs.

## [0.5.1] — 2026-08-04

### Fixed
- `consume-inbox-drops.sh` destroyed captures whose filenames contain non-ASCII characters. `git diff --name-only` C-quotes such paths by default, so a capture titled with an umlaut was read as a quoted string carrying literal backslash escapes: the script created a directory named `"sources` at the vault root, wrote a 0-byte file into it, then died mid-loop when `git show` could not find the quoted path in the tree — before reaching any remaining captures, and without printing a halt line that monitoring would recognize. On the next run the 0-byte file satisfied the already-exists guard, so the failure reported itself as an idempotent success; once every capture had "consumed" this way, the loop completed and force-reset `inbox-drops` to `main`, destroying the only remote copy. Three changes, each closing one link in that chain: the work list is NUL-delimited (`diff -z`); each capture is staged to a temp file beside its destination and renamed into place only after `git show` succeeds, so a failure leaves nothing behind to poison the guard; and the branch reset is skipped whenever any capture failed.
- Hardening in the same pass, from a review of the above: the work list is written to a file instead of being read through process substitution, which hid a failing `git diff` from `set -e` — an unreadable diff produced an empty work list, and the reset then destroyed every pending capture while reporting success. The reset is now `--force-with-lease` against the branch sha the run actually consumed, so a capture pushed between the fetch and the reset is no longer overwritten while it is the only copy. An already-present destination is compared byte-for-byte before being skipped, since a truncated or differing file there would otherwise let the reset destroy the good copy. `VAULT_DIR` is validated before any git operation, because `cd ""` is a silent no-op.

## [0.5.0] — 2026-07-31

### Added
- Write-side capture guidance, prompted by an audit of real captures: remote agents wrote honest speaker attribution but never marked the user's words as verbatim quotes (so nothing they captured could ever be promoted to verified) and filed their own research under the user's provenance. The server now ships a capture contract as MCP server instructions — user's words as marked quotes with a speaker, agent research/conclusions in a separate attributed section with URLs, inference marked as inference — with a matching pointer in the `capture_to_inbox` tool description.
- `captured_via` frontmatter on every capture, stamped server-side from the auth route (path auth ⇒ claude.ai connector) plus the User-Agent — surface identity no longer depends on the calling agent's diligence. (The initialize handshake's `clientInfo` never reaches a stateless tool call, so the HTTP layer is the reliable signal.)

### Changed
- `provenance` is now a required parameter of `capture_to_inbox`, and its description asks for speaker + date + surface, with mixed user/agent content declared.

## [0.4.0] — 2026-07-23

### Added
- MIT license, this changelog, retroactive version tags, and a CI build check — the repo is dressed for public consumption.
- Ko-fi support link in the README, matching the program repo.

### Changed
- README rewritten as the program's companion-component doc: deploy-your-own instructions with placeholder repo/host values throughout; the reference deployment's endpoint appears nowhere in the tree.
- The healthcheck workflow reads its probe target from a `HEALTHCHECK_URL` repository secret instead of a hardcoded URL — masked in publicly readable run logs, and the probe skips quietly when unset so forks don't get failure spam.
- `.env.example` examples generalized to placeholders.

## [0.3.0] — 2026-07-22

### Changed
- Token-frugal tool responses for `query_wiki` and `get_page` (#3): tighter payloads for the same answers, since every byte returned rides in a model's context window.

## [0.2.1] — 2026-07-19

### Changed
- `consume-inbox-drops.sh` defaults its git operations to the vault repo itself — the vault became its own clone in the 2026-07-19 vault-as-repo migration, retiring the separate mirror checkout.
- Docs updated for the vault repo rename and the post-migration rationale for keeping the `inbox-drops` capture branch (single-writer `main`).

## [0.2.0] — 2026-07-17

### Added
- `GET /healthz/deep`: exercises mirror sync and inspects the `inbox-drops` backlog; 503 on sync failure or captures undrained past 36h. Counts and ages only, never vault content.
- GitHub Actions healthcheck: probes the deep endpoint every 15 minutes; failures trigger GitHub's email.

## [0.1.0] — 2026-07-17

### Added
- Initial release: remote MCP server over a vault's git remote. Three tools — `query_wiki` (status-weighted search, `verified` outranks `draft`), `get_page` (repo-relative read), `capture_to_inbox` (the sole write, via the `inbox-drops` branch). Shallow mirror clone with interval sync; shared-secret auth as bearer header or URL path segment, compared timing-safely; Railway deploy with Dockerfile.
