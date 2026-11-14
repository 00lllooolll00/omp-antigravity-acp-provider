// Offline test of the automatic ACP runtime-source choice: a newer agy CLI on
// PATH routes the launch through a generated AGY_ACP_BIN wrapper, while an
// older, broken or missing CLI and an explicit env override keep the managed
// runtime. Everything runs against stub binaries and fixture homes; no
// network, no real agy, no ACP session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertSelectedAcpCliLaunch, preferNewestAcpRuntime, prepareManagedAcpForQuota, resolveAcpPermissionProfile, resolveManagedAcpCommand } from "../extension/acp-runtime-source.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-source-"));
const bin = path.join(work, "bin");
const home = path.join(work, "home");
fs.mkdirSync(bin, { recursive: true });

function stubAgy(script: string): void {
  const file = path.join(bin, "agy");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
}

function removeAgy(): void {
  fs.rmSync(path.join(bin, "agy"), { force: true });
}

function setManagedVersion(version: string): void {
  const current = path.join(home, ".local", "opt", "agy-acp", "current");
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, "install-integrity.json"), JSON.stringify({ version }));
  const binary = path.join(current, "agy_acp_server.par");
  fs.writeFileSync(binary, "fixture managed binary");
  fs.chmodSync(binary, 0o755);
}

function freshStateDir(): string {
  const stateDir = path.join(work, `state-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function freshEnv(): NodeJS.ProcessEnv {
  return { PATH: `${bin}${path.delimiter}/usr/bin:/bin` };
}

// An explicit AGY_ACP_BIN always wins and nothing is written.
{
  const env = freshEnv();
  env.AGY_ACP_BIN = "/opt/custom-agy";
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "env");
  assert.equal(env.AGY_ACP_BIN, "/opt/custom-agy");
  assert.equal(fs.existsSync(path.join(stateDir, "agy-acp-cli.sh")), false);
}

// A newer CLI takes over through a generated executable wrapper and records
// the decision.
{
  const argvRecord = path.join(work, "agy-argv.txt");
  stubAgy(`if [ "$1" = "acp" ] && [ "$2" = "--version" ]; then\n  echo 9.9.9\n  exit 0\nfi\nprintf '%s\\n' "$@" > '${argvRecord}'`);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "cli");
  assert.equal(preference.cliVersion, "9.9.9");
  assert.equal(preference.managedVersion, "1.4.5");
  const wrapper = path.join(stateDir, "agy-acp-cli.sh");
  assert.equal(env.AGY_ACP_BIN, wrapper);
  const script = fs.readFileSync(wrapper, "utf8");
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.ok(script.includes(`exec '${path.join(bin, "agy")}' acp --app_data_dir=antigravity-acp "$@"`));
  fs.accessSync(wrapper, fs.constants.X_OK);
  const record = JSON.parse(fs.readFileSync(path.join(stateDir, "acp-runtime-source.json"), "utf8"));
  assert.equal(record.source, "cli");
  assert.equal(record.cliVersion, "9.9.9");
  const repeated = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(repeated.source, "cli");
  assert.equal(repeated.cliVersion, "9.9.9");
  assert.equal(repeated.managedVersion, "1.4.5");
  assert.equal(resolveAcpPermissionProfile(repeated, "yolo").wireMode, "default");
  assert.equal(resolveAcpPermissionProfile(repeated, "yolo").autoApproveProcess, true);

  for (const marker of ["1", undefined, ""]) {
    const childEnv = freshEnv();
    if (marker !== undefined) childEnv.OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS = marker;
    fs.rmSync(argvRecord, { force: true });
    const result = spawnSync(wrapper, ["--fixture-argument"], { env: childEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const argv = fs.readFileSync(argvRecord, "utf8").trimEnd().split("\n");
    assert.equal(argv.filter(value => value === "--dangerously-skip-permissions").length, marker === "1" ? 1 : 0,
      `dangerous flag count with marker ${JSON.stringify(marker)}`);
    assert.equal(argv.filter(value => value === "--include-default-customizations=false").length, 1);
    assert.equal(argv.filter(value => value === `--gemini-dir=${path.join(stateDir, "agy-gemini")}`).length, 1);
    assert.deepEqual(argv.slice(0, 2), ["acp", "--app_data_dir=antigravity-acp"]);
    assert.equal(argv.at(-1), "--fixture-argument");
    assert.equal(fs.existsSync(path.join(stateDir, "agy-gemini", "config", ".migrated")), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "agy-gemini", "config", "mcp_config.json"), "utf8")), { mcpServers: {} });
  }
  assert.doesNotThrow(() => assertSelectedAcpCliLaunch(stateDir, preference, env));
  assert.throws(() => assertSelectedAcpCliLaunch(stateDir, preference, { ...env, AGY_ACP_BIN: "/usr/bin/false" }), /not selected by AGY_ACP_BIN/);
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
  assert.throws(() => assertSelectedAcpCliLaunch(stateDir, preference, env), /changed/);
  fs.rmSync(wrapper);
  assert.throws(() => assertSelectedAcpCliLaunch(stateDir, preference, env), /wrapper is missing, changed, not executable/);
}

// A record-write failure must abort CLI selection before AGY_ACP_BIN is set.
{
  stubAgy("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  fs.mkdirSync(path.join(stateDir, "acp-runtime-source.json"));
  await assert.rejects(preferNewestAcpRuntime(stateDir, env, home));
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// An equal or older CLI keeps the managed runtime.
for (const version of ["1.4.5", "1.0.0"]) {
  stubAgy(`echo ${version}`);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "managed");
  assert.equal(preference.cliVersion, version);
  assert.equal(env.AGY_ACP_BIN, undefined);
  assert.equal(fs.existsSync(path.join(stateDir, "agy-acp-cli.sh")), false);
}

// A missing managed record still prefers a working CLI.
{
  stubAgy("echo 2.0.0");
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "cli");
  assert.equal(preference.managedVersion, undefined);
}

// A CLI without a usable `acp --version` is never selected.
for (const script of ["exit 1", "echo prerelease"]) {
  stubAgy(script);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "managed");
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// No CLI on PATH keeps the managed runtime.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "managed");
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// Automatic CLI selection keeps inference there, while quota uses the managed ACP.
{
  stubAgy("echo 3.0.0");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "cli");
  const quota = assertSelectedAcpCliLaunch(stateDir, preference, env, "quota", home);
  const command = path.join(home, ".local", "opt", "agy-acp", "current", "agy_acp_server.par");
  assert.deepEqual(quota, { command, args: process.platform === "linux" ? ["--uid="] : [] });
  assert.equal(env.AGY_ACP_BIN, command);
  assert.deepEqual(resolveManagedAcpCommand(home, "linux"), { command, args: ["--uid="] });
  env.AGY_ACP_BIN = "/opt/custom-quota-bin";
  assertSelectedAcpCliLaunch(stateDir, preference, env, "quota");
  assert.equal(env.AGY_ACP_BIN, "/opt/custom-quota-bin");
}

// Identical agy binary stats reuse the recorded CLI version without re-spawning `agy acp --version`.
{
  const stateDir = freshStateDir();
  const countFile = path.join(stateDir, "probe-count.log");
  setManagedVersion("1.4.5");
  stubAgy(`if [ "$1" = "acp" ] && [ "$2" = "--version" ]; then\n  echo 1 >> '${countFile}'\n  echo 2.0.0\n  exit 0\nfi`);
  const first = await preferNewestAcpRuntime(stateDir, freshEnv(), home);
  assert.equal(first.source, "cli");
  assert.equal(first.cliVersion, "2.0.0");
  assert.ok(first.cliStamp);
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split("\n").length, 1);

  const second = await preferNewestAcpRuntime(stateDir, freshEnv(), home);
  assert.equal(second.source, "cli");
  assert.equal(second.cliVersion, "2.0.0");
  assert.equal(second.cliStamp, first.cliStamp);
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split("\n").length, 1);

  stubAgy(`if [ "$1" = "acp" ] && [ "$2" = "--version" ]; then\n  echo 1 >> '${countFile}'\n  echo 2.1.0\n  exit 0\nfi`);
  const third = await preferNewestAcpRuntime(stateDir, freshEnv(), home);
  assert.equal(third.source, "cli");
  assert.equal(third.cliVersion, "2.1.0");
  assert.notEqual(third.cliStamp, first.cliStamp);
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split("\n").length, 2);
}
{
  stubAgy("echo 3.0.0");
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "cli");
  const wrapper = env.AGY_ACP_BIN;
  assert.ok(wrapper?.endsWith("agy-acp-cli.sh"));

  let sawEnvDuringSyncStart: string | undefined = "sentinel";
  let installCalls = 0;
  const installed = await prepareManagedAcpForQuota(stateDir, async () => {
    sawEnvDuringSyncStart = env.AGY_ACP_BIN;
    installCalls++;
    await Promise.resolve();
    assert.equal(env.AGY_ACP_BIN, wrapper, "cli wrapper must already be restored across async install work");
    setManagedVersion("1.4.5");
  }, env, home);
  assert.equal(installed, "installed");
  assert.equal(installCalls, 1);
  assert.equal(sawEnvDuringSyncStart, undefined);
  assert.equal(env.AGY_ACP_BIN, wrapper);

  const alreadyReady = await prepareManagedAcpForQuota(stateDir, async () => {
    installCalls++;
  }, env, home);
  assert.equal(alreadyReady, "ready");
  assert.equal(installCalls, 1);

  env.AGY_ACP_BIN = "/opt/custom-quota-bin";
  const custom = await prepareManagedAcpForQuota(stateDir, async () => {
    installCalls++;
  }, env, home);
  assert.equal(custom, "custom");
  assert.equal(installCalls, 1);
  assert.equal(env.AGY_ACP_BIN, "/opt/custom-quota-bin");
}

// Default isolation isolates ~/.gemini/config/mcp_config.json while preserving
// antigravity-acp state via symlink, supports GEMINI_HOME & spaces, honors explicit
// --gemini-dir or OMP_ACP_INCLUDE_DEFAULT_CUSTOMIZATIONS, and refreshes stale wrappers.
{
  const isoRoot = path.join(work, "iso space");
  const isoState = path.join(isoRoot, "state dir");
  const isoHome = path.join(isoRoot, "home dir");
  const realAcp = path.join(isoHome, ".gemini", "antigravity-acp");
  const argvRecord = path.join(isoRoot, "argv.txt");
  fs.mkdirSync(realAcp, { recursive: true });
  fs.writeFileSync(path.join(realAcp, "acp_token.json"), JSON.stringify({ marker: "keep-auth" }));
  fs.mkdirSync(path.join(isoHome, ".gemini", "config"), { recursive: true });
  fs.writeFileSync(path.join(isoHome, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: { codegraph: { command: "true" } } }));
  stubAgy(`if [ "$1" = "acp" ] && [ "$2" = "--version" ]; then\n  echo 9.9.9\n  exit 0\nfi\nprintf '%s\\n' "$@" > '${argvRecord}'`);
  setManagedVersion("1.4.5");

  // Pre-seed a stale wrapper without --gemini-dir plus matching cliStamp to prove in-place refresh.
  fs.mkdirSync(isoState, { recursive: true });
  const preEnv = freshEnv();
  const first = await preferNewestAcpRuntime(isoState, preEnv, home);
  const wrapper = path.join(isoState, "agy-acp-cli.sh");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexec 'old' acp --include-default-customizations=false \"$@\"\n", { mode: 0o755 });
  const refreshEnv = freshEnv();
  const refreshed = await preferNewestAcpRuntime(isoState, refreshEnv, home);
  assert.equal(refreshed.cliStamp, first.cliStamp);
  assert.doesNotThrow(() => assertSelectedAcpCliLaunch(isoState, refreshed, refreshEnv));
  assert.ok(fs.readFileSync(wrapper, "utf8").includes("--gemini-dir="));

  // Default run with spaces in HOME and stateDir.
  const childEnv = { ...freshEnv(), HOME: isoHome };
  fs.rmSync(argvRecord, { force: true });
  let res = spawnSync(wrapper, ["--fixture-arg"], { env: childEnv, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const isolatedDir = path.join(isoState, "agy-gemini");
  let argv = fs.readFileSync(argvRecord, "utf8").trimEnd().split("\n");
  assert.ok(argv.includes(`--gemini-dir=${isolatedDir}`));
  assert.ok(argv.includes("--include-default-customizations=false"));
  assert.equal(argv.at(-1), "--fixture-arg");
  assert.equal(fs.lstatSync(path.join(isolatedDir, "antigravity-acp")).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(isolatedDir, "antigravity-acp")), fs.realpathSync(realAcp));
  assert.equal(JSON.parse(fs.readFileSync(path.join(isolatedDir, "antigravity-acp", "acp_token.json"), "utf8")).marker, "keep-auth");
  assert.equal(fs.existsSync(path.join(isolatedDir, "config", ".migrated")), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(isolatedDir, "config", "mcp_config.json"), "utf8")), { mcpServers: {} });

  // Tampering with isolated mcp_config.json is healed on next launch.
  fs.writeFileSync(path.join(isolatedDir, "config", "mcp_config.json"), '{"mcpServers":{"stale":{}}}');
  res = spawnSync(wrapper, ["--fixture-arg"], { env: childEnv, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(isolatedDir, "config", "mcp_config.json"), "utf8")), { mcpServers: {} });

  // GEMINI_HOME with leading/trailing spaces and ~/ updates the symlink target.
  const tildeEnv = { ...childEnv, GEMINI_HOME: "  ~/custom gemini  " };
  res = spawnSync(wrapper, ["--fixture-arg"], { env: tildeEnv, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.realpathSync(path.join(isolatedDir, "antigravity-acp")),
    fs.realpathSync(path.join(isoHome, "custom gemini", "antigravity-acp")));

  // GEMINI_HOME switching to an absolute path updates the symlink again.
  const absGemini = path.join(isoRoot, "abs gemini");
  res = spawnSync(wrapper, ["--fixture-arg"], { env: { ...childEnv, GEMINI_HOME: absGemini }, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.realpathSync(path.join(isolatedDir, "antigravity-acp")),
    fs.realpathSync(path.join(absGemini, "antigravity-acp")));

  // Explicit --gemini-dir / --gemini_dir from caller is preserved without adding another.
  for (const explicit of ["--gemini-dir=/tmp/explicit-a", "--gemini_dir=/tmp/explicit-b"]) {
    fs.rmSync(argvRecord, { force: true });
    res = spawnSync(wrapper, [explicit], { env: childEnv, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    argv = fs.readFileSync(argvRecord, "utf8").trimEnd().split("\n");
    assert.equal(argv.filter(value => value.startsWith("--gemini-dir") || value.startsWith("--gemini_dir")).length, 1);
    assert.ok(argv.includes(explicit));
    assert.ok(argv.includes("--include-default-customizations=false"));
  }

  // OMP_ACP_INCLUDE_DEFAULT_CUSTOMIZATIONS=1 or true restores unmodified CLI behavior.
  for (const optIn of ["1", "true"]) {
    fs.rmSync(argvRecord, { force: true });
    res = spawnSync(wrapper, ["--fixture-arg"], {
      env: { ...childEnv, OMP_ACP_INCLUDE_DEFAULT_CUSTOMIZATIONS: optIn },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    argv = fs.readFileSync(argvRecord, "utf8").trimEnd().split("\n");
    assert.equal(argv.some(value => value.startsWith("--gemini-dir")), false);
    assert.equal(argv.includes("--include-default-customizations=false"), false);
    assert.deepEqual(argv, ["acp", "--app_data_dir=antigravity-acp", "--fixture-arg"]);
  }

  // Non-opt-in values ("0", "") still keep isolation active.
  for (const keepIso of ["0", ""]) {
    fs.rmSync(argvRecord, { force: true });
    res = spawnSync(wrapper, ["--fixture-arg"], {
      env: { ...childEnv, OMP_ACP_INCLUDE_DEFAULT_CUSTOMIZATIONS: keepIso },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    argv = fs.readFileSync(argvRecord, "utf8").trimEnd().split("\n");
    assert.ok(argv.includes(`--gemini-dir=${isolatedDir}`));
    assert.ok(argv.includes("--include-default-customizations=false"));
  }
}

fs.rmSync(work, { recursive: true, force: true });
console.log("acp-runtime-source: all selection cases passed");
