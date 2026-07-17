import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { config, MIRROR_DIR } from "./config.js";

const run = promisify(execFile);

export async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

let lastSync = 0;
let syncing: Promise<void> | null = null;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function doSync(): Promise<void> {
  if (await exists(path.join(MIRROR_DIR, ".git"))) {
    await git(["pull", "--ff-only"], MIRROR_DIR);
  } else {
    await fs.mkdir(config.dataDir, { recursive: true });
    await git(["clone", config.mirrorRepoUrl, MIRROR_DIR]);
  }
  lastSync = Date.now();
}

/**
 * Ensure the local clone exists and is no staler than the sync interval.
 * Concurrent callers share one in-flight sync. Staleness beyond the interval
 * is acceptable by design — the mirror itself is only as fresh as the last
 * nightly snapshot.
 */
export async function ensureFresh(): Promise<void> {
  if (Date.now() - lastSync < config.syncIntervalMs) return;
  if (!syncing) {
    syncing = doSync().finally(() => {
      syncing = null;
    });
  }
  await syncing;
}

/** Recursively list markdown files under a repo-relative directory. */
export async function listMarkdown(relDir: string): Promise<string[]> {
  const root = path.join(MIRROR_DIR, relDir);
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".md")) out.push(path.relative(MIRROR_DIR, full));
    }
  }
  await walk(root);
  return out;
}

/**
 * Resolve a repo-relative path safely (no escaping the mirror checkout).
 * Returns the absolute path or throws.
 */
export function resolveRepoPath(relPath: string): string {
  const abs = path.resolve(MIRROR_DIR, relPath);
  if (abs !== MIRROR_DIR && !abs.startsWith(MIRROR_DIR + path.sep)) {
    throw new Error(`Path escapes the vault: ${relPath}`);
  }
  return abs;
}

export async function readRepoFile(relPath: string): Promise<string> {
  return fs.readFile(resolveRepoPath(relPath), "utf8");
}

export async function statRepoPath(
  relPath: string
): Promise<"file" | "dir" | "missing"> {
  try {
    const s = await fs.stat(resolveRepoPath(relPath));
    return s.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

export async function listDir(relPath: string): Promise<string[]> {
  const entries = await fs.readdir(resolveRepoPath(relPath), {
    withFileTypes: true,
  });
  return entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
    .sort();
}
