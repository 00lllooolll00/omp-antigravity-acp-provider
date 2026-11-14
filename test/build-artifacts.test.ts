import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const bundle = path.resolve("extension/runtime.mjs");
const built = fs.existsSync(bundle);

test("built writer classifies quota failures before OMP decides to retry", { skip: !built }, async () => {
  const { PiEventWriter } = await import("../extension/runtime.mjs");
  const writer = new PiEventWriter({ api: "acp", provider: "antigravity-acp", id: "test" });
  writer.fail(new Error("You exceeded your monthly limit"));
  const events: any[] = [];
  for await (const event of writer.stream) events.push(event);
  const failure = events.find(event => event.type === "error");
  assert.match(failure.error.errorMessage, /quota exceeded/);
});

test("built MCP bridge disables Node server timeouts", { skip: !built }, () => {
  const text = fs.readFileSync(bundle, "utf8");
  assert.match(text, /this\.server\.keepAliveTimeout = 0;/);
  assert.match(text, /this\.server\.requestTimeout = 0;/);
  assert.match(text, /this\.server\.headersTimeout = 0;/);
});

test("built runtime passes the full-context estimate to the final usage projection", { skip: !built }, () => {
  const text = fs.readFileSync(bundle, "utf8");
  assert.match(text, /usageFromPrompt2\(response, binding\.ompFallbackContextTokens\)/,
    "the final response must receive the full OMP context estimate");
});

test("built quota probe waits for /usage and spares an in-flight OAuth refresh", { skip: !built }, () => {
  const text = fs.readFileSync(bundle, "utf8");
  assert.match(text, /waitForUsageCommand\(sessionId, (?:20000|2e4), signal\)/,
    "an expired-token refresh started at boot must not be cut off by the old 5 s probe");
  assert.match(text, /setTimeout\(resolve, (?:1500|1\.5e3)\)/,
    "closing the probe process must wait a grace period so its token refresh can finish");
});

test("built quota probe isolates session cwd outside the project directory", { skip: !built }, () => {
  const text = fs.readFileSync(bundle, "utf8");
  assert.match(text, /const quotaCwd = join\(tmpdir\(\), "omp-antigravity-acp-quota"\);/,
    "quota probe must use a dedicated temporary directory as its cwd");
  assert.match(text, /const quotaOptions = \{ cwd: quotaCwd, ompPurpose: "quota" \};/,
    "quota probe connection must spawn in quotaCwd rather than process.cwd()");
  assert.match(text, /await connection\.newSession\(quotaCwd, signal\);/,
    "quota probe session/new must use quotaCwd so upstream runtime files are not materialized in the workspace");
});

test("built bundle lazy-loads unzipper chunk and drops non-English zod locales", { skip: !built }, async () => {
  const text = fs.readFileSync(bundle, "utf8");
  assert.doesNotMatch(text, /node_modules\/zod\/v4\/locales\/zh-CN\.js/);
  assert.doesNotMatch(text, /node_modules\/unzipper\//);
  const zipChunkPath = path.resolve("extension/assets/zip-archive.mjs");
  assert.equal(fs.existsSync(zipChunkPath), true);
  // Intentionally exercise the runtime lazy-import boundary of the split chunk.
  const zipMod = await import(zipChunkPath);
  assert.equal(typeof zipMod.Open?.file, "function");
});
