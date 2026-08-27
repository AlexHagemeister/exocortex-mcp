import assert from "node:assert/strict";
import { test } from "node:test";

// server.ts imports config.ts, which throws without these (same pattern as
// guest.test.ts); dynamic import below so the env is set first.
process.env.MIRROR_REPO_URL ??= "/tmp/unused";
process.env.EXOCORTEX_TOKEN ??= "test-token-of-sufficient-length";
const { extractSection } = await import("../src/server.js");

const body = [
  "# Page title",
  "",
  "## Fall 2026 enrollment state (CalCentral, 2026-07-24)",
  "enrollment body",
  "",
  "## Decision log",
  "decisions body",
  "",
  "## Decision log archive",
  "old decisions",
].join("\n");

test("exact heading match wins", () => {
  assert.equal(extractSection(body, "decision log"), "## Decision log\ndecisions body");
});

test("unique substring falls back to the matching heading", () => {
  assert.equal(
    extractSection(body, "enrollment state"),
    "## Fall 2026 enrollment state (CalCentral, 2026-07-24)\nenrollment body"
  );
});

test("ambiguous substring returns the candidate list", () => {
  const r = extractSection(body, "decision");
  assert.deepEqual(r, { ambiguous: ["Decision log", "Decision log archive"] });
});

test("no match returns null", () => {
  assert.equal(extractSection(body, "open actions"), null);
});
