import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import matter from "gray-matter";
import { z } from "zod";
import { captureToInbox } from "./capture.js";
import { ensureFresh, listDir, readRepoFile, statRepoPath } from "./mirror.js";
import { queryWiki } from "./search.js";

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
 * same or higher level. Returns null when no heading matches.
 */
function extractSection(body: string, section: string): string | null {
  const lines = body.split("\n");
  const headings = listHeadings(lines);
  const wanted = section.trim().toLowerCase();
  const idx = headings.findIndex((h) => h.text.toLowerCase() === wanted);
  if (idx === -1) return null;
  const start = headings[idx].line;
  const next = headings
    .slice(idx + 1)
    .find((h) => h.level <= headings[idx].level);
  const end = next ? next.line : lines.length;
  return lines.slice(start, end).join("\n").trim();
}

/**
 * Three tools only, mirroring the vault's own contract: two reads over the
 * wiki, and capture_to_inbox as the sole write — knowledge enters the wiki
 * only through sources/inbox/ (the single-pipeline rule).
 */
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export function buildServer(clientHint?: string): McpServer {
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
        "as inference, and when part of a capture is uncertain, say which part.",
    }
  );

  server.registerTool(
    "query_wiki",
    {
      title: "Query the exocortex wiki",
      description:
        "Status-weighted search over the vault's wiki (concepts, projects, people, life, connections). " +
        "Results are ranked with `verified` pages weighted above `draft` — trust is graduated, " +
        "and a mostly-draft wiki is healthy. Hits are summaries (title, description, path, status) — " +
        "descriptions are written as retrieval hooks, so they are usually enough to pick the right " +
        "page. Use get_page to read a hit, or detail: 'full' only when you truly need every " +
        "matching page's body inline.",
      inputSchema: {
        query: z.string().describe("Search terms, e.g. 'kairoscope design spec'"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8)"),
        detail: z
          .enum(["concise", "full"])
          .optional()
          .describe("'concise' (default) returns summaries; 'full' includes each page's body"),
      },
    },
    async ({ query, limit, detail }) => {
      const hits = await queryWiki(query, limit ?? 8, detail ?? "concise");
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `No wiki pages matched "${query}".` }] };
      }
      const text = hits
        .map(
          (h) =>
            `## ${h.title}\n` +
            `path: ${h.path} · status: ${h.status} · score: ${h.score}\n` +
            (h.description ? `${h.description}` : `> ${h.snippet}`) +
            (h.body ? `\n\n${h.body}` : "")
        )
        .join("\n\n");
      return { content: [{ type: "text", text }] };
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
        "section: '<heading>' returns just that section. Content is read from the git mirror, " +
        "so freshness is bounded by the nightly snapshot.",
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
    async ({ path: relPath, mode, section }) => {
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
        const entries = await listDir(relPath);
        return {
          content: [
            { type: "text", text: `Directory ${relPath}:\n${entries.join("\n")}` },
          ],
        };
      }
      const content = await readRepoFile(relPath);
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
