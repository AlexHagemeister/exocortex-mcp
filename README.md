# exocortex-mcp

[![Ko-fi](https://img.shields.io/badge/Ko--fi-buy%20me%20a%20coffee-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/V1N723QW1K)

Remote MCP server for an [exocortex](https://github.com/AlexHagemeister/exocortex) vault — your compiled knowledge, reachable from claude.ai, the Claude mobile app, and any MCP client, wherever you are.

**Companion component, not a requirement.** The vault works fully without this server. What it adds is the away-from-desk loop: query your wiki mid-conversation on your phone, and capture thoughts that land in your vault's normal ingest pipeline — the driving use case is talking to Claude while out, with your exocortex along for the ride.

<p align="center">
  <a href="https://ko-fi.com/V1N723QW1K">
    <img src="https://storage.ko-fi.com/cdn/brandasset/v2/support_me_on_kofi_red.png" width="300" alt="Support me on Ko-fi">
  </a>
</p>

## What it does

Three tools, preserving the vault's single-pipeline rule in infrastructure:

| Tool | Kind | What it does |
|---|---|---|
| `query_wiki` | read | Status-weighted search over `wiki/` — `verified` pages rank above `draft` (×1.5 vs ×1.0), matching the vault's "readers weight by status" invariant. |
| `get_page` | read | Fetch any repo-relative file (or list a directory). |
| `capture_to_inbox` | **the sole write** | Writes a frontmattered markdown source into `sources/inbox/` via a dedicated `inbox-drops` branch. |

Nothing here can edit your wiki, your notes, or your sources — captures enter through the same gate as everything else, and your vault's maintainer files them on the next `process-inbox` run.

## How it fits

```
claude.ai / Claude app / Claude Code ──HTTP──▶ exocortex-mcp (your cloud host)
                                                  │  clone + pull (read)
                                                  │  push inbox-drops (write)
                                                  ▼
                                   your vault's private GitHub repo
                                                  ▲
                                                  │  daily vault-snapshot
                                                  │  (commit + pull --rebase + push)
                                       your local vault (the working copy)
```

- **The data source is your vault's git remote**, not the live working copy — the private repo you set up in the program's SETUP step 4. Staleness is bounded by your snapshot cadence; with the default daily snapshot that's accepted by design.
- The server keeps a shallow working clone under `DATA_DIR/mirror`, pulling at most every `SYNC_INTERVAL_SECONDS`.

## The capture return path

Captures go through a dedicated branch, never directly to `main`:

1. The server commits each capture to the **`inbox-drops`** branch (based on `main`, so `origin/main...inbox-drops` is exactly the pending captures) and pushes it.
2. On the machine that has the vault, [`scripts/consume-inbox-drops.sh`](scripts/consume-inbox-drops.sh) copies pending captures into the vault's `sources/inbox/` and force-resets the branch to `main`. Run it from your snapshot routine, or by hand.
3. From there the vault's normal ingest pipeline takes over.

Why a branch: it keeps `main` single-writer from your own machine — no push races between the server and your snapshots — and remote surfaces stay on the inbox pipeline. A side store outside git was rejected to keep one data path and one credential.

## Auth

claude.ai custom connectors currently support **OAuth 2.1** (heavyweight for a personal server) or **no auth**; there is no static-header option in the connector UI. This server ships a middle path:

- A single shared secret, `EXOCORTEX_TOKEN` (`openssl rand -hex 32`), compared timing-safely.
- Accepted as `Authorization: Bearer <token>` — for Claude Code (`claude mcp add --transport http exocortex <url>/mcp --header "Authorization: Bearer <token>"`) and the API's MCP connector.
- Also accepted as a secret URL path segment — `https://<host>/t/<token>/mcp` — which is what you paste into the claude.ai custom-connector dialog (**treat that URL as a credential**).

This is personal-server auth: one user, one secret. If your deployment ever becomes multi-user, the upgrade path is a proper OAuth 2.1 authorization server per the MCP auth spec.

## Deploy your own (Railway, ~10 minutes)

Any Node host works; Railway is what the reference deployment uses.

1. Create a **fine-grained GitHub PAT** scoped to your vault repo *only*, with **Contents: Read and write** (write is needed for `inbox-drops` pushes).
2. New Railway service from your clone of this repo. Nixpacks detects Node; it runs `npm run build` then `npm start`.
3. Set variables:
   - `MIRROR_REPO_URL=https://x-access-token:<PAT>@github.com/<you>/<your-vault-repo>.git`
   - `EXOCORTEX_TOKEN=<openssl rand -hex 32>`
4. Note the service's public domain, then add the connector in claude.ai: **Settings → Connectors → Add custom connector** with `https://<domain>/t/<token>/mcp`.

The clone lives on the ephemeral filesystem and is re-cloned on each deploy — fine, since your git remote is the source of truth.

## Monitoring

`GET /healthz` is shallow liveness. `GET /healthz/deep` is the monitoring endpoint: it exercises the mirror sync and inspects the `inbox-drops` backlog, returning 503 when sync fails or captures sit undrained for more than 36 hours (two missed nightly consumer runs). One probe therefore catches process-down, sync-broken (bad PAT, GitHub unreachable), and consumer-not-running. It exposes counts and ages only, never vault content.

[`.github/workflows/healthcheck.yml`](.github/workflows/healthcheck.yml) probes it every 15 minutes; set the `HEALTHCHECK_URL` repository **secret** to your deployment's `/healthz/deep` URL and GitHub emails you on failure (a secret so your endpoint stays out of publicly readable run logs; the probe skips quietly when it's unset, so forks don't get failure spam). Caveats: cron runs can be delayed, and GitHub pauses scheduled workflows after ~60 days of repo inactivity (it emails first — one click keeps it alive).

## Local development

```sh
cp .env.example .env   # point MIRROR_REPO_URL at a local vault path, set a token
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

## Design notes

- Data source is the vault's git remote (clone + pull), not a live mount; snapshot-bounded staleness is accepted.
- Three tools; `capture_to_inbox` is the only write, and it writes to the inbox, not the wiki.
- One data path, one credential: everything rides the vault repo and one scoped PAT.
