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

test("guest provenance is composed server-side from name and date", () => {
  assert.equal(
    guestProvenance("Anna", "2026-08-06"),
    "Anna, via their Claude (guest connector), 2026-08-06"
  );
});

test("owner name slugs", () => {
  assert.equal(ownerNameSlug("Alex"), "alex");
  assert.equal(ownerNameSlug("Alex H."), "alex-h");
  assert.equal(ownerToolSlug("Alex H."), "alex_h");
  assert.equal(ownerNameSlug("!!!"), "owner");
});
