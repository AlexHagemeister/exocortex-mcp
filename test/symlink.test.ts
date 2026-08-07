import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// realRelPath reads MIRROR_DIR from config, so the fixture env must be in
// place before the module loads (each test file runs in its own process).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exo-symlink-test-"));
process.env.DATA_DIR = tmp;
process.env.MIRROR_REPO_URL = "/tmp/unused";
process.env.EXOCORTEX_TOKEN = "test-token-of-sufficient-length";

const mirror = path.join(tmp, "mirror");

before(() => {
  fs.mkdirSync(path.join(mirror, "wiki"), { recursive: true });
  fs.mkdirSync(path.join(mirror, "notes"), { recursive: true });
  fs.writeFileSync(path.join(mirror, "notes", "private.md"), "SECRET");
  fs.writeFileSync(path.join(mirror, "wiki", "page.md"), "public");
  // symlink to a file elsewhere in the mirror
  fs.symlinkSync(
    path.join("..", "notes", "private.md"),
    path.join(mirror, "wiki", "shortcut.md")
  );
  // symlinked directory
  fs.symlinkSync(path.join("..", "notes"), path.join(mirror, "wiki", "notesdir"));
  // symlink escaping the mirror entirely
  fs.symlinkSync(os.tmpdir(), path.join(mirror, "wiki", "outside"));
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("realRelPath reports where a symlink actually points", async () => {
  const { realRelPath } = await import("../src/mirror.js");
  assert.equal(await realRelPath("wiki/shortcut.md"), "notes/private.md");
  assert.equal(await realRelPath("wiki/notesdir/private.md"), "notes/private.md");
});

test("realRelPath returns null for symlinks escaping the mirror", async () => {
  const { realRelPath } = await import("../src/mirror.js");
  assert.equal(await realRelPath("wiki/outside"), null);
});

test("realRelPath passes through honest and missing paths", async () => {
  const { realRelPath } = await import("../src/mirror.js");
  assert.equal(await realRelPath("wiki/page.md"), "wiki/page.md");
  assert.equal(await realRelPath("wiki/nope.md"), "wiki/nope.md");
});

test("the guest guard rejects what symlinks resolve to", async () => {
  const { realRelPath } = await import("../src/mirror.js");
  const { guestWikiPath } = await import("../src/guest.js");
  // the combination used by the guest get_page handler
  const real = await realRelPath("wiki/shortcut.md");
  assert.equal(real === null || guestWikiPath(real) === null ? "blocked" : "allowed", "blocked");
});

test("listMarkdown skips symlinked markdown files", async () => {
  const { listMarkdown } = await import("../src/mirror.js");
  const files = await listMarkdown("wiki");
  assert.deepEqual(files.sort(), ["wiki/page.md"]);
});
