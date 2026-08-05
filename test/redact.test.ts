import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactError } from "../src/redact.js";

const PAT = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890";
const CLASSIC = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

test("bare fine-grained PAT (the observed /healthz/deep leak shape)", () => {
  const msg = `Command failed: git clone ${PAT} /app/data/mirror\nfatal: repository '${PAT}' does not exist\n`;
  const out = redact(msg);
  assert.ok(!out.includes(PAT));
  assert.ok(out.includes("git clone [REDACTED]"));
  assert.ok(out.includes("fatal: repository"));
});

test("correctly formed MIRROR_REPO_URL with userinfo", () => {
  const msg = `Command failed: git clone https://x-access-token:${PAT}@github.com/you/vault.git /app/data/mirror\nfatal: could not read Password\n`;
  const out = redact(msg);
  assert.ok(!out.includes(PAT));
  assert.ok(!out.includes("x-access-token"));
  assert.ok(out.includes("https://[REDACTED]@github.com/you/vault.git"));
});

test("bare classic ghp_ token", () => {
  const out = redact(`fatal: Authentication failed for '${CLASSIC}'`);
  assert.ok(!out.includes(CLASSIC));
  assert.ok(out.includes("[REDACTED]"));
});

test("credential-free error passes through unchanged", () => {
  const msg =
    "Command failed: git pull --ff-only\nfatal: unable to access 'https://github.com/you/vault.git/': Could not resolve host: github.com\n";
  assert.equal(redact(msg), msg);
});

test("redactError scrubs message, stdout, and stderr in place", () => {
  const err = Object.assign(new Error(`git clone ${PAT} failed`), {
    stdout: `cloning ${PAT}`,
    stderr: `fatal: '${PAT}' not found`,
  });
  const out = redactError(err) as Error & { stdout: string; stderr: string };
  assert.ok(!out.message.includes(PAT));
  assert.ok(!out.stdout.includes(PAT));
  assert.ok(!out.stderr.includes(PAT));
});

test("redactError handles non-Error values", () => {
  assert.equal(redactError(`oops ${CLASSIC}`), "oops [REDACTED]");
  assert.equal(redactError(42), 42);
});
