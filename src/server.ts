import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import matter from "gray-matter";
import { z } from "zod";
import { captureToInbox } from "./capture.js";
import { config } from "./config.js";
import {
  DEFAULT_GUEST_DENY,
  guestProvenance,
  guestWikiPath,
  ownerNameSlug,
  ownerToolSlug,
} from "./guest.js";
import {
  ensureFresh,
  listDir,
  readRepoFile,
  realRelPath,
  statRepoPath,
} from "./mirror.js";
import {
  DEFAULT_PUBLIC_ALLOW,
  DEFAULT_PUBLIC_DENY,
  compileTerms,
  mentions,
  publicAncestorPath,
  publicWikiPath,
  redactBody,
  redactPage,
  type PublicScope,
} from "./public.js";
import { queryWiki, type SearchScope, type WikiHit } from "./search.js";
import { validateCapture } from "./validate.js";
import type { Role } from "./auth.js";

export type { Role } from "./auth.js";

interface Heading {
  level: number;
  text: string;
  line: number;
}

/** List markdown headings, skipping fenced code blocks (where `# comment` lines lurk). */
function listHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) headings.push({ level: m[1].length, text: m[2], line: i });
  }
  return headings;
}

/**
 * Extract a named section: from its heading up to the next heading of the
 * same or higher level. Matches the full heading text first, then falls back
 * to a unique substring match — this vault's headings are long and dated, so
 * exact-only matching made natural requests miss. Returns null when nothing
 * matches; an ambiguous substring is an error listing the candidates.
 */
export function extractSection(
  body: string,
  section: string
): string | { ambiguous: string[] } | null {
  const lines = body.split("\n");
  const headings = listHeadings(lines);
  const wanted = section.trim().toLowerCase();
  let idx = headings.findIndex((h) => h.text.toLowerCase() === wanted);
  if (idx === -1) {
    const partial = headings
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h.text.toLowerCase().includes(wanted));
    if (partial.length === 0) return null;
    if (partial.length > 1) return { ambiguous: partial.map(({ h }) => h.text) };
    idx = partial[0].i;
  }
  const start = headings[idx].line;
  const next = headings
    .slice(idx + 1)
    .find((h) => h.level <= headings[idx].level);
  const end = next ? next.line : lines.length;
  return lines.slice(start, end).join("\n").trim();
}

function formatHits(query: string, hits: WikiHit[]): string {
  if (hits.length === 0) return `No wiki pages matched "${query}".`;
  return hits
    .map(
      (h) =>
        `## ${h.title}\n` +
        `path: ${h.path} · status: ${h.status} · score: ${h.score}\n` +
        (h.description ? `${h.description}\n` : "") +
        (h.snippet ? `> ${h.snippet}` : "") +
        (h.body ? `\n\n${h.body}` : "")
    )
    .join("\n\n");
}

/**
 * The get_page handler body, shared by the owner and guest tools. The guest
 * tool authorizes the path before calling and passes filterEntry so directory
 * listings omit entries outside the guest scope.
 */
async function getPage(
  relPath: string,
  mode: "full" | "frontmatter" | undefined,
  section: string | undefined,
  filterEntry?: (childRelPath: string) => boolean | Promise<boolean>,
  /** Rewrite file content before any mode or section handling (the public
   * tier's term redaction), so a section slice can never contain what the
   * full page would not. */
  transform?: (content: string) => string,
  /** Treat a directory with nothing listable as missing (the public tier),
   * so a fully hidden folder is not an oracle for its own existence. */
  emptyDirIsMissing = false
): Promise<CallToolResult> {
  await ensureFresh();
  if (mode === "frontmatter" && section !== undefined) {
    return {
      content: [
        { type: "text", text: "Pass either mode: 'frontmatter' or section, not both." },
      ],
      isError: true,
    };
  }
  const kind = await statRepoPath(relPath);
  if (kind === "missing") {
    return {
      content: [{ type: "text", text: `Not found: ${relPath}` }],
      isError: true,
    };
  }
  if (kind === "dir") {
    let entries = await listDir(relPath);
    if (filterEntry) {
      // Sequential on purpose: a filter may read each file, and a public
      // caller must not be able to fan that out.
      const kept: string[] = [];
      for (const e of entries) {
        if (await filterEntry(`${relPath}/${e.replace(/\/$/, "")}`)) kept.push(e);
      }
      entries = kept;
    }
    if (entries.length === 0 && emptyDirIsMissing) {
      return {
        content: [{ type: "text", text: `Not found: ${relPath}` }],
        isError: true,
      };
    }
    return {
      content: [
        { type: "text", text: `Directory ${relPath}:\n${entries.join("\n")}` },
      ],
    };
  }
  let content = await readRepoFile(relPath);
  if (transform) content = transform(content);
  if (mode === "frontmatter") {
    // Textual extraction: gray-matter's `.matter` property is dropped from
    // its parse cache, so it is unreliable once search has parsed the page.
    const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
    return {
      content: [
        { type: "text", text: m ? m[1].trim() : `No frontmatter in ${relPath}.` },
      ],
    };
  }
  if (section !== undefined) {
    let body = content;
    try {
      body = matter(content).content;
    } catch {
      // treat the whole file as body
    }
    const slice = extractSection(body, section);
    if (slice !== null && typeof slice === "object") {
      return {
        content: [
          {
            type: "text",
            text:
              `Section "${section}" is ambiguous in ${relPath} — it matches: ` +
              slice.ambiguous.join(" · "),
          },
        ],
        isError: true,
      };
    }
    if (slice === null) {
      const available = listHeadings(body.split("\n"))
        .map((h) => h.text)
        .join(", ");
      return {
        content: [
          {
            type: "text",
            text:
              `No section "${section}" in ${relPath}.` +
              (available ? ` Sections: ${available}` : " The page has no headings."),
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: slice }] };
  }
  return { content: [{ type: "text", text: content }] };
}

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

/**
 * One deployment, three faces: the token a connection authenticated with
 * picks which manifest it sees. The owner gets the full three-tool server; a
 * guest gets a read-only view of wiki/ plus a note drop, described in the
 * third person for an agent that has never heard of this vault; the public
 * gets two read tools over an allowlisted slice of wiki/ and nothing else.
 */
export function buildServer(role: Role, clientHint?: string): McpServer {
  switch (role) {
    case "guest":
      return buildGuestServer(clientHint);
    case "public":
      return buildPublicServer();
    default:
      return buildOwnerServer(clientHint);
  }
}

/**
 * Three tools only, mirroring the vault's own contract: two reads over the
 * wiki, and capture_to_inbox as the sole write — knowledge enters the wiki
 * only through sources/inbox/ (the single-pipeline rule).
 */
function buildOwnerServer(clientHint?: string): McpServer {
  const server = new McpServer(
    { name: "exocortex", version },
    {
      instructions:
        "Capture contract — binds every capture_to_inbox call. A capture is a frozen record " +
        "of what was said, consumed by a pipeline that trusts its attribution, so: " +
        "(1) Put the user's exact words in marked quotes with a speaker (e.g. `the user, verbatim: \"...\"`). " +
        "Unmarked text is treated downstream as your paraphrase and can never be promoted to " +
        "verified truth — unquoted user speech is information lost at capture time. " +
        "(2) Never file your own material under the user's name. Research you performed, background " +
        "you supplied, and conclusions you drew go in a separate section attributed to you " +
        "(e.g. `## Agent research` / `## Agent conclusions`), with URLs for anything looked up. " +
        "A capture whose provenance says only 'the user' must contain only what the user said. " +
        "(3) Name each claim's speaker so attribution is recoverable per claim, not just per file. " +
        "(4) Never write a guess or interpretation with the typography of fact — mark inference " +
        "as inference, and when part of a capture is uncertain, say which part. " +
        "(5) Name a sibling capture by its basename wikilink ([[2026-08-28-example-capture]]), " +
        "never by its sources/inbox/ path, which dies the moment either file is filed. " +
        "The server enforces two of these at write time and rejects the capture with the fix named: " +
        "every blockquote needs a speaker signal within it or the two lines around it (1), and " +
        "no sources/inbox/ path may appear (5).",
    }
  );

  server.registerTool(
    "query_wiki",
    {
      title: "Query the exocortex vault",
      description:
        "Status-weighted search over the vault. Default scope 'all' covers the wiki (compiled " +
        "knowledge: concepts, projects, people, life, connections), sources (frozen records of " +
        "what was said — meeting transcripts, session captures, statements), and notes (the " +
        "user's own words). Results are ranked with `verified` wiki pages weighted above " +
        "`draft` — trust is graduated, and a mostly-draft wiki is healthy. Hits are summaries " +
        "(title, description, path, status, a matched-text snippet). Use get_page to read a " +
        "hit, or detail: 'full' only when you truly need every matching page's body inline.",
      inputSchema: {
        query: z.string().describe("Search terms, e.g. 'kairoscope design spec'"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8)"),
        detail: z
          .enum(["concise", "full"])
          .optional()
          .describe("'concise' (default) returns summaries; 'full' includes each page's body"),
        scope: z
          .enum(["all", "wiki", "sources", "notes"])
          .optional()
          .describe(
            "'all' (default) searches every layer; narrow to 'wiki' (compiled pages), " +
              "'sources' (frozen records), or 'notes' (the user's own notes)"
          ),
      },
    },
    async ({ query, limit, detail, scope }) => {
      const hits = await queryWiki(
        query,
        limit ?? 8,
        detail ?? "concise",
        undefined,
        (scope as SearchScope | undefined) ?? "all"
      );
      return { content: [{ type: "text", text: formatHits(query, hits) }] };
    }
  );

  server.registerTool(
    "get_page",
    {
      title: "Read a vault page",
      description:
        "Read a file from the vault by repo-relative path (e.g. 'wiki/projects/kairoscope.md', " +
        "'CONSTITUTION.md'). Pass a directory path to list its contents. When you only need part " +
        "of a page, ask for a slice: mode: 'frontmatter' returns just the metadata block, and " +
        "section: '<heading>' returns just that section (full heading text or a unique " +
        "substring of it). Content is read from the git mirror, which syncs from the vault's " +
        "hourly snapshots — typically fresh to within the hour.",
      inputSchema: {
        path: z.string().describe("Repo-relative path to a file or directory"),
        mode: z
          .enum(["full", "frontmatter"])
          .optional()
          .describe("'full' (default) returns the whole file; 'frontmatter' just its metadata block"),
        section: z
          .string()
          .optional()
          .describe("Return only the named section (heading text, case-insensitive)"),
      },
    },
    async ({ path: relPath, mode, section }) => getPage(relPath, mode, section)
  );

  server.registerTool(
    "capture_to_inbox",
    {
      title: "Capture to the vault inbox",
      description:
        "The only write path. Saves a markdown note into the vault's sources/inbox/ (via the " +
        "mirror's inbox-drops branch); the vault's ingest pipeline files it from there. Use for " +
        "anything worth keeping: decisions, ideas, corrections, things the user says to remember. " +
        "Corrections to existing wiki content also go here — never described as edits, always as " +
        "new statements with provenance. Write the capture to survive audit (the server " +
        "instructions carry the full contract): the user's exact words as marked quotes with a " +
        "speaker; your own research or conclusions in a separate section attributed to you, with " +
        "URLs; inference marked as inference, never written as fact.",
      inputSchema: {
        title: z.string().describe("Short title for the capture"),
        content: z.string().describe("Markdown body of the capture"),
        description: z
          .string()
          .optional()
          .describe("One-line summary for the frontmatter"),
        type: z
          .string()
          .optional()
          .describe("Source type, e.g. 'Capture' (default), 'Correction', 'Idea'"),
        provenance: z
          .string()
          .trim()
          .min(1, "provenance is required: who spoke, when, on which surface")
          .describe(
            "Who spoke, when, on which surface — e.g. 'the user, 2026-07-17, in conversation " +
              "(Claude mobile app)'. If the capture mixes the user's speech with your own " +
              "research or conclusions, say so here (e.g. 'the user + agent research, …') and " +
              "keep the two separated in the body."
          ),
      },
    },
    async (input) => {
      // Owner tier only: the guest note tool below never runs these checks.
      const problems = validateCapture(input.content, "owner");
      if (problems.length > 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "Capture rejected, nothing was written. Fix and resend:\n" +
                problems.map((p) => `- ${p}`).join("\n"),
            },
          ],
          isError: true,
        };
      }
      const relPath = await captureToInbox({ ...input, client: clientHint });
      return {
        content: [
          {
            type: "text",
            text:
              `Captured to ${relPath} on the '${"inbox-drops"}' branch of the mirror. ` +
              `It will land in the vault when the local consumer runs.`,
          },
        ],
      };
    }
  );

  return server;
}

/**
 * The guest face: what a trusted friend's Claude sees. Reads are scoped to
 * wiki/ (minus the day logs and any configured deny list); the only write is
 * a note drop whose provenance the server composes itself. Every tool
 * requires `from` so the query log and the inbox both say who, not "guest".
 */
function buildGuestServer(clientHint?: string): McpServer {
  const owner = config.ownerName;
  const deny = [...DEFAULT_GUEST_DENY, ...config.guestDeny];
  const noteTool = `leave_note_for_${ownerToolSlug(owner)}`;
  const fromField = z
    .string()
    .trim()
    .min(1, "from is required: the name of the person you are assisting")
    .describe(
      `The name of the person you are assisting (e.g. 'Anna'), so ${owner} ` +
        "can see who asked. Use their real name, never a placeholder."
    );
  // Whitespace (incl. newlines) folds to single spaces: these lines are the
  // query log, and agent-supplied text must not be able to forge entries.
  const log = (from: string, line: string) =>
    console.log(
      `[guest] ${from.replace(/\s+/g, " ")}: ${line.replace(/\s+/g, " ")}`
    );
  const outOfScope = (relPath: string): CallToolResult => ({
    content: [
      {
        type: "text",
        text: `Guest access covers pages under wiki/ only; '${relPath}' is out of scope.`,
      },
    ],
    isError: true,
  });

  const server = new McpServer(
    { name: `${ownerNameSlug(owner)}-exocortex`, version },
    {
      instructions:
        `You are connected to ${owner}'s exocortex as a guest. This is ${owner}'s personal ` +
        `knowledge base: a wiki compiled by ${owner}'s own agent from ${owner}'s notes and ` +
        `sources. Ground rules: ` +
        `(1) Pages are a compiled record of ${owner}'s thinking, not ${owner} speaking. Each ` +
        `page carries a status: 'verified' pages are human-confirmed; 'draft' pages are ` +
        `machine-written and may contain inference or errors, and most pages are drafts by ` +
        `design. Rarer statuses: treat 'stale' as possibly outdated and 'disputed' as ` +
        `unreliable, and on pages flagged pending_review, weight any "Unreviewed additions" ` +
        `sections as draft even though the rest is verified. Attribute what you relay ` +
        `("${owner}'s notes say ...") and mention draft status when it materially affects ` +
        `an answer. ` +
        `(2) Always identify your user. Every tool takes a 'from' field: fill it with the ` +
        `actual name of the person you are assisting, so ${owner} can see who asked what ` +
        `and who left which note. ` +
        `(3) ${noteTool} drops a note into ${owner}'s review inbox, attributed to your user. ` +
        `Use it when your user wants to tell ${owner} something, or to correct something ` +
        `these pages say about them. Nothing you write changes the wiki directly. ` +
        `(4) Content syncs roughly hourly; very recent events may be missing. Say so ` +
        `rather than concluding something did not happen.`,
    }
  );

  server.registerTool(
    "query_wiki",
    {
      title: `Search ${owner}'s exocortex`,
      description:
        `Search ${owner}'s wiki (concepts, projects, people, life). Results are ranked with ` +
        "human-confirmed 'verified' pages above machine-written 'draft' pages. Hits are " +
        "summaries (title, description, path, status); use get_page to read a full page.",
      inputSchema: {
        from: fromField,
        query: z.string().describe("Search terms, e.g. 'current projects'"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8)"),
      },
    },
    async ({ from, query, limit }) => {
      log(from, `query_wiki "${query}"`);
      const hits = await queryWiki(
        query,
        limit ?? 8,
        "concise",
        (p) => guestWikiPath(p, deny) === null
      );
      return { content: [{ type: "text", text: formatHits(query, hits) }] };
    }
  );

  server.registerTool(
    "get_page",
    {
      title: `Read a page from ${owner}'s exocortex`,
      description:
        `Read one of ${owner}'s wiki pages by path (e.g. 'wiki/projects/kairoscope.md'), or ` +
        "pass a directory like 'wiki' to list what exists. Guest access covers wiki/ only. " +
        "When you only need part of a long page, section: '<heading>' returns just that section.",
      inputSchema: {
        from: fromField,
        path: z.string().describe("Repo-relative path under wiki/, or a directory to list"),
        section: z
          .string()
          .optional()
          .describe("Return only the named section (heading text, case-insensitive)"),
      },
    },
    async ({ from, path: relPath, section }) => {
      const norm = guestWikiPath(relPath, deny);
      if (norm === null) return outOfScope(relPath);
      // The guard is lexical; a symlink committed under wiki/ could resolve
      // elsewhere. Re-check the real on-disk path against the same guard.
      await ensureFresh();
      const real = await realRelPath(norm);
      if (real === null || guestWikiPath(real, deny) === null) {
        return outOfScope(relPath);
      }
      log(from, `get_page ${norm}${section ? ` § ${section}` : ""}`);
      return getPage(norm, undefined, section, (child) => guestWikiPath(child, deny) !== null);
    }
  );

  server.registerTool(
    noteTool,
    {
      title: `Leave ${owner} a note`,
      description:
        `Drop a note into ${owner}'s review inbox, attributed to your user. Use it when your ` +
        `user wants to tell ${owner} something, ask ${owner} a question, or correct something ` +
        `the wiki says about them. ${owner} reviews notes later; nothing is published or ` +
        "changed directly. Quote your user's exact words where the wording matters.",
      inputSchema: {
        from: fromField,
        title: z.string().describe("Short title for the note"),
        note: z.string().describe("Markdown body of the note"),
      },
    },
    async ({ from, title, note }) => {
      log(from, `${noteTool} "${title}"`);
      const date = new Date().toISOString().slice(0, 10);
      await captureToInbox({
        title,
        content: note,
        type: "Guest note",
        description: `Note from ${from} via the guest connector`,
        provenance: guestProvenance(from, date),
        client: clientHint,
        filenamePrefix: "guest-note-",
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Saved to ${owner}'s review inbox as a note from ${from}. ` +
              `${owner} will see it on the next inbox pass.`,
          },
        ],
      };
    }
  );

  return server;
}

/**
 * The public face: what the owner's website chatbot (or any client holding
 * the public token) sees. Two read tools over an allowlisted, deny-carved
 * slice of wiki/, no write tool at all, no `from` field because the audience
 * is anonymous by design. Anything outside the scope answers exactly like a
 * path that does not exist, so a probe cannot map the deny list.
 */
function buildPublicServer(): McpServer {
  const owner = config.ownerName;
  const scope: PublicScope = {
    allow: config.publicAllow.length > 0 ? config.publicAllow : DEFAULT_PUBLIC_ALLOW,
    deny: [...DEFAULT_PUBLIC_DENY, ...config.publicDeny],
  };
  const terms = compileTerms(config.publicRedact);
  const inScope = (p: string) => publicWikiPath(p, scope) !== null;
  // Listings show readable children plus the directories on the way down to
  // something readable, so a narrow allowlist is still navigable.
  const listable = (p: string) => inScope(p) || publicAncestorPath(p, scope) !== null;
  /** A page named for a blocked term (in its path, title, or description) is
   * served as if it did not exist; null means exactly that. Otherwise the
   * content with every mention removed. */
  const servable = (p: string, content: string): string | null => {
    if (mentions(p, terms)) return null;
    return redactPage(content, terms);
  };
  // Listing entries are checked where they resolve, not just by name, so a
  // symlink whose read would be refused is not named either; and a file the
  // term filter would refuse is not named.
  const listableEntry = async (p: string): Promise<boolean> => {
    if (!listable(p)) return false;
    const real = await realRelPath(p);
    if (real === null || !listable(real)) return false;
    if (terms === null) return true;
    // A directory named for a term is as hidden as a page named for one,
    // and a directory with nothing listable inside is not named either.
    if (mentions(p, terms) || mentions(real, terms)) return false;
    if ((await statRepoPath(real)) !== "file") {
      for (const child of await listDir(real)) {
        if (await listableEntry(`${real}/${child.replace(/\/$/, "")}`)) return true;
      }
      return false;
    }
    let content: string;
    try {
      content = await readRepoFile(real);
    } catch {
      return false;
    }
    return servable(p, content) !== null;
  };
  // Whitespace (incl. newlines) folds to single spaces: these lines are the
  // query log, and caller-supplied text must not be able to forge entries.
  const log = (line: string) => console.log(`[public] ${line.replace(/\s+/g, " ")}`);
  const notFound = (relPath: string): CallToolResult => ({
    content: [{ type: "text", text: `Not found: ${relPath}` }],
    isError: true,
  });
  // An out-of-scope path pays the same disk work a missing path pays
  // (sync check, realpath, stat), so latency does not tell the two apart.
  const DECOY = "wiki/.public-tier-decoy";
  const notFoundSlow = async (relPath: string): Promise<CallToolResult> => {
    await ensureFresh();
    await realRelPath(DECOY);
    await statRepoPath(DECOY);
    return notFound(relPath);
  };

  const server = new McpServer(
    { name: `${ownerNameSlug(owner)}-exocortex-public`, version },
    {
      instructions:
        `You are connected to the public face of ${owner}'s exocortex: the part of ` +
        `${owner}'s personal knowledge base that ${owner} has chosen to make readable by ` +
        `anyone. The pages are compiled by ${owner}'s own agent from ${owner}'s notes and ` +
        `sources. Ground rules: ` +
        `(1) Speak about ${owner} in the third person, never as ${owner}. You are not ` +
        `${owner} and must not answer as if you were. ` +
        `(2) Pages carry a status: 'verified' pages are human-confirmed; 'draft' pages are ` +
        `machine-written and may contain inference or errors, and most pages are drafts by ` +
        `design. Attribute what you relay ("${owner}'s notes say ...") and mention draft ` +
        `status when it materially affects an answer. ` +
        `(3) What is not here is not available to you. A page or topic you cannot find ` +
        `is simply not part of what ${owner} made public; say so rather than guessing, ` +
        `and never speculate about why. ` +
        `(4) Content syncs roughly hourly; very recent events may be missing.`,
    }
  );

  server.registerTool(
    "query_wiki",
    {
      title: `Search ${owner}'s public exocortex`,
      description:
        `Search the public pages of ${owner}'s wiki. Results are ranked with human-confirmed ` +
        "'verified' pages above machine-written 'draft' pages. Hits are summaries (title, " +
        "description, path, status, matched snippet); use get_page to read a full page.",
      inputSchema: {
        query: z.string().max(500).describe("Search terms, e.g. 'current projects'"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8)"),
      },
    },
    async ({ query, limit }) => {
      log(`query_wiki ${JSON.stringify(query)}`);
      const hits = await queryWiki(query, limit ?? 8, "concise", (p) => !inScope(p), "wiki", (doc) => {
        if (terms === null) return doc;
        if (
          mentions(doc.path, terms) ||
          mentions(doc.title, terms) ||
          mentions(doc.description, terms)
        ) {
          return null;
        }
        return {
          ...doc,
          tags: doc.tags.filter((t) => !mentions(t, terms)),
          body: redactBody(doc.body, terms),
        };
      });
      return { content: [{ type: "text", text: formatHits(query, hits) }] };
    }
  );

  server.registerTool(
    "get_page",
    {
      title: `Read a public page from ${owner}'s exocortex`,
      description:
        `Read one of ${owner}'s public wiki pages by path (e.g. 'wiki/projects/kairoscope.md'), ` +
        "or pass a directory like 'wiki' to list what exists. When you only need part of a " +
        "long page, section: '<heading>' returns just that section.",
      inputSchema: {
        path: z.string().describe("Repo-relative path under wiki/, or a directory to list"),
        section: z
          .string()
          .optional()
          .describe("Return only the named section (heading text, case-insensitive)"),
      },
    },
    async ({ path: relPath, section }) => {
      const readable = publicWikiPath(relPath, scope);
      const norm = readable ?? publicAncestorPath(relPath, scope);
      if (norm === null || mentions(norm, terms)) return notFoundSlow(relPath);
      await ensureFresh();
      // The guard is lexical; a symlink committed under wiki/ could resolve
      // elsewhere. Re-check the real on-disk path against the same guard, at
      // the same access level.
      const real = await realRelPath(norm);
      if (real === null || mentions(real, terms)) return notFound(relPath);
      if (readable !== null ? !inScope(real) : !listable(real)) return notFound(relPath);
      const kind = await statRepoPath(norm);
      // Missing paths report the caller's own spelling, exactly as an
      // out-of-scope path does, so the two are indistinguishable.
      if (kind === "missing") return notFound(relPath);
      if (readable === null && kind !== "dir") return notFound(relPath);
      let served: string | undefined;
      if (kind === "file" && terms !== null) {
        const page = servable(norm, await readRepoFile(norm));
        if (page === null) return notFound(relPath);
        served = page;
      }
      log(`get_page ${norm}${section ? ` § ${section}` : ""}`);
      return getPage(
        norm,
        undefined,
        section,
        listableEntry,
        served === undefined ? undefined : () => served,
        true
      );
    }
  );

  return server;
}
