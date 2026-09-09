import crypto from "node:crypto";

/**
 * Token matching, kept free of config imports so the tier decision is a pure
 * function tests can exercise: which secret a presented token equals decides
 * which face of the server a connection sees.
 */

export type Role = "owner" | "guest" | "public";

export interface Secrets {
  token: string;
  guestToken?: string;
  publicToken?: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Match a presented token against the owner, guest, then public secret. */
export function matchToken(presented: string, secrets: Secrets): Role | null {
  if (timingSafeEqual(presented, secrets.token)) return "owner";
  if (secrets.guestToken && timingSafeEqual(presented, secrets.guestToken)) {
    return "guest";
  }
  if (secrets.publicToken && timingSafeEqual(presented, secrets.publicToken)) {
    return "public";
  }
  return null;
}
