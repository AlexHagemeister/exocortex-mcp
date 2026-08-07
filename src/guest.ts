import path from "node:path";

/**
 * Guest-tier helpers, kept free of config imports so tests can load this
 * module without the server's required environment variables.
 *
 * The guest tier exists so the vault's owner can hand trusted people a
 * second secret URL. Same server, different face: the token decides which
 * manifest a connection sees. Guests read the compiled wiki only — never
 * sources/, notes/, or the day logs, which are a record of the owner's
 * days rather than knowledge pages.
 */

/**
 * Paths guests can never read, on top of the wiki/-only scope: the day logs
 * and their derived index (wiki/log.md).
 */
export const DEFAULT_GUEST_DENY = ["wiki/log/", "wiki/log.md"];

/**
 * Normalize a guest-supplied path and check it against the guest scope:
 * under wiki/ and not under a denied prefix. Returns the normalized
 * repo-relative path, or null when out of scope.
 */
export function guestWikiPath(
  relPath: string,
  deny: string[] = DEFAULT_GUEST_DENY
): string | null {
  const norm = path.posix
    .normalize(relPath.trim().replace(/\\/g, "/"))
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (norm === "" || norm === ".") return null;
  // Reject traversal and dot-prefixed segments (.DS_Store, .obsidian, …) —
  // listings already hide dotfiles, so direct reads must refuse them too.
  if (norm.split("/").some((seg) => seg === ".." || seg.startsWith("."))) {
    return null;
  }
  // All checks are case-folded: the mirror may sit on a case-insensitive
  // filesystem (macOS), where 'wiki/LOG/x.md' resolves to the denied file
  // even though a case-sensitive compare would let it through.
  const lower = norm.toLowerCase();
  if (lower !== "wiki" && !lower.startsWith("wiki/")) return null;
  for (const d of deny) {
    const prefix = d.replace(/\/+$/, "").toLowerCase();
    if (!prefix) continue;
    if (lower === prefix || lower.startsWith(prefix + "/")) return null;
  }
  return norm;
}

/**
 * Compose the provenance line for a guest note server-side. The guest agent
 * supplies only the person's name; it never writes a free-form provenance
 * string, so a note masquerading as the owner is structurally impossible.
 */
export function guestProvenance(from: string, isoDate: string): string {
  // The guest marker leads so a name like "the user" or the owner's own name
  // can never make the line *start* like an owner provenance string.
  return `guest connector: ${from} (via their Claude), ${isoDate}`;
}

/** "Alex H." -> "alex-h", for the guest-facing server name. */
export function ownerNameSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "owner"
  );
}

/** "Alex H." -> "alex_h", for the leave_note_for_<owner> tool name. */
export function ownerToolSlug(name: string): string {
  return ownerNameSlug(name).replace(/-/g, "_");
}
