import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerOmpAdapter } from "../extension/index.ts";
import type { OmpCommandContext } from "../extension/auth-sync.ts";
import type { TierConnection } from "../extension/tier-connection.ts";

type Hook = (event: unknown, ctx: OmpCommandContext) => unknown;
type Command = { handler: (args: string, ctx: OmpCommandContext) => Promise<void> };
type Provider = {
  streamSimple: (model: { id: string }, context: { messages: unknown[] }, options?: { sessionId?: string }) => AsyncIterable<any>;
};

async function createIsolatedFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-warmup-test-")));
  const state = path.join(root, "agent", "antigravity-acp-provider");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "config.json"), JSON.stringify({ permissions: "yolo", runtimeUpdates: "off" }));
  await fs.writeFile(
    path.join(state, "models-cache.json"),
    JSON.stringify({
      schemaVersion: 2,
      models: [{ modelId: "gemini-3.8-flash", name: "Offline Flash" }],
    }),
  );

  const envPatch = {
    HOME: path.join(root, "home"),
    GEMINI_HOME: path.join(root, "gemini"),
    GEMINI_API_KEY: "offline-warmup-fixture",
    AGY_ACP_BIN: process.execPath,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    OMP_ACP_IDLE_TIMEOUT_MS: "0",
    OMP_ACP_MAX_IDLE_RUNTIMES: "0",
    OMP_ACP_USAGE: "off",
    OMP_ACP_WARMUP: undefined as string | undefined,
  };
  const saved = Object.fromEntries(Object.keys(envPatch).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(envPatch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return {
    root,
    state,
    restore: async () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function makeFakeConnectionFactory(onInit?: (index: number, signal?: AbortSignal) => Promise<void>) {
  const records: Array<{
    index: number;
    options: any;
    initializeCalls: number;
    newSessionCalls: number;
    discardSessionCalls: number;
    rebindCalls: number;
    configureUsageCalls: number;
    closeCalls: number;
    abortedDuringInit: boolean;
  }> = [];
  let serial = 0;

  const createConnection: NonNullable<ConstructorParameters<typeof registerOmpAdapter>[2]> = options => {
    const index = ++serial;
    const exited = Promise.withResolvers<{ code: number }>();
    const processHandle = { alive: true, pid: process.pid, exited: exited.promise, generation: index };
    const sessionId = randomUUID();
    const sessionState = {
      modes: { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] },
      models: {
        currentModelId: "gemini-3.8-flash",
        availableModels: [{ modelId: "gemini-3.8-flash", name: "Offline Flash" }],
      },
    };
    let handlers = options.handlers ?? {};
    const record = {
      index,
      options,
      initializeCalls: 0,
      newSessionCalls: 0,
      discardSessionCalls: 0,
      rebindCalls: 0,
      configureUsageCalls: 0,
      closeCalls: 0,
      abortedDuringInit: false,
    };
    records.push(record);

    const connection = {
      process: processHandle,
      activePrompts: 0,
      contextUsage: new Map(),
      usageStatus: new Map(),
      debugToolUpdates: Boolean(options.ompDebugToolUpdates),
      configureUsage() {
        record.configureUsageCalls++;
      },
      rebindHandlers(nextHandlers: any = {}) {
        record.rebindCalls++;
        handlers = nextHandlers;
      },
      async initialize(signal?: AbortSignal) {
        record.initializeCalls++;
        signal?.addEventListener("abort", () => {
          record.abortedDuringInit = true;
        }, { once: true });
        if (onInit) await onInit(index, signal);
        if (signal?.aborted) throw new Error("Aborted");
        return { protocolVersion: 1, agentCapabilities: {} };
      },
      async newSession() {
        record.newSessionCalls++;
        return { sessionId, ...sessionState };
      },
      getSessionState() {
        return sessionState;
      },
      async setMode(id: string, mode: string) {
        if (id === sessionId) sessionState.modes.currentModeId = mode;
      },
      async setModel(_id: string, model: string) {
        sessionState.models.currentModelId = model;
      },
      async discardSession() {
        record.discardSessionCalls++;
      },
      waitForUsageCommand() {
        return true;
      },
      async prompt() {
        await handlers.onUpdate?.({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ok-from-acp" },
          },
        });
        return { stopReason: "end_turn" };
      },
      async close() {
        record.closeCalls++;
        if (!processHandle.alive) return;
        processHandle.alive = false;
        exited.resolve({ code: 0 });
      },
    };
    return connection as unknown as TierConnection;
  };

  return { createConnection, records };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("standby warmup initializes once without newSession and is reused on first prompt", async () => {
  const fixture = await createIsolatedFixture();
  try {
    const hooks = new Map<string, Hook>();
    const notices: string[] = [];
    let command: Command | undefined;
    let provider: Provider | undefined;
    const { createConnection, records } = makeFakeConnectionFactory();

    await registerOmpAdapter(
      {
        on(name, fn) { hooks.set(name, fn); },
        registerTool() {},
        registerProvider(_name, value) { provider = value as Provider; },
        registerCommand(_name, registered) { command = registered as Command; },
      },
      fixture.state,
      createConnection,
      {
        standbyWarmup: true,
        prepareRuntime: async () => {},
        authReady: async () => true,
      },
    );

    assert.ok(command && provider);
    const ctx: OmpCommandContext = { ui: { notify(message) { notices.push(message); } } };
    await command.handler("diagnostics on", ctx);

    await hooks.get("session_start")!({ model: { provider: "antigravity-acp" } }, ctx);
    await waitFor(() => records.length === 1 && records[0]!.initializeCalls === 1, "warmup initialize");
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(records.length, 1);
    assert.equal(records[0]!.newSessionCalls, 0, "warmup must not create a throwaway ACP session");
    assert.equal(records[0]!.discardSessionCalls, 0, "warmup must not discard a throwaway ACP session");

    // Quota query must ignore standby and leave it intact for inference.
    await command.handler("quota", { ...ctx, sessionManager: { getSessionId: () => "quota-check" } });
    assert.equal(records.length, 2);
    assert.equal(records[1]!.options.ompPurpose, "quota");
    assert.equal(records[0]!.rebindCalls, 0);

    const events: any[] = [];
    for await (const event of provider.streamSimple(
      { id: "gemini-3.8-flash" },
      { messages: [{ role: "user", content: "hello" }] },
      { sessionId: "s-hit" },
    )) {
      events.push(event);
    }

    assert.equal(records.length, 2, "inference must reuse standby instead of spawning a 3rd process");
    assert.equal(records[0]!.rebindCalls, 1, "standby connection must rebind downstream handlers");
    assert.equal(records[0]!.configureUsageCalls, 1);
    assert.equal(records[0]!.newSessionCalls, 1);
    assert.equal(events.at(-1)?.type, "done");

    notices.length = 0;
    await command.handler("diagnostics", ctx);
    assert.match(notices[0]!, /warmup\.initialize/);
    assert.match(notices[0]!, /warmup\.hit/);

    await hooks.get("session_shutdown")!({}, { ...ctx, sessionManager: { getSessionId: () => "s-hit" } });
  } finally {
    await fixture.restore();
  }
});

test("first prompt arriving before warmup finishes initializing does not hijack or corrupt standby", async () => {
  const fixture = await createIsolatedFixture();
  try {
    const hooks = new Map<string, Hook>();
    const notices: string[] = [];
    let provider: Provider | undefined;
    let command: Command | undefined;
    const warmupGate = Promise.withResolvers<void>();
    const { createConnection, records } = makeFakeConnectionFactory(async index => {
      if (index === 1) await warmupGate.promise;
    });

    await registerOmpAdapter(
      {
        on(name, fn) { hooks.set(name, fn); },
        registerTool() {},
        registerProvider(_name, value) { provider = value as Provider; },
        registerCommand(_name, registered) { command = registered as Command; },
      },
      fixture.state,
      createConnection,
      {
        standbyWarmup: true,
        prepareRuntime: async () => {},
        authReady: async () => true,
      },
    );

    assert.ok(provider && command);
    const ctx: OmpCommandContext = { ui: { notify(message) { notices.push(message); } } };
    await command.handler("diagnostics on", ctx);

    // Start warmup, wait until its initialize() is mid-flight.
    void hooks.get("session_start")!({ model: { provider: "antigravity-acp" } }, ctx);
    await waitFor(() => records.length === 1 && records[0]!.initializeCalls === 1, "in-flight warmup spawn");

    // First prompt arrives while warmup initialize() is still blocked.
    const stream = provider.streamSimple(
      { id: "gemini-3.8-flash" },
      { messages: [{ role: "user", content: "race test" }] },
      { sessionId: "s-race" },
    );
    const events: any[] = [];
    for await (const event of stream) events.push(event);

    assert.equal(events.at(-1)?.type, "done");
    assert.equal(records.length, 2, "cold-start fallback must spawn a dedicated connection");
    assert.equal(records[0]!.rebindCalls, 0, "incomplete warmup connection must not be hijacked");
    assert.equal(records[0]!.abortedDuringInit, true, "superseded warmup must be aborted");

    warmupGate.resolve();
    await waitFor(() => records[0]!.closeCalls >= 1, "superseded warmup connection closed");
    assert.equal(records[0]!.newSessionCalls, 0);
    assert.equal(records[0]!.discardSessionCalls, 0);

    notices.length = 0;
    await command.handler("diagnostics", ctx);
    assert.match(notices[0]!, /warmup\.miss/);

    await hooks.get("session_shutdown")!({}, { ...ctx, sessionManager: { getSessionId: () => "s-race" } });
  } finally {
    await fixture.restore();
  }
});

test("session_shutdown aborts in-flight warmup and policy change closes published standby", async () => {
  const fixture = await createIsolatedFixture();
  try {
    const hooks = new Map<string, Hook>();
    let command: Command | undefined;
    const initGate = Promise.withResolvers<void>();
    const { createConnection, records } = makeFakeConnectionFactory(async index => {
      if (index === 1) await initGate.promise;
    });

    await registerOmpAdapter(
      {
        on(name, fn) { hooks.set(name, fn); },
        registerTool() {},
        registerProvider() {},
        registerCommand(_name, registered) { command = registered as Command; },
      },
      fixture.state,
      createConnection,
      {
        standbyWarmup: true,
        prepareRuntime: async () => {},
        authReady: async () => true,
      },
    );

    assert.ok(command);
    const ctx: OmpCommandContext = { ui: { notify() {} } };

    // Case A: shutdown while warmup is still awaiting initialize().
    await hooks.get("session_start")!({ model: { provider: "antigravity-acp" } }, ctx);
    await waitFor(() => records.length === 1 && records[0]!.initializeCalls === 1, "warmup started");
    const shutdownPromise = Promise.resolve(hooks.get("session_shutdown")!({}, ctx));
    await waitFor(() => records[0]!.abortedDuringInit, "shutdown aborts warmup signal");
    initGate.resolve();
    await shutdownPromise;
    assert.equal(records[0]!.closeCalls, 1, "shutdown must await close of aborted in-flight warmup");

    // Case B: new session warms up cleanly, then native-tools change closes published standby.
    await hooks.get("session_start")!({ model: { provider: "antigravity-acp" } }, ctx);
    await waitFor(() => records.length === 2 && records[1]!.initializeCalls === 1, "second warmup started");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(records[1]!.closeCalls, 0);

    await command.handler("native-tools disabled", ctx);
    await waitFor(() => records[1]!.closeCalls === 1, "native-tools policy change closes standby");
  } finally {
    await fixture.restore();
  }
});
test("OMP_ACP_WARMUP=off disables warmup and permissions change closes published standby", async () => {
  const fixture = await createIsolatedFixture();
  try {
    process.env.OMP_ACP_WARMUP = "off";
    const disabledHooks = new Map<string, Hook>();
    const disabledFactory = makeFakeConnectionFactory();
    await registerOmpAdapter(
      {
        on(name, fn) { disabledHooks.set(name, fn); },
        registerTool() {},
        registerProvider() {},
        registerCommand() {},
      },
      fixture.state,
      disabledFactory.createConnection,
      {
        standbyWarmup: true,
        prepareRuntime: async () => {},
        authReady: async () => true,
      },
    );
    await disabledHooks.get("session_start")!(
      { model: { provider: "antigravity-acp" } },
      { ui: { notify() {} } },
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(disabledFactory.records.length, 0);

    delete process.env.OMP_ACP_WARMUP;
    const hooks = new Map<string, Hook>();
    let command: Command | undefined;
    const { createConnection, records } = makeFakeConnectionFactory();
    await registerOmpAdapter(
      {
        on(name, fn) { hooks.set(name, fn); },
        registerTool() {},
        registerProvider() {},
        registerCommand(_name, registered) { command = registered as Command; },
      },
      fixture.state,
      createConnection,
      {
        standbyWarmup: true,
        prepareRuntime: async () => {},
        authReady: async () => true,
      },
    );
    assert.ok(command);
    const ctx: OmpCommandContext = { ui: { notify() {} } };
    await hooks.get("session_start")!({ model: { provider: "antigravity-acp" } }, ctx);
    await waitFor(() => records.length === 1 && records[0]!.initializeCalls === 1, "warmup published");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(records[0]!.closeCalls, 0);

    await command.handler("permissions auto-edit", ctx);
    await waitFor(() => records[0]!.closeCalls === 1, "permissions change closes standby");
  } finally {
    await fixture.restore();
  }
});

test("switching away from antigravity-acp closes standby and active connections skip redundant warmup", async () => {
  const fixture = await createIsolatedFixture();
  try {
    const hooks = new Map<string, Hook>();
    let provider: Provider | undefined;
    const { createConnection, records } = makeFakeConnectionFactory();
    await registerOmpAdapter(
      {
        on(name, fn) { hooks.set(name, fn); },
        registerTool() {},
        registerProvider(_name, value) { provider = value as Provider; },
        registerCommand() {},
      },
      fixture.state,
      createConnection,
      {
        standbyWarmup: true,
        prepareRuntime: async () => {},
        authReady: async () => true,
      },
    );
    assert.ok(provider);
    const ctx: OmpCommandContext = { ui: { notify() {} } };
    await hooks.get("session_start")!({ model: { provider: "antigravity-acp" } }, ctx);
    await waitFor(() => records.length === 1 && records[0]!.initializeCalls === 1, "initial warmup");
    await new Promise(resolve => setTimeout(resolve, 20));

    // Selecting a different provider releases the idle standby process.
    hooks.get("model_select")!({ model: { provider: "openai" } }, ctx);
    await waitFor(() => records[0]!.closeCalls === 1, "model_select away closes standby");

    // Warm up again, consume via prompt, then verify model_select on an active session does not spawn an extra standby.
    await hooks.get("session_start")!({ model: { provider: "antigravity-acp" } }, ctx);
    await waitFor(() => records.length === 2 && records[1]!.initializeCalls === 1, "second warmup");
    await new Promise(resolve => setTimeout(resolve, 20));
    for await (const _event of provider.streamSimple(
      { id: "gemini-3.8-flash" },
      { messages: [{ role: "user", content: "hi" }] },
      { sessionId: "s-active" },
    )) {}
    hooks.get("model_select")!({ model: { provider: "antigravity-acp" } }, ctx);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(records.length, 2, "active connection in pool must prevent spawning redundant standby");

    await hooks.get("session_shutdown")!({}, { ...ctx, sessionManager: { getSessionId: () => "s-active" } });
  } finally {
    await fixture.restore();
  }
});
