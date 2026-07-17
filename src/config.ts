import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  mirrorRepoUrl: required("MIRROR_REPO_URL"),
  token: required("EXOCORTEX_TOKEN"),
  port: Number(process.env.PORT ?? 3000),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_SECONDS ?? 300) * 1000,
};

export const MIRROR_DIR = path.join(config.dataDir, "mirror");
export const INBOX_BRANCH = "inbox-drops";
