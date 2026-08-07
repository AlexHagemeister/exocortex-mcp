import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GUEST_DENY,
  guestProvenance,
  guestWikiPath,
  ownerNameSlug,
  ownerToolSlug,
} from "../src/guest.js";

test("wiki pages and the wiki root are in scope", () => {
  assert.equal(guestWikiPath("wiki/projects/kairoscope.md"), "wiki/projects/kairoscope.md");
  assert.equal(guestWikiPath("wiki"), "wiki");
  assert.equal(guestWikiPath("wiki/"), "wiki");
  assert.equal(guestWikiPath("./wiki/concepts/x.md"), "wiki/concepts/x.md");
});

test("everything outside wiki/ is out of scope", () => {
  assert.equal(guestWikiPath("sources/inbox/2026-08-01-note.md"), null);
  assert.equal(guestWikiPath("notes/private.md"), null);
  assert.equal(guestWikiPath("CONSTITUTION.md"), null);
  assert.equal(guestWikiPath(".state/issues"), null);
  assert.equal(guestWikiPath(""), null);
  assert.equal(guestWikiPath("."), null);
  // prefix match must be on path segments, not string prefix
  assert.equal(guestWikiPath("wikish/page.md"), null);
});

test("day logs are denied by default, as files, listing, and derived index", () => {
  assert.equal(guestWikiPath("wiki/log/2026-08-06.md"), null);
  assert.equal(guestWikiPath("wiki/log"), null);
  assert.equal(guestWikiPath("wiki/log/"), null);
  assert.equal(guestWikiPath("wiki/log.md"), null);
});

test("case variation cannot bypass the deny list (case-insensitive filesystems)", () => {
  assert.equal(guestWikiPath("wiki/LOG/2026-08-06.md"), null);
  assert.equal(guestWikiPath("wiki/Log/2026-08-06.md"), null);
  assert.equal(guestWikiPath("wiki/LOG.md"), null);
  assert.equal(guestWikiPath("WIKI/log/2026-08-06.md"), null);
  const deny = [...DEFAULT_GUEST_DENY, "wiki/people/"];
  assert.equal(guestWikiPath("wiki/People/anna.md", deny), null);
  // case-folded scope check still admits in-scope paths
  assert.notEqual(guestWikiPath("WIKI/projects/x.md"), null);
});

test("dot-prefixed segments are refused (listings already hide them)", () => {
  assert.equal(guestWikiPath("wiki/.DS_Store"), null);
  assert.equal(guestWikiPath("wiki/.obsidian/config"), null);
  assert.equal(guestWikiPath("wiki/.hidden/page.md"), null);
});

test("traversal cannot escape the scope", () => {
  assert.equal(guestWikiPath("wiki/../sources/inbox"), null);
  assert.equal(guestWikiPath("../wiki/page.md"), null);
  assert.equal(guestWikiPath("wiki/../../etc/passwd"), null);
  assert.equal(guestWikiPath("/wiki/../notes/x.md"), null);
  // normalization that stays inside wiki/ is fine
  assert.equal(guestWikiPath("wiki/projects/../concepts/x.md"), "wiki/concepts/x.md");
});

test("extra deny prefixes extend the default list", () => {
  const deny = [...DEFAULT_GUEST_DENY, "wiki/people/"];
  assert.equal(guestWikiPath("wiki/people/anna.md", deny), null);
  assert.equal(guestWikiPath("wiki/log/2026-08-06.md", deny), null);
  assert.equal(guestWikiPath("wiki/projects/x.md", deny), "wiki/projects/x.md");
});

test("guest provenance leads with the guest marker, whatever the name", () => {
  assert.equal(
    guestProvenance("Anna", "2026-08-06"),
    'guest connector: Anna (via their Claude), 2026-08-06'
  );
  // a name of "the user" or the owner's name can't make the line start like
  // an owner provenance string
  assert.ok(guestProvenance("the user", "2026-08-06").startsWith("guest connector:"));
});

test("yamlEscape folds newlines so hostile input can't corrupt frontmatter", async () => {
  // capture.ts transitively requires config's env vars; satisfy them first.
  process.env.MIRROR_REPO_URL ??= "/tmp/unused";
  process.env.EXOCORTEX_TOKEN ??= "test-token-of-sufficient-length";
  const { yamlEscape } = await import("../src/capture.js");
  assert.equal(yamlEscape('Anna\n---\ninjected: yes\n---'), '"Anna\\n---\\ninjected: yes\\n---"');
  assert.equal(yamlEscape("a\r\nb\rc"), '"a\\nb\\nc"');
  assert.equal(yamlEscape('say "hi"'), '"say \\"hi\\""');
});

test("escaped frontmatter round-trips through gray-matter, hostile or benign", async () => {
  process.env.MIRROR_REPO_URL ??= "/tmp/unused";
  process.env.EXOCORTEX_TOKEN ??= "test-token-of-sufficient-length";
  const { yamlEscape } = await import("../src/capture.js");
  const { default: matter } = await import("gray-matter");
  const hostileType = 'Correction "quoted"\nsneaky: yes';
  const parsed = matter(`---\ntype: ${yamlEscape(hostileType)}\n---\nbody`);
  assert.equal(parsed.data.type, 'Correction "quoted"\nsneaky: yes');
  assert.ok(!("sneaky" in parsed.data));
  const benign = matter(`---\ntype: ${yamlEscape("Capture")}\n---\nx`);
  assert.equal(benign.data.type, "Capture");
});

test("owner name slugs", () => {
  assert.equal(ownerNameSlug("Alex"), "alex");
  assert.equal(ownerNameSlug("Alex H."), "alex-h");
  assert.equal(ownerToolSlug("Alex H."), "alex_h");
  assert.equal(ownerNameSlug("!!!"), "owner");
});
