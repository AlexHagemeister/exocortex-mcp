import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// End-to-end over the MCP protocol: each tier's manifest and tool behavior,
// served from a real git mirror cloned off a fixture repo. Env must be in
// place before server.ts (and config.ts under it) loads, so everything is
// dynamically imported after `before`.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exo-manifest-test-"));
const fixture = path.join(tmp, "fixture");
process.env.DATA_DIR = path.join(tmp, "data");
process.env.MIRROR_REPO_URL = fixture;
process.env.SYNC_INTERVAL_SECONDS = "3600";
process.env.EXOCORTEX_TOKEN = "owner-token-of-sufficient-length";
process.env.EXOCORTEX_GUEST_TOKEN = "guest-token-of-sufficient-length";
process.env.EXOCORTEX_PUBLIC_TOKEN = "public-token-of-sufficient-length";
process.env.EXOCORTEX_OWNER_NAME = "Alex";
process.env.EXOCORTEX_PUBLIC_DENY = "wiki/life/health/";
process.env.EXOCORTEX_PUBLIC_REDACT = "pangolin, big stick";

function write(rel: string, body: string) {
  const abs = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}
const page = (title: string, body: string) =>
  `---\ntitle: "${title}"\ndescription: "${title} page"\nstatus: draft\n---\n# ${title}\n\n${body}\n`;

before(() => {
  write(
    "wiki/projects/kairoscope.md",
    page(
      "Kairoscope",
      "A public project about pelicans.\n\nFunded by Pangolin Corp, quietly.\n\n" +
        "- pelican item\n- big stick item\n\n## Pangolin era\n\nHidden history.\n\n## Aftermath\n\nStill pelicans."
    )
  );
  write("wiki/projects/pangolin-deal.md", page("The deal", "Named for it in the path; pelicans."));
  write("wiki/projects/shindig.md", page("Big Stick Shindig", "Named for it in the title; pelicans."));
  write("wiki/life/pursuit.md", page("Pursuit", "What Alex is after: pelicans too."));
  write("wiki/life/health/back.md", page("Back", "Private health detail: zebrafish."));
  write("wiki/people/anna.md", page("Anna", "A friend. Likes zebrafish."));
  write("wiki/log/2026-09-01.md", page("Day log", "Zebrafish all day."));
  write("wiki/chronicle/2026-09-01-tue.md", page("Chronicle", "More zebrafish."));
  write("notes/private.md", "SECRET zebrafish");
  write("sources/inbox/2026-09-01-x.md", "source zebrafish");
  fs.symlinkSync(path.join("..", "notes", "private.md"), path.join(fixture, "wiki", "shortcut.md"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: fixture });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Role = "owner" | "guest" | "public";

async function connect(role: Role): Promise<Client> {
  const { buildServer } = await import("../src/server.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildServer(role, "test").connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

async function toolNames(role: Role): Promise<string[]> {
  const c = await connect(role);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  await c.close();
  return names;
}

async function text(c: Client, name: string, args: Record<string, unknown>) {
  const r = (await c.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return { text: r.content.map((x) => x.text ?? "").join("\n"), isError: r.isError === true };
}

test("each tier lists exactly its own tools", async () => {
  assert.deepEqual(await toolNames("owner"), ["capture_to_inbox", "get_page", "query_wiki"]);
  assert.deepEqual(await toolNames("guest"), ["get_page", "leave_note_for_alex", "query_wiki"]);
  assert.deepEqual(await toolNames("public"), ["get_page", "query_wiki"]);
});

test("public: no write tool is callable, by either tier's name", async () => {
  const c = await connect("public");
  for (const name of ["capture_to_inbox", "leave_note_for_alex"]) {
    let failed = false;
    try {
      const r = await text(c, name, { title: "x", content: "y", note: "y", from: "z", provenance: "p" });
      failed = r.isError;
    } catch {
      failed = true;
    }
    assert.ok(failed, `${name} must not be callable on the public tier`);
  }
  await c.close();
});

test("public: out-of-scope reads answer exactly like missing paths", async () => {
  const c = await connect("public");
  const missing = await text(c, "get_page", { path: "wiki/nope.md" });
  assert.equal(missing.isError, true);
  assert.equal(missing.text, "Not found: wiki/nope.md");
  for (const p of [
    "wiki/people/anna.md",
    "wiki/people",
    "wiki/log/2026-09-01.md",
    "wiki/chronicle/2026-09-01-tue.md",
    "wiki/life/health/back.md",
    "wiki/life/health",
    "wiki/LIFE/Health/back.md",
    "wiki/projects/../people/anna.md",
    "wiki/shortcut.md",
    "notes/private.md",
    "sources/inbox/2026-09-01-x.md",
    "CONSTITUTION.md",
  ]) {
    const r = await text(c, "get_page", { path: p });
    assert.equal(r.isError, true, p);
    assert.equal(r.text, `Not found: ${p}`, p);
  }
  await c.close();
});

test("public: in-scope reads and filtered listings", async () => {
  const c = await connect("public");
  const kairo = await text(c, "get_page", { path: "wiki/projects/kairoscope.md" });
  assert.equal(kairo.isError, false);
  assert.match(kairo.text, /pelicans/);
  assert.doesNotMatch(kairo.text, /pangolin|big stick|Hidden history/i);
  assert.match(kairo.text, /pelican item/);
  assert.match(kairo.text, /Still pelicans/);
  const after = await text(c, "get_page", { path: "wiki/projects/kairoscope.md", section: "Aftermath" });
  assert.match(after.text, /Still pelicans/);
  const era = await text(c, "get_page", { path: "wiki/projects/kairoscope.md", section: "Pangolin era" });
  assert.equal(era.isError, true);
  for (const p of ["wiki/projects/pangolin-deal.md", "wiki/projects/shindig.md"]) {
    const r = await text(c, "get_page", { path: p });
    assert.equal(r.isError, true, p);
    assert.equal(r.text, `Not found: ${p}`);
  }
  const projects = await text(c, "get_page", { path: "wiki/projects" });
  assert.deepEqual(projects.text.split("\n").slice(1), ["kairoscope.md"]);
  const sect = await text(c, "get_page", { path: "wiki/life/pursuit.md", section: "Pursuit" });
  assert.match(sect.text, /pelicans too/);
  const root = await text(c, "get_page", { path: "wiki" });
  assert.equal(root.isError, false);
  const entries = root.text.split("\n").slice(1);
  assert.deepEqual(entries, ["life/", "projects/"]);
  const life = await text(c, "get_page", { path: "wiki/life" });
  assert.deepEqual(life.text.split("\n").slice(1), ["pursuit.md"]);
  await c.close();
});

test("public: search never surfaces denied or non-wiki content", async () => {
  const c = await connect("public");
  const hidden = await text(c, "query_wiki", { query: "zebrafish" });
  assert.equal(hidden.text, 'No wiki pages matched "zebrafish".');
  const shown = await text(c, "query_wiki", { query: "pelicans" });
  assert.match(shown.text, /wiki\/projects\/kairoscope\.md/);
  assert.match(shown.text, /wiki\/life\/pursuit\.md/);
  assert.doesNotMatch(shown.text, /people|health|log\/|chronicle|notes\/|sources\//);
  // pages named for a term never appear, even when they match the query
  assert.doesNotMatch(shown.text, /pangolin-deal|shindig/);
  // a term cannot be searched for, and cannot reach a snippet or full body
  const term = await text(c, "query_wiki", { query: "pangolin" });
  assert.equal(term.text, 'No wiki pages matched "pangolin".');
  const stick = await text(c, "query_wiki", { query: "big stick" });
  assert.equal(stick.text, 'No wiki pages matched "big stick".');
  const quiet = await text(c, "query_wiki", { query: "quietly funded" });
  assert.doesNotMatch(quiet.text, /pangolin/i);
  await c.close();
});

test("guest and owner tiers are untouched by the public deny list", async () => {
  const g = await connect("guest");
  const anna = await text(g, "get_page", { from: "Test", path: "wiki/people/anna.md" });
  assert.equal(anna.isError, false);
  assert.match(anna.text, /zebrafish/);
  const health = await text(g, "get_page", { from: "Test", path: "wiki/life/health/back.md" });
  assert.equal(health.isError, false);
  // the term list is public-only
  const kairo = await text(g, "get_page", { from: "Test", path: "wiki/projects/kairoscope.md" });
  assert.match(kairo.text, /Pangolin Corp/);
  const found = await text(g, "query_wiki", { from: "Test", query: "pangolin" });
  assert.match(found.text, /kairoscope|pangolin-deal/);
  const log = await text(g, "get_page", { from: "Test", path: "wiki/log/2026-09-01.md" });
  assert.equal(log.isError, true);
  await g.close();
  const o = await connect("owner");
  const note = await text(o, "get_page", { path: "notes/private.md" });
  assert.equal(note.isError, false);
  assert.match(note.text, /SECRET/);
  await o.close();
});
