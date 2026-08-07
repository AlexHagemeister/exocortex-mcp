import path from "node:path";

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
const guestToken = process.env.EXOCORTEX_GUEST_TOKEN || undefined;
const ownerName = process.env.EXOCORTEX_OWNER_NAME;
if (guestToken && !ownerName) {
  throw new Error(
    "EXOCORTEX_OWNER_NAME is required when EXOCORTEX_GUEST_TOKEN is set"
  );
}

export const config = {
  mirrorRepoUrl: required("MIRROR_REPO_URL"),
  token: required("EXOCORTEX_TOKEN"),
  guestToken,
  ownerName: ownerName ?? "",
  /** Extra guest-denied path prefixes, comma-separated, e.g. "wiki/people/". */
  guestDeny: (process.env.EXOCORTEX_GUEST_DENY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  port: Number(process.env.PORT ?? 3000),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_SECONDS ?? 300) * 1000,
};

export const MIRROR_DIR = path.join(config.dataDir, "mirror");
export const INBOX_BRANCH = "inbox-drops";
