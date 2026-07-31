import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { INBOX_BRANCH, MIRROR_DIR } from "./config.js";
import { ensureFresh, git } from "./mirror.js";

export interface CaptureInput {
  title: string;
  content: string;
  description?: string;
  type?: string;
  provenance?: string;
  /** Server-derived client identity (auth route + user agent) — never agent-supplied. */
  client?: string;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "capture"
  );
}

function yamlEscape(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Captures are committed to the dedicated inbox-drops branch, never to main.
// The mirror's main is owned by the nightly snapshot (rsync --delete would
// clobber server-side additions); a local consumer script copies drops into
// the vault's sources/inbox/ and resets the branch. See README.
let captureQueue: Promise<unknown> = Promise.resolve();

export function captureToInbox(input: CaptureInput): Promise<string> {
  const result = captureQueue.then(() => doCapture(input));
  captureQueue = result.catch(() => {});
  return result;
}

async function doCapture(input: CaptureInput): Promise<string> {
  await ensureFresh();

  // Base the branch on its remote tip if it exists, otherwise on origin's HEAD,
  // so `git diff origin/main...inbox-drops` is exactly the pending captures.
  let base: string;
  try {
    await git(["fetch", "origin", INBOX_BRANCH], MIRROR_DIR);
    base = `origin/${INBOX_BRANCH}`;
  } catch {
    base = "origin/HEAD";
  }

  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "exo-capture-"));
  try {
    await git(["worktree", "add", "--detach", worktree, base], MIRROR_DIR);

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const slug = slugify(input.title);
    const inboxDir = path.join(worktree, "sources", "inbox");
    await fs.mkdir(inboxDir, { recursive: true });

    let filename = `${date}-${slug}.md`;
    try {
      await fs.access(path.join(inboxDir, filename));
      const hms = now.toISOString().slice(11, 19).replace(/:/g, "");
      filename = `${date}-${hms}-${slug}.md`;
    } catch {
      // no collision
    }

    const frontmatter = [
      "---",
      `type: ${input.type ?? "Capture"}`,
      `title: ${yamlEscape(input.title)}`,
      `description: ${yamlEscape(input.description ?? "")}`,
      `timestamp: ${now.toISOString()}`,
      `provenance: ${yamlEscape(
        input.provenance ?? `remote capture via exocortex-mcp, ${date}`
      )}`,
      // Mechanical surface identity, stamped server-side so it never depends
      // on the calling agent's diligence. Ingest reads it as "which surface
      // wrote this file", complementing provenance's "who spoke".
      `captured_via: ${yamlEscape(
        input.client ? `exocortex-mcp (${input.client})` : "exocortex-mcp"
      )}`,
      "---",
      "",
    ].join("\n");

    const relPath = path.posix.join("sources", "inbox", filename);
    await fs.writeFile(
      path.join(inboxDir, filename),
      frontmatter + input.content.trim() + "\n"
    );

    await git(["add", relPath], worktree);
    await git(
      [
        "-c",
        "user.name=exocortex-mcp",
        "-c",
        "user.email=exocortex-mcp@localhost",
        "commit",
        "-m",
        `capture: ${input.title}`,
      ],
      worktree
    );
    await git(["push", "origin", `HEAD:refs/heads/${INBOX_BRANCH}`], worktree);

    return relPath;
  } finally {
    await git(["worktree", "remove", "--force", worktree], MIRROR_DIR).catch(
      () => {}
    );
  }
}
