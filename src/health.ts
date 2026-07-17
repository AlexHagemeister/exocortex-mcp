import { INBOX_BRANCH, MIRROR_DIR } from "./config.js";
import { ensureFresh, git } from "./mirror.js";

export interface DeepHealth {
  ok: boolean;
  degraded: string[];
  syncOk: boolean;
  pendingCaptures: number;
  oldestPendingHours: number | null;
  checkedAt: string;
}

// One missed nightly consumer run plus slack. Two misses in a row trips it.
const PENDING_STALE_HOURS = 36;

/**
 * Deep health: exercises the mirror sync and inspects the inbox-drops backlog,
 * so a single external probe catches all three failure modes — process down
 * (no response at all), sync broken (bad PAT, GitHub unreachable), and the
 * local consumer not draining captures.
 */
export async function deepHealth(): Promise<DeepHealth> {
  const degraded: string[] = [];

  let syncOk = true;
  try {
    await ensureFresh();
  } catch (err) {
    syncOk = false;
    degraded.push(`mirror sync failed: ${(err as Error).message}`);
  }

  let pendingCaptures = 0;
  let oldestPendingHours: number | null = null;
  if (syncOk) {
    try {
      await git(["fetch", "origin", INBOX_BRANCH], MIRROR_DIR);
      const count = await git(
        ["rev-list", "--count", `origin/HEAD..origin/${INBOX_BRANCH}`],
        MIRROR_DIR
      );
      pendingCaptures = Number(count);
      if (pendingCaptures > 0) {
        const oldest = await git(
          ["log", "--reverse", "--format=%ct", `origin/HEAD..origin/${INBOX_BRANCH}`],
          MIRROR_DIR
        );
        const oldestEpoch = Number(oldest.split("\n")[0]);
        oldestPendingHours =
          Math.round(((Date.now() / 1000 - oldestEpoch) / 3600) * 10) / 10;
        if (oldestPendingHours > PENDING_STALE_HOURS) {
          degraded.push(
            `${pendingCaptures} capture(s) stuck on ${INBOX_BRANCH} for ${oldestPendingHours}h — is the snapshot consumer running?`
          );
        }
      }
    } catch {
      // Branch absent on origin means no pending captures — not a failure.
    }
  }

  return {
    ok: degraded.length === 0,
    degraded,
    syncOk,
    pendingCaptures,
    oldestPendingHours,
    checkedAt: new Date().toISOString(),
  };
}
