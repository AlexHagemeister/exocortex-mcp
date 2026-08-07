import matter from "gray-matter";
import { ensureFresh, listMarkdown, readRepoFile } from "./mirror.js";

export type SearchDetail = "concise" | "full";

export interface WikiHit {
  path: string;
  title: string;
  description: string;
  status: string;
  score: number;
  /** Present only when the page has no description to stand in for it. */
  snippet?: string;
  /** Present only for detail: "full". */
  body?: string;
}

interface WikiDoc {
  path: string;
  title: string;
  description: string;
  tags: string[];
  status: string;
  body: string;
  bodyLower: string;
}

// Trust is graduated in the vault: agents write freely as draft, promotion to
// verified is a human act, and readers weight by status. Missing status means
// the page predates the status model or is index scaffolding.
const STATUS_WEIGHT: Record<string, number> = {
  verified: 1.5,
  draft: 1.0,
};
const DEFAULT_STATUS_WEIGHT = 0.9;

let index: WikiDoc[] | null = null;
let indexedAt = 0;

async function buildIndex(): Promise<WikiDoc[]> {
  const files = await listMarkdown("wiki");
  const docs: WikiDoc[] = [];
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
      title: String(data.title ?? file.replace(/^wiki\//, "").replace(/\.md$/, "")),
      description: String(data.description ?? ""),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      status: String(data.status ?? ""),
      body: parsed.content,
      bodyLower: parsed.content.toLowerCase(),
    });
  }
  return docs;
}

async function getIndex(): Promise<WikiDoc[]> {
  await ensureFresh();
  // Rebuild whenever the index is older than a minute past the last use of it;
  // cheap enough for a vault of this size (~100 pages).
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
  excludePrefixes: string[] = []
): Promise<WikiHit[]> {
  const docs = await getIndex();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  const hits: WikiHit[] = [];
  for (const doc of docs) {
    if (excludePrefixes.some((p) => doc.path.startsWith(p))) continue;
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
    };
    if (!doc.description) hit.snippet = makeSnippet(doc, terms);
    if (detail === "full") hit.body = doc.body;
    hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
