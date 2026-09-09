import path from "node:path";
import { publicTokenProblem } from "./public.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Guest tier (optional): a second secret URL for trusted people. Off unless
// EXOCORTEX_GUEST_TOKEN is set; the owner's name is required with it because
// the guest-facing manifest is written in the third person.
const guestToken = process.env.EXOCORTEX_GUEST_TOKEN?.trim() || undefined;
const ownerName = process.env.EXOCORTEX_OWNER_NAME;
if (guestToken) {
  if (guestToken === process.env.EXOCORTEX_TOKEN) {
    // A copy-paste slip here would silently make every guest URL an owner URL.
    throw new Error("EXOCORTEX_GUEST_TOKEN must differ from EXOCORTEX_TOKEN");
  }
  if (guestToken.length < 16) {
    throw new Error(
      "EXOCORTEX_GUEST_TOKEN is too short to be a secret — use `openssl rand -hex 32`"
    );
  }
  if (!ownerName) {
    throw new Error(
      "EXOCORTEX_OWNER_NAME is required when EXOCORTEX_GUEST_TOKEN is set"
    );
  }
}

// Public tier (optional): a third token for an anonymous audience, meant to
// be embedded server-side on the owner's website. Same third-person rule as
// the guest tier, plus it must differ from both other secrets.
const publicToken = process.env.EXOCORTEX_PUBLIC_TOKEN?.trim() || undefined;
if (publicToken) {
  const problem = publicTokenProblem(
    publicToken,
    process.env.EXOCORTEX_TOKEN ?? "",
    guestToken,
    ownerName
  );
  if (problem) throw new Error(problem);
}

// Normalize path-list entries so "./wiki/people/", "/wiki/people" and
// "wiki/people" all mean the same thing; a malformed entry that would
// silently match nothing is a rule the operator believes in but doesn't
// have, so warn loudly.
function pathList(name: string, why: string): string[] {
  const entries = (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^\.\//, "").replace(/^\/+/, ""))
    .filter(Boolean);
  for (const entry of entries) {
    if (!entry.toLowerCase().startsWith("wiki/")) {
      console.warn(`${name} entry '${entry}' is outside wiki/ and has no effect — ${why}`);
    }
  }
  return entries;
}

const guestDeny = pathList("EXOCORTEX_GUEST_DENY", "guests can only reach wiki/");
const publicAllow = pathList("EXOCORTEX_PUBLIC_ALLOW", "the public can only reach wiki/");
const publicDeny = pathList("EXOCORTEX_PUBLIC_DENY", "the public can only reach wiki/");

export const config = {
  mirrorRepoUrl: required("MIRROR_REPO_URL"),
  token: required("EXOCORTEX_TOKEN"),
  guestToken,
  publicToken,
  ownerName: ownerName ?? "",
  /** Extra guest-denied path prefixes (normalized), e.g. "wiki/people/". */
  guestDeny,
  /** Public allow entries (normalized); empty means the default "wiki/". */
  publicAllow,
  /** Extra public-denied entries (normalized), on top of the defaults. */
  publicDeny,
  port: Number(process.env.PORT ?? 3000),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_SECONDS ?? 300) * 1000,
};

export const MIRROR_DIR = path.join(config.dataDir, "mirror");
export const INBOX_BRANCH = "inbox-drops";
