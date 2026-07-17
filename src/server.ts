import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureToInbox } from "./capture.js";
import { ensureFresh, listDir, readRepoFile, statRepoPath } from "./mirror.js";
import { queryWiki } from "./search.js";

/**
 * Three tools only, mirroring the vault's own contract: two reads over the
 * wiki, and capture_to_inbox as the sole write — knowledge enters the wiki
 * only through sources/inbox/ (the single-pipeline rule).
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "exocortex", version: "0.1.0" });

  server.registerTool(
    "query_wiki",
    {
      title: "Query the exocortex wiki",
      description:
        "Status-weighted search over the vault's wiki (concepts, projects, people, life, connections). " +
        "Results are ranked with `verified` pages weighted above `draft` — trust is graduated, " +
        "and a mostly-draft wiki is healthy. Use get_page to read a full page from a hit.",
      inputSchema: {
        query: z.string().describe("Search terms, e.g. 'kairoscope design spec'"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8)"),
      },
    },
    async ({ query, limit }) => {
      const hits = await queryWiki(query, limit ?? 8);
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `No wiki pages matched "${query}".` }] };
      }
      const text = hits
        .map(
          (h) =>
            `## ${h.title}\n` +
            `path: ${h.path} · status: ${h.status} · score: ${h.score}\n` +
            (h.description ? `${h.description}\n` : "") +
            `> ${h.snippet}`
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
        "'CONSTITUTION.md'). Pass a directory path to list its contents. Content is read from " +
        "the git mirror, so freshness is bounded by the nightly snapshot.",
      inputSchema: {
        path: z.string().describe("Repo-relative path to a file or directory"),
      },
    },
    async ({ path: relPath }) => {
      await ensureFresh();
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
        "new statements with provenance.",
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
          .optional()
          .describe("Where this came from, e.g. 'the user, 2026-07-17, via phone'"),
      },
    },
    async (input) => {
      const relPath = await captureToInbox(input);
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
