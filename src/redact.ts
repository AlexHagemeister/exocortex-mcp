/**
 * Scrub credentials from strings that may reach logs or HTTP responses.
 *
 * Two shapes cover the known leak paths (see issue #6): userinfo embedded in
 * a URL (`https://x-access-token:<PAT>@github.com/...`, the documented
 * MIRROR_REPO_URL format) and bare GitHub token literals (a mis-pasted value
 * that is only the token). Length floors keep prose like "ghs_" from
 * triggering while matching all real token formats.
 */
const SECRET_PATTERNS: RegExp[] = [
  // userinfo between "//" and "@" in any URL
  /(?<=\/\/)[^/@\s]+(?=@)/g,
  // fine-grained and classic GitHub tokens
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((s, re) => s.replace(re, "[REDACTED]"), text);
}

/**
 * Scrub an error in place — message plus the stdout/stderr that execFile
 * attaches — so callers can rethrow without any site downstream having to
 * remember to redact.
 */
export function redactError(err: unknown): unknown {
  if (err instanceof Error) {
    err.message = redact(err.message);
    const e = err as Error & { stdout?: unknown; stderr?: unknown };
    if (typeof e.stdout === "string") e.stdout = redact(e.stdout);
    if (typeof e.stderr === "string") e.stderr = redact(e.stderr);
    return err;
  }
  return typeof err === "string" ? redact(err) : err;
}
