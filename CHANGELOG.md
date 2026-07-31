# Changelog

Notable changes to exocortex-mcp, per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/) — pre-1.0, a minor bump means new capability, a patch means fixes and wording. Companion to the [exocortex program](https://github.com/AlexHagemeister/exocortex), which versions independently.

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
