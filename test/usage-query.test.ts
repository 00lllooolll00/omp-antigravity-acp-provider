import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TierConnection } from "../extension/tier-connection.ts";
import { usageFromPrompt } from "../extension/usage.ts";
import { conversationDbPath } from "../extension/usage-db.ts";

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return bytes;
}

function varintField(tag: number, value: number): number[] {
  return [...varint(tag << 3), ...varint(value)];
}

function protoField(tag: number, payload: number[]): number[] {
  return [...varint((tag << 3) | 2), ...varint(payload.length), ...payload];
}

function modelStepMetadata(usage: {
  input: number;
  output: number;
  cachedWrite: number;
  cachedRead: number;
  thought: number;
}): Uint8Array {
  return Uint8Array.from(protoField(9, [
    ...varintField(2, usage.input),
    ...varintField(3, usage.output),
    ...varintField(4, usage.cachedWrite),
    ...varintField(5, usage.cachedRead),
    ...varintField(9, usage.thought),
  ]));
}

test("promptWithoutUsageDeltas bypasses supplemental usage accounting and prompt tracking", async () => {
  const connection = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {},
  });
  let calls = 0;
  Object.defineProperty(connection, "connection", { value: {
    prompt: async () => {
      calls++;
      return { stopReason: "end_turn" };
    },
  } });
  try {
    await connection.promptWithoutUsageDeltas({ sessionId: "session", prompt: [{ type: "text", text: "/usage" }] });
    assert.equal(calls, 1);
    assert.equal(connection.usageQueryCount, 0);
    assert.equal(connection.activePrompts, 0);
  } finally {
    await connection.close();
  }
});

test("concurrent /usage reads coalesce while a later read starts fresh", async () => {
  const connection: any = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {},
  });
  let calls = 0;
  connection.connection = {
    prompt: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { stopReason: "end_turn" };
    },
  };
  try {
    const [first, second] = await Promise.all([
      connection.readUsage("session"),
      connection.readUsage("session"),
    ]);
    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.equal(calls, 1, "a second caller must share the inflight read");
    await connection.readUsage("session");
    assert.equal(calls, 2, "a read after settlement must query again");
  } finally {
    await connection.close();
  }
});

test("prompt falls back to local session SQLite when /usage is absent", async () => {
  const acpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tier-usage-db-"));
  const dbPath = conversationDbPath(acpDir, "session-db");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)");
  const insert = db.prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)");
  insert.run(1, 15, 3, modelStepMetadata({ input: 50, output: 10, cachedWrite: 0, cachedRead: 10, thought: 5 }));

  const connection: any = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {},
    ompAcpDirectory: acpDir,
  });
  connection.connection = {
    prompt: async () => {
      insert.run(2, 15, 3, modelStepMetadata({ input: 120, output: 30, cachedWrite: 10, cachedRead: 80, thought: 15 }));
      insert.run(3, 14, 3, modelStepMetadata({ input: 999, output: 999, cachedWrite: 0, cachedRead: 0, thought: 0 }));
      return { stopReason: "end_turn" };
    },
  };
  try {
    const response = await connection.prompt({ sessionId: "session-db", prompt: [{ type: "text", text: "hello" }] });
    assert.deepEqual(response.usage, {
      inputTokens: 200,
      outputTokens: 30,
      cachedReadTokens: 80,
      cachedWriteTokens: 10,
      thoughtTokens: 15,
      totalTokens: 240,
    });
    const projected = usageFromPrompt(response);
    assert.equal(projected.input, 120);
    assert.equal(projected.output, 30);
    assert.equal(projected.cacheRead, 80);
    assert.equal(projected.cacheWrite, 10);
    assert.equal(projected.reasoning, 15);
    assert.equal(projected.totalTokens, 240);
    assert.deepEqual(connection.usageStatus.get("session-db"), {
      source: "local session db (1 call)",
      cache: "reported",
    });
  } finally {
    db.close();
    await connection.close();
    await fs.rm(acpDir, { recursive: true, force: true });
  }
});

test("rebindHandlers swaps downstream callbacks without re-registering base handlers", async () => {
  let setHandlersCalls = 0;
  let captured: any;
  class SpyTierConnection extends TierConnection {
    override setHandlers(handlers: any) {
      setHandlersCalls++;
      captured = handlers;
      return super.setHandlers(handlers);
    }
  }

  const seenA: unknown[] = [];
  const seenB: unknown[] = [];
  const connection = new SpyTierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {
      onUpdate: notification => {
        seenA.push(notification);
      },
    },
  });
  try {
    assert.equal(setHandlersCalls, 1);
    await captured.onUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } },
    });
    assert.equal(seenA.length, 1);

    connection.rebindHandlers({
      onUpdate: notification => {
        seenB.push(notification);
      },
    });
    assert.equal(setHandlersCalls, 1);

    await captured.onUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second" } },
    });
    assert.equal(seenA.length, 1);
    assert.equal(seenB.length, 1);
  } finally {
    await connection.close();
  }
});
