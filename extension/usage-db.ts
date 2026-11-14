import { existsSync } from "node:fs";
import { createRequire as makeRequire } from "node:module";
import path from "node:path";

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cachedWriteTokens: number;
  cachedReadTokens: number;
  thoughtTokens: number;
}

export interface StepUsageBatch {
  maxIdx: number;
  calls: number;
  usage: StepUsage & { totalTokens: number };
}

interface SqliteDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec?(sql: string): unknown;
  close(): void;
}

type NodeDatabaseConstructor = new (path: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDatabase;
type BunDatabaseConstructor = new (path: string, options?: { readonly?: boolean }) => SqliteDatabase;

let cachedOpener: ((dbPath: string) => SqliteDatabase) | null | undefined;

function resolveOpener(): ((dbPath: string) => SqliteDatabase) | undefined {
  if (cachedOpener !== undefined) return cachedOpener ?? undefined;
  try {
    if ((process.versions as Record<string, string | undefined>).bun) {
      // Keep the specifier non-literal so node-targeted bundling does not try to resolve bun:sqlite.
      const bunModule = "bun:sqlite";
      const sqlite = makeRequire(import.meta.url)(bunModule) as { Database?: BunDatabaseConstructor } | undefined;
      if (typeof sqlite?.Database === "function") {
        const BunDatabase = sqlite.Database;
        cachedOpener = (dbPath: string) => {
          const db = new BunDatabase(dbPath, { readonly: true });
          try { db.exec?.("PRAGMA busy_timeout = 100; PRAGMA cache_size = -256; PRAGMA mmap_size = 0;"); } catch { /* Best-effort lock timeout and cache cap. */ }
          return db;
        };
        return cachedOpener;
      }
    }
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const sqlite = getBuiltin?.("node:sqlite") as { DatabaseSync?: NodeDatabaseConstructor } | undefined;
    if (typeof sqlite?.DatabaseSync === "function") {
      const NodeDatabase = sqlite.DatabaseSync;
      cachedOpener = (dbPath: string) => {
        const db = new NodeDatabase(dbPath, { readOnly: true, timeout: 100 });
        try { db.exec?.("PRAGMA cache_size = -256; PRAGMA mmap_size = 0;"); } catch { /* Best-effort cache cap. */ }
        return db;
      };
      return cachedOpener;
    }
  } catch {
    // Fall through to mark SQLite unavailable in this runtime.
  }
  cachedOpener = null;
  return undefined;
}

export function conversationDbPath(acpDirectory: string, sessionId: string): string {
  return path.join(acpDirectory, "conversations", `${sessionId}.db`);
}

function readVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } | undefined {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < 10; index++) {
    const byte = buf[offset + index];
    if (byte === undefined) return undefined;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
    shift += 7n;
  }
  return undefined;
}

function count(raw: bigint): number {
  const signed = BigInt.asIntN(64, raw);
  if (signed <= 0n) return 0;
  return signed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(signed);
}

function parseUsageSubmessage(buf: Uint8Array, target: StepUsage): boolean {
  let position = 0;
  while (position < buf.length) {
    const tag = readVarint(buf, position);
    if (tag === undefined) return false;
    position = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field <= 0) return false;
    if (wire === 0) {
      const value = readVarint(buf, position);
      if (value === undefined) return false;
      position = value.next;
      const decoded = count(value.value);
      if (field === 2) target.inputTokens = decoded;
      else if (field === 3) target.outputTokens = decoded;
      else if (field === 4) target.cachedWriteTokens = decoded;
      else if (field === 5) target.cachedReadTokens = decoded;
      else if (field === 9) target.thoughtTokens = decoded;
    } else if (wire === 1) {
      if (position + 8 > buf.length) return false;
      position += 8;
    } else if (wire === 2) {
      const length = readVarint(buf, position);
      if (length === undefined) return false;
      const bytes = Number(length.value);
      if (length.value < 0n || !Number.isSafeInteger(bytes) || length.next + bytes > buf.length) return false;
      position = length.next + bytes;
    } else if (wire === 5) {
      if (position + 4 > buf.length) return false;
      position += 4;
    } else {
      return false;
    }
  }
  return true;
}

export function decodeModelUsageStats(metadata: Uint8Array): StepUsage | undefined {
  let position = 0;
  let found = false;
  const stats: StepUsage = { inputTokens: 0, outputTokens: 0, cachedWriteTokens: 0, cachedReadTokens: 0, thoughtTokens: 0 };
  while (position < metadata.length) {
    const tag = readVarint(metadata, position);
    if (tag === undefined) return undefined;
    position = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field <= 0) return undefined;
    if (wire === 0) {
      const value = readVarint(metadata, position);
      if (value === undefined) return undefined;
      position = value.next;
    } else if (wire === 1) {
      if (position + 8 > metadata.length) return undefined;
      position += 8;
    } else if (wire === 2) {
      const length = readVarint(metadata, position);
      if (length === undefined) return undefined;
      const bytes = Number(length.value);
      if (length.value < 0n || !Number.isSafeInteger(bytes) || length.next + bytes > metadata.length) return undefined;
      if (field === 9) {
        if (!parseUsageSubmessage(metadata.subarray(length.next, length.next + bytes), stats)) return undefined;
        found = true;
      }
      position = length.next + bytes;
    } else if (wire === 5) {
      if (position + 4 > metadata.length) return undefined;
      position += 4;
    } else {
      return undefined;
    }
  }
  return found ? stats : undefined;
}

export function peekMaxModelStepIdx(dbPath: string): number {
  if (!existsSync(dbPath)) return -1;
  const openDb = resolveOpener();
  if (openDb === undefined) return -1;
  try {
    const db = openDb(dbPath);
    try {
      const row = db.prepare("SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM steps WHERE step_type = 15 AND status = 3").get();
      const raw = row?.maxIdx;
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (typeof raw === "bigint") return Number(raw);
      return -1;
    } finally {
      db.close();
    }
  } catch {
    return -1;
  }
}

export function readModelStepsAfter(dbPath: string, afterIdx: number): StepUsageBatch | undefined {
  if (!existsSync(dbPath)) return undefined;
  const openDb = resolveOpener();
  if (openDb === undefined) return undefined;
  try {
    const db = openDb(dbPath);
    try {
      const batchSize = 256;
      const stmt = db.prepare("SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 AND idx > ? ORDER BY idx ASC LIMIT ?");
      let cursor = afterIdx;
      let maxIdx = afterIdx;
      let calls = 0;
      const usage: StepUsage = { inputTokens: 0, outputTokens: 0, cachedWriteTokens: 0, cachedReadTokens: 0, thoughtTokens: 0 };
      for (;;) {
        const rows = stmt.all(cursor, batchSize);
        if (rows.length === 0) break;
        let lastRowIdx = cursor;
        for (const row of rows) {
          const rawIdx = row.idx;
          const idx = typeof rawIdx === "number" && Number.isFinite(rawIdx) ? rawIdx : typeof rawIdx === "bigint" ? Number(rawIdx) : undefined;
          if (idx !== undefined && idx > lastRowIdx) lastRowIdx = idx;
          const rawMetadata = row.metadata;
          const metadata = rawMetadata instanceof Uint8Array
            ? rawMetadata
            : ArrayBuffer.isView(rawMetadata)
              ? new Uint8Array(rawMetadata.buffer, rawMetadata.byteOffset, rawMetadata.byteLength)
              : undefined;
          if (idx === undefined || metadata === undefined) continue;
          const decoded = decodeModelUsageStats(metadata);
          if (decoded === undefined) continue;
          if (idx > maxIdx) maxIdx = idx;
          calls++;
          usage.inputTokens += decoded.inputTokens;
          usage.outputTokens += decoded.outputTokens;
          usage.cachedWriteTokens += decoded.cachedWriteTokens;
          usage.cachedReadTokens += decoded.cachedReadTokens;
          usage.thoughtTokens += decoded.thoughtTokens;
        }
        if (rows.length < batchSize || lastRowIdx <= cursor) break;
        cursor = lastRowIdx;
      }
      if (calls === 0) return undefined;
      return {
        maxIdx,
        calls,
        usage: {
          ...usage,
          totalTokens: usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens + usage.outputTokens,
        },
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
