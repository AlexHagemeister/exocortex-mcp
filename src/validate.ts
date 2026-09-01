/**
 * Write-time checks on capture content, owner tier only. Pure functions with
 * no config imports, so tests load them without the server's environment.
 *
 * Each check is regex-grade: it verifies that a requisite is present, never
 * that it is right. Whether the named speaker actually said the words, or a
 * wikilink points at the sibling the author meant, stays judgment for the
 * ingest pipeline and the user. The guest tier is deliberately exempt: guest
 * and voice surfaces have broken on stricter schemas before, and the server
 * composes guest provenance itself.
 */

export type CaptureTier = "owner" | "guest";

/**
 * A sibling capture cited by its inbox path. Only a path with something after
 * `sources/inbox/` counts: a bare mention of the folder is prose about the
 * vault, not a citation, and captures about the system say it constantly.
 */
const INBOX_PATH = /sources\/inbox\/[^\s)\]`'"<>|]+/g;

/**
 * Speaker signals accepted inside a blockquote group or within two lines of
 * it. Word-bounded and case-insensitive.
 */
const SPEAKER_WORD =
  /\b(?:verbatim|the user|said|says|wrote|writes|described|in (?:his|her|their) words|per the user)\b/i;

/** A dash-led attribution line: em dash, en dash, or hyphen, then text carrying a speaker word or a date. */
const DASH_LED = /^\s*(?:\u2014|\u2013|-)\s*(.+)$/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

function stripQuoteMarker(line: string): string {
  return line.replace(/^\s*>+\s?/, "");
}

function hasSpeakerSignal(line: string): boolean {
  const text = stripQuoteMarker(line);
  if (SPEAKER_WORD.test(text)) return true;
  const dash = DASH_LED.exec(text);
  return dash !== null && ISO_DATE.test(dash[1]);
}

/**
 * Check 1: sibling citations by inbox path. Returns the error text, or null
 * when the content is clean. Fenced code is not exempt: a path inside a
 * fence is still a path that dies at filing.
 */
export function checkSiblingCitations(content: string): string | null {
  const hits = content.match(INBOX_PATH);
  if (!hits) return null;
  const first = hits[0];
  const basename = first
    .slice("sources/inbox/".length)
    .replace(/\.md$/, "")
    .replace(/\/.*$/, "");
  const example = basename || "2026-09-01-example-capture";
  return (
    `sibling citation by inbox path is not allowed: '${first}' names a capture by a path ` +
    `that dies when either file is filed. Name the sibling by its basename wikilink instead, ` +
    `e.g. [[${example}]].`
  );
}

interface QuoteGroup {
  start: number; // 0-based line index
  end: number; // inclusive
}

/** Consecutive `>` lines form one group. Lines inside fenced code are ignored. */
function findBlockquoteGroups(lines: string[]): QuoteGroup[] {
  const groups: QuoteGroup[] = [];
  let inFence = false;
  let open: QuoteGroup | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      if (open) groups.push(open);
      open = null;
      continue;
    }
    if (inFence) continue;
    if (/^\s*>/.test(lines[i])) {
      if (open) open.end = i;
      else open = { start: i, end: i };
    } else if (open) {
      groups.push(open);
      open = null;
    }
  }
  if (open) groups.push(open);
  return groups;
}

/**
 * Check 2: unattributed blockquotes. Every blockquote group needs a speaker
 * signal inside it or within the two lines before or after it. Returns the
 * error text for the first offending group, or null.
 */
export function checkQuoteAttribution(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (const g of findBlockquoteGroups(lines)) {
    const lo = Math.max(0, g.start - 2);
    const hi = Math.min(lines.length - 1, g.end + 2);
    let attributed = false;
    for (let i = lo; i <= hi && !attributed; i++) {
      if (hasSpeakerSignal(lines[i])) attributed = true;
    }
    if (attributed) continue;
    const preview = stripQuoteMarker(lines[g.start]).trim().slice(0, 60);
    return (
      `quote attribution is required: the blockquote at line ${g.start + 1} ` +
      `("${preview}") has no speaker within it or the two lines around it. Mark the quote ` +
      `with its speaker, e.g. 'the user, verbatim:' on the line before it, or a dash-led ` +
      `speaker-and-date line after it ('- the user, 2026-09-01').`
    );
  }
  return null;
}

/**
 * Run every write-time check for the given tier. Owner captures get both
 * checks; guest captures pass through untouched. Returns the list of
 * violations, empty when the capture may be written.
 */
export function validateCapture(content: string, tier: CaptureTier): string[] {
  if (tier === "guest") return [];
  const errors: string[] = [];
  const sibling = checkSiblingCitations(content);
  if (sibling) errors.push(sibling);
  const quote = checkQuoteAttribution(content);
  if (quote) errors.push(quote);
  return errors;
}
