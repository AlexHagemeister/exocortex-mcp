import matter from "gray-matter";
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

/**
 * Term redaction: the second layer under the path scope. A denied topic can
 * still be mentioned in passing on an allowed page, and the model can only
 * say what it reads, so the mention is removed before it is served rather
 * than caught in the model's output afterwards.
 */

/** A compiled blocked-term matcher, or null when no terms are configured. */
export type TermMatcher = RegExp | null;

/**
 * Compile operator-supplied terms into one case-insensitive matcher that
 * fires on whole words only: "trep" must not match inside "entrepreneur".
 * Internal whitespace in a term matches any run of whitespace.
 */
export function compileTerms(terms: string[]): TermMatcher {
  const parts = terms
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) =>
      t
        .split(/\s+/)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+")
    );
  if (parts.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

export function mentions(text: string, matcher: TermMatcher): boolean {
  return matcher !== null && matcher.test(text);
}

const FENCE = /^(```|~~~)/;
const ATX = /^(#{1,6})\s/;
const SETEXT_UNDERLINE = /^\s*(=+|-+)\s*$/;
/** Lines that stand alone inside a block: list items, table rows, quotes. */
const LINE_ITEM = /^\s*(?:[-*+]\s|\d+[.)]\s|\||>)/;

/** A heading starting at line i: its level and how many lines it spans. */
function headingAt(lines: string[], i: number): { level: number; span: number } | null {
  const h = ATX.exec(lines[i]);
  if (h) return { level: h[1].length, span: 1 };
  const next = lines[i + 1];
  if (
    next !== undefined &&
    lines[i].trim() !== "" &&
    !LINE_ITEM.test(lines[i]) &&
    !FENCE.test(lines[i]) &&
    SETEXT_UNDERLINE.test(next)
  ) {
    return { level: next.trim().startsWith("=") ? 1 : 2, span: 2 };
  }
  return null;
}

/**
 * Remove every block of a markdown body that mentions a blocked term, and
 * nothing else. Blocks are matched as a whole (lines joined), so a
 * multi-word term wrapped across a soft line break is still caught. A
 * titled section (ATX or setext heading through the next heading of the
 * same or higher level, fences respected) goes when its heading mentions a
 * term; a fenced code block goes whole; a list, table, or quote loses only
 * the offending lines (and goes whole if the term spans lines); any other
 * paragraph goes whole. Nothing marks the removal.
 */
export function redactBody(body: string, matcher: TermMatcher): string {
  if (matcher === null || !matcher.test(body)) return body;
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const hd = headingAt(lines, i);
    if (hd) {
      const headingLines = lines.slice(i, i + hd.span);
      if (!matcher.test(headingLines.join(" "))) {
        out.push(...headingLines);
        i += hd.span;
        continue;
      }
      // Drop the section: through the next heading at this level or above,
      // ignoring anything that looks like a heading inside a fence.
      i += hd.span;
      let inFence = false;
      while (i < lines.length) {
        if (FENCE.test(lines[i])) {
          inFence = !inFence;
          i++;
          continue;
        }
        if (!inFence) {
          const nh = headingAt(lines, i);
          if (nh && nh.level <= hd.level) break;
        }
        i++;
      }
      continue;
    }
    // A fenced block: whole or nothing.
    if (FENCE.test(line)) {
      const fence = [line];
      i++;
      while (i < lines.length) {
        fence.push(lines[i]);
        i++;
        if (FENCE.test(fence[fence.length - 1])) break;
      }
      if (!matcher.test(fence.join(" "))) out.push(...fence);
      continue;
    }
    // Blank lines pass through; blocks are the runs between them.
    if (line.trim() === "") {
      out.push(line);
      i++;
      continue;
    }
    const block: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE.test(lines[i]) &&
      (block.length === 0 || headingAt(lines, i) === null)
    ) {
      block.push(lines[i]);
      i++;
    }
    if (block.every((l) => LINE_ITEM.test(l))) {
      let kept = block.filter((l) => !matcher.test(l));
      if (matcher.test(kept.join(" "))) kept = [];
      out.push(...kept);
    } else if (!matcher.test(block.join(" "))) {
      out.push(...block);
    }
  }
  // Collapse the blank lines that removals leave behind.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

/**
 * Redact a whole page file: frontmatter lines that mention a term are
 * dropped, the body goes through redactBody. Returns null when the page's
 * title or description mentions a term: a page named for a blocked topic is
 * about it, and is served as if it did not exist.
 */
export function redactPage(content: string, matcher: TermMatcher): string | null {
  if (matcher === null || !matcher.test(content)) return content;
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(content);
  if (!m) return redactBody(content, matcher);
  // Parsed first, so a folded or multi-line title/description counts; the
  // line scan below is the fallback when the YAML does not parse.
  try {
    const data = matter(content).data as Record<string, unknown>;
    for (const key of ["title", "description"]) {
      const v = data[key];
      if (v !== undefined && matcher.test(String(v))) return null;
    }
  } catch {
    // fall through to the line scan
  }
  const fmLines = m[2].split(/\r?\n/);
  for (const l of fmLines) {
    if (/^(title|description)\s*:/i.test(l) && matcher.test(l)) return null;
  }
  const fm = fmLines.filter((l) => !matcher.test(l)).join("\n");
  const body = content.slice(m[0].length);
  return m[1] + fm + m[3] + redactBody(body, matcher);
}
