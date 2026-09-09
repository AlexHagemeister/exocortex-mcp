import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PUBLIC_ALLOW,
  DEFAULT_PUBLIC_DENY,
  publicAncestorPath,
  publicTokenProblem,
  publicWikiPath,
  type PublicScope,
} from "../src/public.js";
import { matchToken } from "../src/auth.js";

const defaults: PublicScope = { allow: DEFAULT_PUBLIC_ALLOW, deny: DEFAULT_PUBLIC_DENY };

test("default scope: wiki/ minus log, chronicle, connections, people", () => {
  assert.equal(publicWikiPath("wiki/projects/kairoscope.md", defaults), "wiki/projects/kairoscope.md");
  assert.equal(publicWikiPath("wiki/life/pursuit.md", defaults), "wiki/life/pursuit.md");
  assert.equal(publicWikiPath("wiki", defaults), "wiki");
  assert.equal(publicWikiPath("wiki/log/2026-08-06.md", defaults), null);
  assert.equal(publicWikiPath("wiki/log.md", defaults), null);
  assert.equal(publicWikiPath("wiki/chronicle/2026-08-19-wed.md", defaults), null);
  assert.equal(publicWikiPath("wiki/chronicle", defaults), null);
  assert.equal(publicWikiPath("wiki/connections/a-b.md", defaults), null);
  assert.equal(publicWikiPath("wiki/people/anna.md", defaults), null);
  assert.equal(publicWikiPath("wiki/people", defaults), null);
});

test("everything outside wiki/ is out of scope, allowlist or not", () => {
  const wide: PublicScope = { allow: ["wiki/", "sources/", "notes/", "/"], deny: [] };
  assert.equal(publicWikiPath("sources/inbox/2026-08-01-note.md", wide), null);
  assert.equal(publicWikiPath("notes/private.md", wide), null);
  assert.equal(publicWikiPath("CONSTITUTION.md", wide), null);
  assert.equal(publicWikiPath("", wide), null);
  assert.equal(publicWikiPath("wikish/page.md", wide), null);
});

test("allowlist narrows to a folder, and prefix match is on path segments", () => {
  const scope: PublicScope = { allow: ["wiki/projects/"], deny: DEFAULT_PUBLIC_DENY };
  assert.equal(publicWikiPath("wiki/projects/x.md", scope), "wiki/projects/x.md");
  assert.equal(publicWikiPath("wiki/projects", scope), "wiki/projects");
  assert.equal(publicWikiPath("wiki/projects-archive/x.md", scope), null);
  assert.equal(publicWikiPath("wiki/concepts/x.md", scope), null);
  assert.equal(publicWikiPath("wiki/life/pursuit.md", scope), null);
  assert.equal(publicWikiPath("wiki", scope), null);
});

test("allowlist can name a single file", () => {
  const scope: PublicScope = { allow: ["wiki/life/pursuit.md"], deny: DEFAULT_PUBLIC_DENY };
  assert.equal(publicWikiPath("wiki/life/pursuit.md", scope), "wiki/life/pursuit.md");
  assert.equal(publicWikiPath("wiki/life/pursuit.md/extra", scope), null);
  assert.equal(publicWikiPath("wiki/life/pursuit.md.bak", scope), null);
  assert.equal(publicWikiPath("wiki/life/housing.md", scope), null);
});

test("deny wins inside an allow, as folder or single file", () => {
  const scope: PublicScope = {
    allow: ["wiki/life/"],
    deny: [...DEFAULT_PUBLIC_DENY, "wiki/life/health/", "wiki/life/dating.md"],
  };
  assert.equal(publicWikiPath("wiki/life/pursuit.md", scope), "wiki/life/pursuit.md");
  assert.equal(publicWikiPath("wiki/life/health/x.md", scope), null);
  assert.equal(publicWikiPath("wiki/life/health", scope), null);
  assert.equal(publicWikiPath("wiki/life/dating.md", scope), null);
  // a deny that covers the whole allow leaves nothing readable
  const dead: PublicScope = { allow: ["wiki/life/"], deny: ["wiki/life/"] };
  assert.equal(publicWikiPath("wiki/life/pursuit.md", dead), null);
  assert.equal(publicWikiPath("wiki/life", dead), null);
});

test("case variation cannot bypass the deny list or widen the allow list", () => {
  assert.equal(publicWikiPath("wiki/PEOPLE/anna.md", defaults), null);
  assert.equal(publicWikiPath("wiki/Chronicle/2026-08-19-wed.md", defaults), null);
  assert.equal(publicWikiPath("WIKI/log/2026-08-06.md", defaults), null);
  const scope: PublicScope = {
    allow: ["wiki/Projects/"],
    deny: [...DEFAULT_PUBLIC_DENY, "wiki/projects/Secret/"],
  };
  assert.equal(publicWikiPath("wiki/projects/x.md", scope), "wiki/projects/x.md");
  assert.equal(publicWikiPath("wiki/PROJECTS/x.md", scope), "wiki/PROJECTS/x.md");
  assert.equal(publicWikiPath("wiki/projects/secret/x.md", scope), null);
  assert.equal(publicWikiPath("wiki/projects/SECRET/x.md", scope), null);
});

test("traversal and dot segments cannot escape the scope", () => {
  const scope: PublicScope = { allow: ["wiki/projects/"], deny: DEFAULT_PUBLIC_DENY };
  assert.equal(publicWikiPath("wiki/projects/../people/anna.md", scope), null);
  assert.equal(publicWikiPath("wiki/projects/../../notes/x.md", scope), null);
  assert.equal(publicWikiPath("../wiki/projects/x.md", scope), null);
  assert.equal(publicWikiPath("wiki/projects/.hidden/x.md", scope), null);
  assert.equal(publicWikiPath("wiki/.obsidian/config", defaults), null);
  assert.equal(publicWikiPath("wiki\\people\\anna.md", defaults), null);
  // normalization that stays inside the allow is fine
  assert.equal(publicWikiPath("wiki/projects/a/../b.md", scope), "wiki/projects/b.md");
  assert.equal(publicWikiPath("./wiki/projects/x.md", scope), "wiki/projects/x.md");
});

test("operator-typed decorations on allow entries are tolerated", () => {
  for (const entry of ["wiki/projects", "wiki/projects/", "./wiki/projects/", "/wiki/projects"]) {
    const scope: PublicScope = { allow: [entry], deny: [] };
    assert.equal(publicWikiPath("wiki/projects/x.md", scope), "wiki/projects/x.md", entry);
  }
  assert.equal(publicWikiPath("wiki/projects/x.md", { allow: ["", "  "], deny: [] }), null);
});

test("ancestors of an allow entry are listable, nothing else is", () => {
  const scope: PublicScope = { allow: ["wiki/life/pursuit.md"], deny: DEFAULT_PUBLIC_DENY };
  assert.equal(publicAncestorPath("wiki", scope), "wiki");
  assert.equal(publicAncestorPath("wiki/life", scope), "wiki/life");
  assert.equal(publicAncestorPath("wiki/life/", scope), "wiki/life");
  assert.equal(publicAncestorPath("wiki/li", scope), null);
  assert.equal(publicAncestorPath("wiki/projects", scope), null);
  // a readable path is not an ancestor, and a denied ancestor stays denied
  assert.equal(publicAncestorPath("wiki/life/pursuit.md", scope), null);
  const denied: PublicScope = { allow: ["wiki/people/anna.md"], deny: DEFAULT_PUBLIC_DENY };
  assert.equal(publicAncestorPath("wiki/people", denied), null);
  assert.equal(publicWikiPath("wiki/people/anna.md", denied), null);
  // with the default allow of wiki/, nothing is a strict ancestor
  assert.equal(publicAncestorPath("wiki", defaults), null);
});

test("public token must differ from both other secrets and be a secret", () => {
  const owner = "owner-token-of-sufficient-length";
  const guest = "guest-token-of-sufficient-length";
  assert.equal(publicTokenProblem("public-token-of-sufficient-length", owner, guest, "Alex"), null);
  assert.equal(publicTokenProblem("public-token-of-sufficient-length", owner, undefined, "Alex"), null);
  assert.match(publicTokenProblem(owner, owner, guest, "Alex") ?? "", /differ from EXOCORTEX_TOKEN/);
  assert.match(publicTokenProblem(guest, owner, guest, "Alex") ?? "", /differ from EXOCORTEX_GUEST_TOKEN/);
  assert.match(publicTokenProblem("short", owner, guest, "Alex") ?? "", /too short/);
  assert.match(publicTokenProblem("public-token-of-sufficient-length", owner, guest, undefined) ?? "", /OWNER_NAME/);
  assert.match(publicTokenProblem("public-token-of-sufficient-length", owner, guest, "") ?? "", /OWNER_NAME/);
});

test("token matching picks the tier, and unset tiers cannot be reached", () => {
  const all = {
    token: "owner-token-of-sufficient-length",
    guestToken: "guest-token-of-sufficient-length",
    publicToken: "public-token-of-sufficient-length",
  };
  assert.equal(matchToken(all.token, all), "owner");
  assert.equal(matchToken(all.guestToken, all), "guest");
  assert.equal(matchToken(all.publicToken, all), "public");
  assert.equal(matchToken("nope", all), null);
  assert.equal(matchToken("", all), null);
  const ownerOnly = { token: all.token };
  assert.equal(matchToken(all.guestToken, ownerOnly), null);
  assert.equal(matchToken(all.publicToken, ownerOnly), null);
  assert.equal(matchToken(all.token, ownerOnly), "owner");
  // an empty configured secret never matches an empty presented token
  assert.equal(matchToken("", { token: all.token, publicToken: "" }), null);
});
