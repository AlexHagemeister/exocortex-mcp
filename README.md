# exocortex-mcp

[![CI](https://github.com/AlexHagemeister/exocortex-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexHagemeister/exocortex-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AlexHagemeister/exocortex-mcp?style=flat-square)](https://github.com/AlexHagemeister/exocortex-mcp/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-buy%20me%20a%20coffee-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/V1N723QW1K)

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

## Guest access

Optionally, the same deployment can serve a second audience: trusted people you hand a guest URL to, so their Claude can query your exocortex. There is no manifest file anywhere — the manifest is what the server *answers* during the MCP handshake, and the token a connection authenticated with picks the answer. Your token sees the server above, unchanged. The guest token sees a different face:

- Server name `<owner>-exocortex`, with instructions written for an agent that has never heard of your vault: what this is, that pages are a compiled record of your thinking (not you speaking), and how to weight `verified` vs `draft`.
- `query_wiki` and `get_page`, scoped to `wiki/` — never `sources/`, `notes/`, or the day logs (`wiki/log/` and its derived index). Directory listings are filtered the same way, the checks are case-folded (a case-insensitive filesystem can't be used to sneak past the deny list), and a symlink committed under `wiki/` is re-checked against where it actually resolves. **Everything else under `wiki/` is in scope by default** — if your wiki has folders about people or your personal life, decide deliberately whether guests should read them. `EXOCORTEX_GUEST_DENY` adds comma-separated prefixes to the deny list (e.g. `wiki/people/,wiki/life/`).
- `leave_note_for_<owner>` instead of `capture_to_inbox`: guests can drop a note into your review inbox, but the server composes the provenance itself (`guest connector: Anna (via their Claude), <date>` — the marker leads, so no self-reported name can make it read like your own provenance), and the file is named `<date>-guest-note-<slug>.md` so drops are recognizable at a glance.
- Every guest tool requires a `from` field naming the person, and each call is logged (`[guest] Anna: query_wiki "..."`), so your host's logs are the query log.

Enable it by setting `EXOCORTEX_GUEST_TOKEN` (a second `openssl rand -hex 32` — the server refuses to boot if it equals `EXOCORTEX_TOKEN`, since that would silently make every guest an owner) and `EXOCORTEX_OWNER_NAME` (e.g. `Alex`). Then hand each trusted person `https://<host>/t/<guest-token>/mcp` to paste into **Settings → Connectors → Add custom connector**. The URL is the credential: everyone holding it is "a trusted friend" to the server, and rotating the env var revokes them all. If you ever want per-person revocation or real (non-self-reported) attribution, that's the moment to mint per-person tokens — or graduate to OAuth.

## Deploy your own (Railway, ~10 minutes)

Any Node host works; Railway is what the reference deployment uses.

1. Create a **fine-grained GitHub PAT** scoped to your vault repo *only*, with **Contents: Read and write** (write is needed for `inbox-drops` pushes).
2. New Railway service from your clone of this repo. Nixpacks detects Node; it runs `npm run build` then `npm start`.
3. Set variables:
   - `MIRROR_REPO_URL=https://x-access-token:<PAT>@github.com/<you>/<your-vault-repo>.git`
   - `EXOCORTEX_TOKEN=<openssl rand -hex 32>`
4. Note the service's public domain, then add the connector in claude.ai: **Settings → Connectors → Add custom connector** with `https://<domain>/t/<token>/mcp`.

The clone lives on the ephemeral filesystem and is re-cloned on each deploy — fine, since your git remote is the source of truth.

## Make it Claude's primary memory

The connector gives Claude the tools; this tells Claude to reach for them. Paste the block below into claude.ai **Settings → Profile → personal preferences** (it applies across all your chats), editing to taste:

> **MEMORY**
>
> My personal knowledge base is the exocortex-mcp connector (tools: query_wiki, get_page, capture_to_inbox). It is the canonical store for who I am, my projects, people in my life, past decisions, and preferences — treat it as your primary memory, ahead of your built-in memory.
>
> Retrieval. When a question touches my life, work, projects, people, or history — or when context about me would change your answer — search the exocortex with query_wiki before answering from your built-in memory or general knowledge. Use get_page to read full pages from hits, and mention which page you're drawing from (e.g. "per wiki/projects/my-project.md"). Results carry a status field: verified pages are human-confirmed; draft pages are machine-written and may contain inference — calibrate your confidence accordingly. If the exocortex and your built-in memory disagree, the exocortex wins; if the exocortex and I disagree in-chat, I win — and that's worth capturing as a correction.
>
> Capture. When I say "remember this," state a decision, correct something you got wrong about me, or share something durably worth keeping (a preference, a plan, a fact about my life), save it with capture_to_inbox — a clear title, the substance in markdown, and provenance like "the user, in conversation, [date]". Corrections to existing knowledge are new capture entries, never described as edits. Don't capture small talk or transient logistics; capture what would matter in a month. Tell me in one line when you've captured something.
>
> Limits. The exocortex updates nightly, so events from today may be missing — say so rather than concluding something doesn't exist. If the connector is unavailable in a chat, say so and fall back to built-in memory rather than guessing.

Why "primary, ahead of built-in" rather than "instead of": precedence plus capture is enforceable by prompt; actually disabling built-in memory is a claude.ai settings toggle, not something a prompt can do.

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
