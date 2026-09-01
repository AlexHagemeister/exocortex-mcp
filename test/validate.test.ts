import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkQuoteAttribution,
  checkSiblingCitations,
  validateCapture,
} from "../src/validate.js";

// Check 1: sibling citations by inbox path

test("a sibling named by basename wikilink passes", () => {
  const body = "Follows up on [[2026-09-01-standup-notes]]. The inbox folder (sources/inbox/) is drained daily.";
  assert.equal(checkSiblingCitations(body), null);
});

test("a sibling cited by sources/inbox/ path is rejected, and the fix names the wikilink", () => {
  const body = "See sources/inbox/2026-09-01-standup-notes.md for the earlier thread.";
  const err = checkSiblingCitations(body);
  assert.ok(err);
  assert.ok(err.includes("sources/inbox/2026-09-01-standup-notes.md"));
  assert.ok(err.includes("[[2026-09-01-standup-notes]]"));
});

test("an inbox path inside a wikilink or backticks is still a path", () => {
  assert.ok(checkSiblingCitations("[[sources/inbox/2026-09-01-x]]"));
  assert.ok(checkSiblingCitations("`sources/inbox/2026-09-01-x.md`"));
});

// Check 2: unattributed blockquotes

test("a blockquote with a speaker line before it passes", () => {
  const body = ["the user, verbatim:", "", "> we should ship this on Tuesday", "", "Then discussion."].join("\n");
  assert.equal(checkQuoteAttribution(body), null);
});

test("a blockquote with a dash-led speaker-and-date line after it passes", () => {
  // em dash, en dash, hyphen (escaped so the literals never appear in source)
  for (const dash of ["\u2014", "\u2013", "-"]) {
    const body = ["> we should ship this on Tuesday", `${dash} Alex, 2026-09-01`].join("\n");
    assert.equal(checkQuoteAttribution(body), null, `dash ${JSON.stringify(dash)}`);
  }
});

test("a speaker signal inside the blockquote group counts", () => {
  const body = ["> ship it Tuesday", "> \u2014 the user, 2026-09-01"].join("\n");
  assert.equal(checkQuoteAttribution(body), null);
  assert.equal(checkQuoteAttribution("> As Anna wrote in the thread, ship it."), null);
});

test("a bare blockquote is rejected, and the fix names both attribution forms", () => {
  const body = ["Some context.", "", "", "> we should ship this on Tuesday", "", "", "More context."].join("\n");
  const err = checkQuoteAttribution(body);
  assert.ok(err);
  assert.ok(err.includes("line 4"));
  assert.ok(err.includes("the user, verbatim:"));
  assert.ok(err.includes("dash-led"));
});

test("a speaker signal three lines away does not count", () => {
  const body = ["the user, verbatim:", "", "", "> too far"].join("\n");
  assert.ok(checkQuoteAttribution(body));
});

test("a dash-led line needs a speaker word or a date", () => {
  assert.ok(checkQuoteAttribution(["> quote", "- emphasis mine"].join("\n")));
  assert.equal(checkQuoteAttribution(["> quote", "- 2026-09-01"].join("\n")), null);
});

test("blockquote markers inside fenced code are ignored", () => {
  const body = ["```", "> not a quote, a shell prompt", "```"].join("\n");
  assert.equal(checkQuoteAttribution(body), null);
});

// Tier wiring

test("owner tier runs both checks", () => {
  const body = ["See sources/inbox/2026-09-01-x.md.", "", "> unattributed"].join("\n");
  const errors = validateCapture(body, "owner");
  assert.equal(errors.length, 2);
});

test("guest tier passes through untouched", () => {
  const body = ["See sources/inbox/2026-09-01-x.md.", "", "> unattributed"].join("\n");
  assert.deepEqual(validateCapture(body, "guest"), []);
});

test("a clean owner capture has no errors", () => {
  const body = [
    "# Standup",
    "",
    "the user, verbatim:",
    "> we ship Tuesday",
    "",
    "Follows [[2026-09-01-standup-notes]].",
  ].join("\n");
  assert.deepEqual(validateCapture(body, "owner"), []);
});
