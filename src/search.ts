import matter from "gray-matter";
import { ensureFresh, listMarkdown, readRepoFile } from "./mirror.js";

export type SearchDetail = "concise" | "full";

/** Which vault layers to search. The wiki is the compiled layer; sources are
 * frozen records of what was said; notes are the user's own words. Guest
 * connections are always scoped to "wiki" regardless of what they ask for. */
export type SearchScope = "wiki" | "sources" | "notes" | "all";

const SCOPE_ROOTS: Record<Exclude<SearchScope, "all">, string> = {
  wiki: "wiki",
  sources: "sources",
  notes: "notes",
};

export interface WikiHit {
  path: string;
  title: string;
  description: string;
  status: string;
  score: number;
  /** Where the query matched in the body — always present so a hit whose
   * description says nothing about the matched term is still judgeable. */
  snippet?: string;
  /** Present only for detail: "full". */
  body?: string;
}

/** The parts of an indexed page a view may inspect or rewrite. */
export interface SearchDoc {
  path: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
}

interface WikiDoc extends SearchDoc {
  root: keyof typeof SCOPE_ROOTS;
  title: string;
  description: string;
  tags: string[];
  status: string;
  body: string;
  bodyLower: string;
}

// Trust is graduated in the vault: agents write freely as draft, promotion to
// verified is a human act, and readers weight by status. Missing status means
// the page predates the status model, is index scaffolding, or is a source or
// note (which carry provenance, not status).
const STATUS_WEIGHT: Record<string, number> = {
  verified: 1.5,
  draft: 1.0,
};
const DEFAULT_STATUS_WEIGHT = 0.9;

let index: WikiDoc[] | null = null;
let indexedAt = 0;

async function buildIndex(): Promise<WikiDoc[]> {
  const docs: WikiDoc[] = [];
  for (const root of Object.keys(SCOPE_ROOTS) as (keyof typeof SCOPE_ROOTS)[]) {
    const files = await listMarkdown(SCOPE_ROOTS[root]);
    for (const file of files) {
      let raw: string;
      try {
        raw = await readRepoFile(file);
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = matter(raw);
      } catch {
        parsed = { data: {}, content: raw };
      }
      const data = parsed.data as Record<string, unknown>;
      docs.push({
        path: file,
        root,
        title: String(
          data.title ?? file.replace(new RegExp(`^${root}/`), "").replace(/\.md$/, "")
        ),
        description: String(data.description ?? ""),
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        status: String(data.status ?? ""),
        body: parsed.content,
        bodyLower: parsed.content.toLowerCase(),
      });
    }
  }
  return docs;
}

async function getIndex(): Promise<WikiDoc[]> {
  await ensureFresh();
  // Rebuild whenever the index is older than a minute past the last use of it;
  // cheap enough for a vault of this size.
  if (!index || Date.now() - indexedAt > 60_000) {
    index = await buildIndex();
    indexedAt = Date.now();
  }
  return index;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

function makeSnippet(doc: WikiDoc, terms: string[]): string {
  for (const term of terms) {
    const i = doc.bodyLower.indexOf(term);
    if (i !== -1) {
      const start = Math.max(0, i - 100);
      const end = Math.min(doc.body.length, i + 160);
      return (
        (start > 0 ? "…" : "") +
        doc.body.slice(start, end).replace(/\s+/g, " ").trim() +
        (end < doc.body.length ? "…" : "")
      );
    }
  }
  return doc.body.slice(0, 200).replace(/\s+/g, " ").trim();
}

export async function queryWiki(
  query: string,
  limit = 8,
  detail: SearchDetail = "concise",
  /** Return true to hide a page from results — evaluated before scoring, so
   * excluded pages never surface as snippets, descriptions, or bodies. The
   * guest tier passes its path guard here so search and reads agree exactly. */
  exclude?: (path: string) => boolean,
  scope: SearchScope = "wiki",
  /** Rewrite a page before it is matched, snippeted, or returned; null hides
   * it. The public tier passes its term redaction here so a blocked term can
   * neither match a query nor appear in a snippet or body. */
  view?: (doc: SearchDoc) => SearchDoc | null
): Promise<WikiHit[]> {
  const docs = await getIndex();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  const hits: WikiHit[] = [];
  for (const indexed of docs) {
    if (scope !== "all" && indexed.root !== scope) continue;
    if (exclude?.(indexed.path)) continue;
    let doc: WikiDoc = indexed;
    if (view) {
      const seen = view(indexed);
      if (seen === null) continue;
      if (seen !== indexed) {
        doc = { ...indexed, ...seen, bodyLower: seen.body.toLowerCase() };
      }
    }
    let score = 0;
    for (const term of terms) {
      if (doc.title.toLowerCase().includes(term)) score += 4;
      if (doc.description.toLowerCase().includes(term)) score += 3;
      if (doc.tags.some((t) => t.toLowerCase().includes(term))) score += 2;
      if (doc.path.toLowerCase().includes(term)) score += 2;
      score += Math.min(countOccurrences(doc.bodyLower, term), 5);
    }
    if (score === 0) continue;
    score *= STATUS_WEIGHT[doc.status] ?? DEFAULT_STATUS_WEIGHT;
    const hit: WikiHit = {
      path: doc.path,
      title: doc.title,
      description: doc.description,
      status: doc.status || "(none)",
      score: Math.round(score * 100) / 100,
      snippet: makeSnippet(doc, terms),
    };
    if (detail === "full") hit.body = doc.body;
    hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
