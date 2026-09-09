import { guestWikiPath } from "./guest.js";

/**
 * Public-tier helpers, config-free like guest.ts so tests load them bare.
 *
 * The public tier is the third face of the server: a token meant to be
 * embedded server-side on the owner's public website, for an anonymous
 * audience. Reads only, no write tool, and the scope is allowlist-first: a
 * path is readable only when it sits under an allow entry and under no deny
 * entry. Deny always wins, so an operator can allow "wiki/life/" and still
 * carve out "wiki/life/health/".
 */

/** Everything under wiki/ is allowed by default; the deny list does the work. */
export const DEFAULT_PUBLIC_ALLOW = ["wiki/"];

/**
 * Denied by default, on top of the guest denials: the day logs and their
 * derived index, the chronicle (a record of the owner's days), connections
 * (claims about how the owner's notes relate, thick with names), and the
 * people folder (other people's personal information).
 */
export const DEFAULT_PUBLIC_DENY = [
  "wiki/log/",
  "wiki/log.md",
  "wiki/chronicle/",
  "wiki/connections/",
  "wiki/people/",
];

export interface PublicScope {
  /** Path prefixes (or single files) the public may read. */
  allow: string[];
  /** Path prefixes (or single files) the public may never read. */
  deny: string[];
}

/** Strip the decorations an operator might type so entries compare cleanly. */
function normalizeEntry(entry: string): string {
  return entry
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Does a normalized, lower-cased path fall under an allow entry? An entry
 * naming a markdown file matches exactly; anything else is a folder prefix
 * matched on whole path segments.
 */
function underEntry(lower: string, entry: string): boolean {
  const prefix = normalizeEntry(entry);
  if (!prefix) return false;
  if (lower === prefix) return true;
  if (prefix.endsWith(".md")) return false;
  return lower.startsWith(prefix + "/");
}

/**
 * The normalized repo-relative path when the public may read (or, for a
 * directory, list) it: under wiki/, under some allow entry, under no deny
 * entry, and clean of traversal, dot segments, and case tricks. Null
 * otherwise. Search exclusion, page reads, and listing filters all use this
 * one predicate so they can never disagree.
 */
export function publicWikiPath(relPath: string, scope: PublicScope): string | null {
  // guestWikiPath owns normalization, the wiki/-only rule, dot and traversal
  // refusal, and case-folded deny matching; the allowlist is the only thing
  // added here, so every bypass the guest guard was hardened against is
  // covered by the same code.
  const norm = guestWikiPath(relPath, scope.deny);
  if (norm === null) return null;
  const lower = norm.toLowerCase();
  return scope.allow.some((a) => underEntry(lower, a)) ? norm : null;
}

/**
 * The normalized path when it is a strict ancestor directory of some allow
 * entry (and not itself denied): listable so a client can navigate down to
 * what it may read, but its listing must be filtered and it is never read
 * as a file. Null when the path is readable outright, denied, or unrelated.
 * With the default allow of "wiki/" nothing is a strict ancestor, so this
 * only matters for narrow allowlists like "wiki/projects/".
 */
export function publicAncestorPath(relPath: string, scope: PublicScope): string | null {
  const norm = guestWikiPath(relPath, scope.deny);
  if (norm === null) return null;
  const lower = norm.toLowerCase();
  for (const a of scope.allow) {
    const prefix = normalizeEntry(a);
    if (!prefix) continue;
    if (prefix.startsWith(lower + "/")) return norm;
  }
  return null;
}

/**
 * Boot-time validation of the public token against the other secrets.
 * Returns the error to throw, or null when the configuration is sound.
 */
export function publicTokenProblem(
  publicToken: string,
  ownerToken: string,
  guestToken: string | undefined,
  ownerName: string | undefined
): string | null {
  if (publicToken === ownerToken) {
    // A copy-paste slip here would put the owner's full manifest, capture
    // tool included, behind the token embedded on a public website.
    return "EXOCORTEX_PUBLIC_TOKEN must differ from EXOCORTEX_TOKEN";
  }
  if (guestToken !== undefined && publicToken === guestToken) {
    return "EXOCORTEX_PUBLIC_TOKEN must differ from EXOCORTEX_GUEST_TOKEN";
  }
  if (publicToken.length < 16) {
    return "EXOCORTEX_PUBLIC_TOKEN is too short to be a secret — use `openssl rand -hex 32`";
  }
  if (!ownerName) {
    return "EXOCORTEX_OWNER_NAME is required when EXOCORTEX_PUBLIC_TOKEN is set";
  }
  return null;
}
