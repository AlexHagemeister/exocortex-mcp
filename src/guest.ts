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
  if (norm.split("/").some((seg) => seg === "..")) return null;
  if (norm !== "wiki" && !norm.startsWith("wiki/")) return null;
  for (const d of deny) {
    const prefix = d.replace(/\/+$/, "");
    if (norm === prefix || norm.startsWith(prefix + "/")) return null;
  }
  return norm;
}

/**
 * Compose the provenance line for a guest note server-side. The guest agent
 * supplies only the person's name; it never writes a free-form provenance
 * string, so a note masquerading as the owner is structurally impossible.
 */
export function guestProvenance(from: string, isoDate: string): string {
  return `${from}, via their Claude (guest connector), ${isoDate}`;
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
