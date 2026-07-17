# exocortex-mcp

Remote MCP server that makes the [exocortex vault]'s knowledge available to Claude
from anywhere — the driving use case is talking to Claude on the phone while out.

Personal-use-first; the separate-repo choice deliberately keeps later publication open.

## Architecture

```
claude.ai / Claude Code ──HTTP──▶ exocortex-mcp (Railway)
                                     │  clone + pull (read)
                                     │  push inbox-drops (write)
                                     ▼
                        github.com/AlexHagemeister/exocortex-mirror  (private)
                                     ▲
                                     │  nightly mirror-snapshot (rsync + commit + push)
                              local vault (Obsidian, iCloud)
```

- **Data source is the mirror's GitHub repo**, not the live vault. Staleness is
  bounded by the nightly snapshot — accepted by design.
- The server keeps a shallow working clone under `DATA_DIR/mirror`, pulling at
  most every `SYNC_INTERVAL_SECONDS`.

## Tools

Three tools only, preserving the vault's single-pipeline rule in infrastructure:

| Tool | Kind | What it does |
|---|---|---|
| `query_wiki` | read | Status-weighted search over `wiki/` — `verified` pages rank above `draft` (×1.5 vs ×1.0), matching the vault's "readers weight by status" invariant. |
| `get_page` | read | Fetch any repo-relative file (or list a directory). |
| `capture_to_inbox` | **the sole write** | Writes a frontmattered markdown source into `sources/inbox/` via the mirror's `inbox-drops` branch. |

## The capture return path (resolved open question)

`capture_to_inbox` cannot commit to the mirror's `main`: the nightly snapshot's
`rsync --delete` would clobber server-side additions. Instead:

1. The server commits each capture to a dedicated **`inbox-drops`** branch
   (based on `main`, so `origin/main...inbox-drops` is exactly the pending captures)
   and pushes it.
2. Locally, [`scripts/consume-inbox-drops.sh`](scripts/consume-inbox-drops.sh)
   copies pending captures into the vault's `sources/inbox/` and force-resets the
   branch to `main`. Hook it into the mirror-snapshot routine **before** the rsync,
   or run it by hand.
3. From there the vault's normal ingest pipeline takes over.

The alternative considered (a side store outside git) was rejected to keep one
data path and one credential. Revisable if branch juggling proves annoying.

## Auth (resolved open question)

claude.ai custom connectors currently support **OAuth 2.1** (authorization-server
metadata, PKCE, DCR — heavyweight for a personal server) or **no auth**; there is
no static-header option in the connector UI. This server ships a middle path:

- A single shared secret, `EXOCORTEX_TOKEN` (`openssl rand -hex 32`).
- Accepted as `Authorization: Bearer <token>` — for Claude Code
  (`claude mcp add --transport http exocortex <url>/mcp --header "Authorization: Bearer <token>"`)
  and the API's MCP connector.
- Also accepted as a secret URL path segment — `https://<host>/t/<token>/mcp` —
  which is what you paste into the claude.ai custom-connector dialog (treat the
  URL itself as a credential).

Upgrade path if this ever becomes multi-user or published: a proper OAuth 2.1
authorization server per the MCP auth spec. Not worth it for personal use today.

## Deploy (Railway)

1. Create a **fine-grained GitHub PAT** scoped to `AlexHagemeister/exocortex-mirror`
   only, with *Contents: Read and write* (write is needed for `inbox-drops` pushes).
2. New Railway service from this repo. Nixpacks detects Node; it runs
   `npm run build` then `npm start`.
3. Set variables:
   - `MIRROR_REPO_URL=https://x-access-token:<PAT>@github.com/AlexHagemeister/exocortex-mirror.git`
   - `EXOCORTEX_TOKEN=<openssl rand -hex 32>`
4. Note the public domain, then add the connector in claude.ai:
   **Settings → Connectors → Add custom connector** with
   `https://<domain>/t/<token>/mcp`.

The clone lives on the ephemeral filesystem and is re-cloned on each deploy —
fine, since GitHub is the source of truth.

## Monitoring

`GET /healthz` is shallow liveness. `GET /healthz/deep` is the monitoring
endpoint: it exercises the mirror sync and inspects the `inbox-drops` backlog,
returning 503 when sync fails or captures sit undrained for >36h (two missed
nightly consumer runs). One probe therefore catches process-down, sync-broken
(bad PAT, GitHub unreachable), and consumer-not-running. It exposes counts and
ages only, never vault content.

[`.github/workflows/healthcheck.yml`](.github/workflows/healthcheck.yml) probes
it every 15 minutes; GitHub emails on workflow failure. Caveats: cron runs can
be delayed, and GitHub pauses scheduled workflows after ~60 days of repo
inactivity (it emails first — one click keeps it alive).

## Local development

```sh
cp .env.example .env   # point MIRROR_REPO_URL at ~/exocortex-mirror, set a token
npm install
npm run dev
```

Smoke test:

```sh
curl -s localhost:3000/healthz
curl -s localhost:3000/mcp \
  -H "Authorization: Bearer $EXOCORTEX_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Decisions carried from the handoff brief

- Cloud host: Railway (existing setup). Server is its own repo in `dev/mcp/`.
- Data source: mirror's GitHub repo, clone + pull; nightly-snapshot staleness accepted.
- Three tools; `capture_to_inbox` is the only write.
- The other servers in `dev/mcp/` were deliberately not used as references.
