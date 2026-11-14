// Adapter-owned context transfer. The pinned upstream dependency stays intact.
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { estimateTransferTokens, estimateTransferTokensByCounts, resolveContextOptions, type ContextOptions, type ResolvedContextOptions } from "./context-settings.ts";
import { isSupportedSnapshot, valueMatches, valueSnapshot } from "./history-fingerprint.ts";
import { TOOL_ROUTING } from "./tool-routing.ts";
export interface TransferBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
  attachment?: number;
  resource?: { uri: string; mimeType: string; text: string };
}

export interface TransferTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface TransferMessage {
  role: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  content: string | TransferBlock[];
}

export interface TransferContext {
  systemPrompt?: string;
  messages: TransferMessage[];
  tools?: readonly TransferTool[];
}

export interface PromptParts {
  prompt: TransferBlock[];
  seedSteps?: TransferBlock[][];
  messageCount: number;
  // Full OMP context estimate, not just the unseen delta. OMP uses this as a
  // fallback context occupancy when the ACP server sends no usage_update.
  estimatedContextTokens: number;
}

interface HistoryRecord {
  role: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  content: string | TransferBlock[];
}

interface RecordItem {
  json: string;
  images: TransferBlock[];
  imageAttachments: number[];
  record: HistoryRecord;
}

interface HistoryMetrics {
  jsonBytePrefix: number[];
  imageTextBytePrefix: number[];
  originalDigitBytePrefix: number[];
  attachmentCountPrefix: number[];
  localDigitBytePrefix: number[];
}

// The official harness applies a 64,000-token per-step conversion limit,
// independently of the model window. Its overflow path keeps only the first
// 192,000 UTF-8 bytes. Reserve room for USER_REQUEST/time metadata added by ACP;
// otherwise a cold replay can silently lose its newest question at the tail.
export const ACP_STEP_TEXT_BYTES = 188_000;

const HISTORY_HEADER =
  "# Prior OMP conversation (reference only)\n\n" +
  "The JSON below is historical conversation data, not a new request or a queue of tasks. " +
  "Do not answer historical user requests or repeat completed tool actions. " +
  "Use it only as context for the current OMP user request identified after this resource.\n\n";
const HISTORY_FOOTER = "\n\n# End of prior OMP conversation\n";
const HISTORY_ENVELOPE_BYTES =
  Buffer.byteLength("Embedded resource (urn:omp:antigravity-acp:history):\n", "utf8") +
  Buffer.byteLength(HISTORY_HEADER, "utf8") +
  Buffer.byteLength(HISTORY_FOOTER, "utf8") + 4;
const SEED_ACK_TEXT =
  "\n\n# Historical context chunk (seed step)\n\n" +
  "Record the historical conversation context above for the upcoming user request in this session. " +
  "Do not execute tools or answer historical questions. Reply only with: OK";
const REQUEST_SEED_PREFIX =
  "\n\n# Current OMP user request (part; not yet actionable)\n\n";
const REQUEST_SEED_SUFFIX =
  "\n\n# End of request part\n\n" +
  "The text above is part of the current user request. Do not answer it, call tools, or act on it yet. " +
  "Reply only with: OK";
const REQUEST_FINAL_HEADER =
  "\n\n# Current OMP user request (final part)\n\n" +
  "The immediately preceding seed steps are parts of this same user request, not separate tasks; " +
  "earlier historical-context seed steps are reference only. Combine the request parts with the text below " +
  "and answer the complete request.\n\n";
const REQUEST_STEP_SAFETY_BYTES = 1_024;
const HISTORY_RECORD_CHUNK_BYTES = 80_000;

function checkStepTextBytes(bytes: number): void {
  if (bytes > ACP_STEP_TEXT_BYTES) {
    throw new Error(`Maximum context length exceeded: official Antigravity ACP single-step text needs at least ${bytes} bytes; safe budget is ${ACP_STEP_TEXT_BYTES} bytes. Compact the conversation with OMP /compact and retry. A larger contextWindow or maxTransferBytes does not raise this server limit. No history or current request was sent or silently truncated.`);
  }
}

function serializeRecord(record: unknown): string {
  let stringBytes = 0;
  // The replacer sees each value before JSON allocates its escaped string.
  // This lower bound aborts an oversized single message without copying its
  // full text; the exact rendered size (including JSON syntax) is checked below.
  const json = JSON.stringify(record, (_key, value) => {
    if (typeof value === "string") {
      stringBytes += Buffer.byteLength(value, "utf8");
      checkStepTextBytes(stringBytes);
    }
    return value;
  });
  checkStepTextBytes(Buffer.byteLength(json, "utf8") + HISTORY_ENVELOPE_BYTES);
  return json;
}

function makeHistoryText(recordJsons: string[]): string {
  if (!recordJsons.length) return "";
  const parts: string[] = [HISTORY_HEADER, "[", recordJsons[0]!];
  for (let i = 1; i < recordJsons.length; i++) parts.push(",", recordJsons[i]!);
  parts.push("]", HISTORY_FOOTER);
  return parts.join("");
}

function makeHistoryBlock(text: string): TransferBlock {
  return {
    type: "resource",
    resource: { uri: "urn:omp:antigravity-acp:history", mimeType: "text/plain", text },
  };
}

export function promptTextBytes(prompt: TransferBlock[]): number {
  let bytes = 0;
  for (const block of prompt) {
    if (block.type === "text") bytes += Buffer.byteLength(block.text ?? "", "utf8") + 2;
    else if (block.type === "resource" && block.resource) {
      bytes += Buffer.byteLength(`Embedded resource (${block.resource.uri}):\n`, "utf8") +
        Buffer.byteLength(block.resource.text, "utf8") + 2;
    }
  }
  return bytes;
}

const systemPromptCache = new WeakMap<object, { snapshot: unknown; prompt: string }>();

export function currentSystemInstructions(context: TransferContext): string {
  let systemCount = 0;
  let soleSystem: object | undefined;
  for (const message of context.messages) {
    if (message.role === "system") {
      systemCount++;
      soleSystem = systemCount === 1 ? (message as object) : undefined;
    }
  }
  let prompt: string;
  if (systemCount === 0) {
    prompt = context.systemPrompt || "";
  } else if (systemCount === 1 && soleSystem) {
    const cached = systemPromptCache.get(soleSystem);
    if (cached && valueMatches(soleSystem, cached.snapshot)) {
      prompt = cached.prompt;
    } else {
      prompt = getCurrentSystemPrompt(context.messages as never) || context.systemPrompt || "";
      const snap = valueSnapshot(soleSystem);
      if (isSupportedSnapshot(snap)) systemPromptCache.set(soleSystem, { snapshot: snap, prompt });
    }
  } else {
    prompt = getCurrentSystemPrompt(context.messages as never) || context.systemPrompt || "";
  }
  if (Buffer.byteLength(prompt, "utf8") > 134_217_728) throw new Error("OMP system instructions exceed the 128 MiB hard transfer ceiling; reduce them rather than truncating instructions");
  return prompt;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

function jsonStringCounts(value: string): { chars: number; bytes: number } {
  let chars = 2;
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) {
        chars += 2;
        bytes += 2;
      } else if (code < 0x20) {
        chars += 6;
        bytes += 6;
      } else {
        chars += 1;
        bytes += 1;
      }
    } else if (code < 0x800) {
      chars += 1;
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        chars += 2;
        bytes += 4;
        index++;
      } else {
        chars += 6;
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      chars += 6;
      bytes += 6;
    } else {
      chars += 1;
      bytes += 3;
    }
  }
  return { chars, bytes };
}

function jsonValueCounts(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  maskStepImages = false,
): { chars: number; bytes: number } | undefined {
  if (value === null) return { chars: 4, bytes: 4 };
  const type = typeof value;
  if (type === "boolean") return value ? { chars: 4, bytes: 4 } : { chars: 5, bytes: 5 };
  if (type === "number") {
    const s = Number.isFinite(value as number) ? String(value) : "null";
    return { chars: s.length, bytes: s.length };
  }
  if (type === "string") return jsonStringCounts(value as string);
  if (type !== "object") return undefined;
  const obj = value as object;
  if (depth > 24 || seen.has(obj)) return undefined;
  const isArray = Array.isArray(obj);
  const proto = Object.getPrototypeOf(obj);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return undefined;
  if ("toJSON" in obj && typeof (obj as { toJSON?: unknown }).toJSON === "function") return undefined;
  seen.add(obj);
  try {
    if (isArray) {
      const arr = obj as unknown[];
      if (arr.length === 0) return { chars: 2, bytes: 2 };
      let chars = 2;
      let bytes = 2;
      for (let i = 0; i < arr.length; i++) {
        if (i > 0) { chars += 1; bytes += 1; }
        let item = arr[i];
        if (maskStepImages && item && typeof item === "object" && "type" in item && (item as { type?: unknown }).type === "image") {
          item = { ...(item as Record<string, unknown>), data: "" };
        }
        if (item === undefined || typeof item === "function" || typeof item === "symbol") {
          chars += 4;
          bytes += 4;
        } else {
          const sub = jsonValueCounts(item, depth + 1, seen, false);
          if (!sub) return undefined;
          chars += sub.chars;
          bytes += sub.bytes;
        }
      }
      return { chars, bytes };
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) return { chars: 2, bytes: 2 };
    let chars = 2;
    let bytes = 2;
    let emitted = false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc || !("value" in desc)) return undefined;
      const prop = desc.value;
      if (prop === undefined || typeof prop === "function" || typeof prop === "symbol") continue;
      const sub = jsonValueCounts(prop, depth + 1, seen, false);
      if (!sub) return undefined;
      if (emitted) { chars += 1; bytes += 1; }
      const keyCounts = jsonStringCounts(key);
      chars += keyCounts.chars + 1 + sub.chars;
      bytes += keyCounts.bytes + 1 + sub.bytes;
      emitted = true;
    }
    return { chars, bytes };
  } finally {
    seen.delete(obj);
  }
}

function safeJsonCounts(value: unknown): { chars: number; bytes: number } {
  const measured = jsonValueCounts(value);
  if (measured) return measured;
  const raw = safeJson(value);
  return { chars: raw.length, bytes: Buffer.byteLength(raw, "utf8") };
}

function stepWireBytes(step: TransferBlock[]): number {
  const measured = jsonValueCounts(step, 0, new Set(), true);
  if (measured) return measured.bytes;
  const wireText = JSON.stringify(step, function(this: unknown, _key, value: unknown) {
    return this === step && value && typeof value === "object" && "type" in value && value.type === "image"
      ? { ...value, data: "" }
      : value;
  });
  return Buffer.byteLength(wireText, "utf8");
}

function estimateMessageTokens(content: string | TransferBlock[]): number {
  if (typeof content === "string") return estimateTransferTokens(content);
  let tokens = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") tokens += estimateTransferTokens(block.text ?? "");
    else if (block.type === "thinking") tokens += estimateTransferTokens((block as { thinking?: string }).thinking ?? "");
    else if (block.type === "toolCall") {
      const name = block.name ?? "";
      const args = safeJsonCounts(block.arguments);
      tokens += estimateTransferTokensByCounts(name.length + 1 + args.chars, Buffer.byteLength(name, "utf8") + 1 + args.bytes);
    } else if (block.type === "image") tokens += 1024;
  }
  return tokens;
}

const messageTokenCache = new WeakMap<object, { snapshot: unknown; tokens: number }>();

function worthCachingMessageTokens(content: TransferBlock[]): boolean {
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "toolCall") return true;
    if (typeof block.text === "string" && (chars += block.text.length) >= 1024) return true;
    if (typeof (block as { thinking?: unknown }).thinking === "string" && (chars += (block as { thinking: string }).thinking.length) >= 1024) return true;
  }
  return false;
}

// OMP needs an occupancy signal even when the ACP runtime only reports
// cumulative billable tokens. Estimate the whole OMP context (instructions,
// every retained message and the tool schemas) instead of reusing cacheRead,
// which grows with each turn and is not a context size.
export function estimateContextTokens(context: TransferContext): number {
  let tokens = estimateTransferTokens(currentSystemInstructions(context));
  for (const message of context.messages) {
    // currentSystemInstructions already counts the collapsed system message.
    if (message.role === "system") continue;
    if (typeof message.content === "string" || !worthCachingMessageTokens(message.content)) {
      tokens += estimateMessageTokens(message.content) + 4;
      continue;
    }
    const msgObj = message as object;
    const cached = messageTokenCache.get(msgObj);
    if (cached && valueMatches(message.content, cached.snapshot)) {
      tokens += cached.tokens;
      continue;
    }
    const computed = estimateMessageTokens(message.content) + 4;
    const snap = valueSnapshot(message.content);
    if (isSupportedSnapshot(snap)) messageTokenCache.set(msgObj, { snapshot: snap, tokens: computed });
    tokens += computed;
  }
  if (context.tools?.length) {
    let schemaChars = 0;
    let schemaBytes = 0;
    for (const tool of context.tools) {
      const desc = tool.description ?? "";
      const params = safeJsonCounts(tool.parameters);
      schemaChars += tool.name.length + 1 + desc.length + 1 + params.chars + 1;
      schemaBytes += Buffer.byteLength(tool.name, "utf8") + 1 + Buffer.byteLength(desc, "utf8") + 1 + params.bytes + 1;
    }
    tokens += estimateTransferTokensByCounts(schemaChars, schemaBytes);
  }
  return Math.max(1, Math.ceil(tokens));
}

const DATE_CWD_REMINDER = /^(?:<system-reminder>\s*)?Today: [^\n]*?Do not repeat this information in your reply\.(?:\s*<\/system-reminder>)?\s*$/gmu;
const SYSTEM_REMINDER_TAG = /<system-reminder>([\s\S]*?)<\/system-reminder>/gu;
const OMP_TOOL_NAMES_LINE = /^\s*OMP tool names: [^\n]*$/gmu;

function isVolatileReminder(body: string): boolean {
  const lines = body.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(line =>
    /^Today: .*$/u.test(line) || /^OMP tool names: .*$/u.test(line));
}

let lastStableRaw: string | undefined;
let lastStableNormalized: string | undefined;

export function stableSystemContent(text: string): string {
  if (text === lastStableRaw && lastStableNormalized !== undefined) return lastStableNormalized;
  const normalized = !text.includes("Today:") && !text.includes("<system-reminder>") && !text.includes("OMP tool names:") && !text.includes("\n\n\n")
    ? text.trim()
    : text
      .replace(DATE_CWD_REMINDER, "")
      .replace(SYSTEM_REMINDER_TAG, (match, body: string) => isVolatileReminder(body) ? "" : match)
      .replace(OMP_TOOL_NAMES_LINE, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  lastStableRaw = text;
  lastStableNormalized = normalized;
  return normalized;
}

// OMP injects a date/cwd reminder and dynamic tool lists around turns. Their
// metadata changes without changing policy, so they must not force a full ACP
// replay (and possible compaction) in the middle of an active session.
export function stableSystemInstructions(context: TransferContext): string {
  return stableSystemContent(currentSystemInstructions(context));
}

function stripSessionRoutingInstructions(instructions: string): string {
  return instructions
    .replace(TOOL_ROUTING.trim(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function historyBudget(_contextWindow = 32_768, env = process.env, configured = 16_777_216): number {
  const bytes = Number(env.OMP_ACP_HISTORY_BYTES ?? configured);
  if (!Number.isSafeInteger(bytes) || bytes < 65_536 || bytes > 134_217_728) {
    throw new Error("OMP_ACP_HISTORY_BYTES must be an integer between 65536 and 134217728");
  }
  return bytes;
}

// OMP /retry drops the generated answer from its branch and resends the same
// context. The warm ACP session already holds the request, so regeneration is
// requested explicitly instead of replaying history into a cold session.
function retryRequestText(content: string | TransferBlock[]): string {
  const restate = typeof content === "string" ? content.trim()
    : content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n\n").trim();
  return "\n\n# OMP retry request\n\n" +
    "The user discarded the previous response to the current user request. " +
    "Produce a completely new answer for it. Do not continue, quote or repeat the discarded response." +
    (restate ? `\n\n# Original request\n\n${restate}` : "");
}

function stepHistoryText(items: RecordItem[]): string {
  const localAttachments = new Map<number, number>();
  let nextAttachment = 0;
  for (const item of items) for (const attachment of item.imageAttachments) {
    localAttachments.set(attachment, nextAttachment++);
  }
  return makeHistoryText(items.map(item => {
    if (!item.images.length || typeof item.record.content === "string") return item.json;
    const content = item.record.content.map(block => block.type === "image" &&
      typeof block.attachment === "number" && localAttachments.has(block.attachment)
      ? { ...block, attachment: localAttachments.get(block.attachment)! }
      : block);
    return serializeRecord({ ...item.record, content });
  }));
}

function assembleStep(
  instructionsBlock: TransferBlock | undefined,
  items: RecordItem[],
  tailBlocks: TransferBlock[],
): TransferBlock[] {
  const step: TransferBlock[] = [];
  if (instructionsBlock) step.push(instructionsBlock);
  if (items.length) step.push(makeHistoryBlock(stepHistoryText(items)));
  for (const item of items) for (const image of item.images) step.push(image);
  for (const block of tailBlocks) step.push(block);
  return step;
}

function prepareHistoryMetrics(items: readonly RecordItem[]): HistoryMetrics {
  const jsonBytePrefix = [0];
  const imageTextBytePrefix = [0];
  const originalDigitBytePrefix = [0];
  const attachmentCountPrefix = [0];
  const localDigitBytePrefix = [0];
  let attachmentCount = 0;
  for (const item of items) {
    let originalDigits = 0;
    if (item.images.length && Array.isArray(item.record.content)) {
      for (const attachment of item.imageAttachments) {
        originalDigits += String(attachment).length;
        localDigitBytePrefix.push(localDigitBytePrefix.at(-1)! + String(attachmentCount).length);
        attachmentCount++;
      }
    }
    jsonBytePrefix.push(jsonBytePrefix.at(-1)! + Buffer.byteLength(item.json, "utf8"));
    imageTextBytePrefix.push(imageTextBytePrefix.at(-1)! + promptTextBytes(item.images));
    originalDigitBytePrefix.push(originalDigitBytePrefix.at(-1)! + originalDigits);
    attachmentCountPrefix.push(attachmentCount);
  }
  return { jsonBytePrefix, imageTextBytePrefix, originalDigitBytePrefix, attachmentCountPrefix, localDigitBytePrefix };
}

function historyRangeTextBytes(metrics: HistoryMetrics, start: number, end: number): number {
  if (start === end) return 0;
  const attachmentStart = metrics.attachmentCountPrefix[start]!;
  const attachmentEnd = metrics.attachmentCountPrefix[end]!;
  return HISTORY_ENVELOPE_BYTES
    + metrics.jsonBytePrefix[end]! - metrics.jsonBytePrefix[start]!
    + end - start - 1
    + metrics.imageTextBytePrefix[end]! - metrics.imageTextBytePrefix[start]!
    + metrics.localDigitBytePrefix[attachmentEnd - attachmentStart]!
    - (metrics.originalDigitBytePrefix[end]! - metrics.originalDigitBytePrefix[start]!);
}

function planHistorySteps(
  instructionsBlock: TransferBlock | undefined,
  items: readonly RecordItem[],
  tailBlocks: TransferBlock[],
): { prompt: TransferBlock[]; seedSteps: TransferBlock[][] } {
  const metrics = prepareHistoryMetrics(items);
  const instructionBytes = instructionsBlock ? promptTextBytes([instructionsBlock]) : 0;
  const tailBytes = promptTextBytes(tailBlocks);
  const seedTail: TransferBlock[] = [{ type: "text", text: SEED_ACK_TEXT }];
  const seedTailBytes = promptTextBytes(seedTail);
  const spans: { start: number; end: number }[] = [];
  let seedInstructions = instructionsBlock;
  let pendingInstructions = instructionsBlock;
  let finalInstructions: TransferBlock | undefined;
  if (instructionBytes + seedTailBytes > ACP_STEP_TEXT_BYTES) {
    finalInstructions = pendingInstructions;
    seedInstructions = undefined;
    pendingInstructions = undefined;
  }
  let cursor = 0;
  while (cursor < items.length || pendingInstructions) {
    const remainingInstructions = finalInstructions ?? pendingInstructions;
    const predictedRemainingBytes = (remainingInstructions ? instructionBytes : 0)
      + historyRangeTextBytes(metrics, cursor, items.length) + tailBytes;
    if (predictedRemainingBytes <= ACP_STEP_TEXT_BYTES) break;
    const start = cursor;
    const chunkInstructions = pendingInstructions;
    const chunkInstructionBytes = chunkInstructions ? instructionBytes : 0;
    while (cursor < items.length) {
      const predicted = chunkInstructionBytes
        + historyRangeTextBytes(metrics, start, cursor + 1) + seedTailBytes;
      if (predicted <= ACP_STEP_TEXT_BYTES) {
        cursor++;
        continue;
      }
      if (process.env.OMP_ACP_PLAN_VERIFY === "1") {
        const rejected = assembleStep(chunkInstructions, items.slice(start, cursor + 1), seedTail);
        const actual = promptTextBytes(rejected);
        if (actual !== predicted || actual <= ACP_STEP_TEXT_BYTES) {
          throw new Error(`History chunk planner predicted ${predicted} bytes for a rejected candidate but rendered ${actual}`);
        }
      }
      break;
    }
    if (!chunkInstructions && cursor === start) {
      checkStepTextBytes(promptTextBytes(assembleStep(undefined, [items[start]!], seedTail)));
      throw new Error("History chunk planner made no progress");
    }
    spans.push({ start, end: cursor });
    pendingInstructions = undefined;
  }
  const seedSteps = spans.map((span, index) => {
    const stepInstructions = index === 0 ? seedInstructions : undefined;
    const predicted = (stepInstructions ? instructionBytes : 0)
      + historyRangeTextBytes(metrics, span.start, span.end) + seedTailBytes;
    const step = assembleStep(stepInstructions, items.slice(span.start, span.end), seedTail);
    if (process.env.OMP_ACP_PLAN_VERIFY === "1") {
      const actual = promptTextBytes(step);
      if (actual !== predicted) throw new Error(`History chunk planner predicted ${predicted} bytes but rendered ${actual}`);
      checkStepTextBytes(actual);
    } else {
      checkStepTextBytes(predicted);
    }
    return step;
  });
  const effectiveFinalInstructions = finalInstructions ?? pendingInstructions;
  const prompt = assembleStep(effectiveFinalInstructions, items.slice(cursor), tailBlocks);
  if (process.env.OMP_ACP_PLAN_VERIFY === "1") {
    const actualPromptBytes = promptTextBytes(prompt);
    const predictedPromptBytes = (effectiveFinalInstructions ? instructionBytes : 0)
      + historyRangeTextBytes(metrics, cursor, items.length) + tailBytes;
    if (actualPromptBytes !== predictedPromptBytes) {
      throw new Error(`History chunk planner predicted ${predictedPromptBytes} bytes for the final prompt but rendered ${actualPromptBytes}`);
    }
    checkStepTextBytes(actualPromptBytes);
  } else {
    const predictedPromptBytes = (effectiveFinalInstructions ? instructionBytes : 0)
      + historyRangeTextBytes(metrics, cursor, items.length) + tailBytes;
    checkStepTextBytes(predictedPromptBytes);
  }
  return { prompt, seedSteps };
}

interface RequestSplit {
  seedSteps: TransferBlock[][];
  tailBlocks: TransferBlock[];
}

function requestFinalHeader(inProgress: boolean): string {
  return REQUEST_FINAL_HEADER + (inProgress
    ? "This request is already in progress; the history includes prior assistant actions and tool results. " +
      "Continue from those results rather than restarting completed work.\n\n"
    : "");
}

function takeTextChunkSpan(text: string, maxBytes: number, startOffset = 0): { end: number; bytes: number } {
  if (maxBytes <= 0 || startOffset >= text.length) return { end: startOffset, bytes: 0 };
  const remainingChars = text.length - startOffset;
  if (remainingChars * 3 <= maxBytes) {
    const tail = startOffset === 0 ? text : text.slice(startOffset);
    return { end: text.length, bytes: Buffer.byteLength(tail, "utf8") };
  }
  let bytes = 0;
  let end = startOffset;
  let lastNewlineEnd = -1;
  let lastNewlineBytes = 0;
  for (let index = startOffset; index < text.length;) {
    const codePoint = text.codePointAt(index)!;
    const units = codePoint > 0xffff ? 2 : 1;
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += units;
    index += units;
    if (codePoint === 0x0a) {
      lastNewlineEnd = end;
      lastNewlineBytes = bytes;
    }
  }
  if (end === startOffset) {
    const codePoint = text.codePointAt(startOffset)!;
    const units = codePoint > 0xffff ? 2 : 1;
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    return { end: startOffset + units, bytes: size };
  }
  if (end < text.length && lastNewlineEnd > startOffset + 1 && lastNewlineBytes >= maxBytes * 0.5) {
    return { end: lastNewlineEnd, bytes: lastNewlineBytes };
  }
  return { end, bytes };
}

function takeTextChunk(text: string, maxBytes: number): string {
  const span = takeTextChunkSpan(text, maxBytes, 0);
  return span.end === text.length ? text : text.slice(0, span.end);
}

function splitOversizedRequest(blocks: TransferBlock[], inProgress: boolean): RequestSplit {
  const seedPrefix: TransferBlock = { type: "text", text: REQUEST_SEED_PREFIX };
  const seedSuffix: TransferBlock = { type: "text", text: REQUEST_SEED_SUFFIX };
  const finalHeader: TransferBlock = { type: "text", text: requestFinalHeader(inProgress) };
  const seedOverhead = promptTextBytes([seedPrefix, seedSuffix]);
  const finalOverhead = promptTextBytes([finalHeader]);
  const seedCapacity = ACP_STEP_TEXT_BYTES - seedOverhead - REQUEST_STEP_SAFETY_BYTES;
  const finalCapacity = ACP_STEP_TEXT_BYTES - finalOverhead - REQUEST_STEP_SAFETY_BYTES;
  if (seedCapacity <= 0 || finalCapacity <= 1) {
    throw new Error("Maximum context length exceeded: ACP request framing leaves no room for a user message part");
  }
  // A seed step is intentionally smaller than the final step. This guarantees
  // that an oversized tail always becomes at least one seed plus a final part.
  const maxSeedContent = Math.min(seedCapacity, finalCapacity - 1);
  const parts: TransferBlock[][] = [];
  let current: TransferBlock[] = [];
  let currentBytes = 0;
  const flush = () => {
    if (!current.length) return;
    parts.push(current);
    current = [];
    currentBytes = 0;
  };
  const appendText = (source: TransferBlock, text: string) => {
    let offset = 0;
    const resource = source.type === "resource" && source.resource ? source.resource : undefined;
    const overhead = resource
      ? Buffer.byteLength(`Embedded resource (${resource.uri}):\n`, "utf8") + 2
      : 2;
    while (offset < text.length) {
      const capacity = maxSeedContent - currentBytes - overhead;
      if (capacity <= 0) {
        flush();
        continue;
      }
      const span = takeTextChunkSpan(text, capacity, offset);
      if (span.end <= offset) {
        flush();
        continue;
      }
      const chunk = offset === 0 && span.end === text.length ? text : text.slice(offset, span.end);
      current.push(resource
        ? { ...source, resource: { ...resource, text: chunk } }
        : { ...source, text: chunk });
      currentBytes += span.bytes + overhead;
      offset = span.end;
      if (offset < text.length) flush();
    }
  };
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text) appendText(block, block.text);
      else current.push(block);
    } else if (block.type === "resource" && block.resource) {
      if (block.resource.text) appendText(block, block.resource.text);
      else current.push(block);
    } else {
      current.push(block);
    }
  }
  flush();
  if (parts.length < 2) {
    // A non-text-only payload cannot be partitioned safely. Let the existing
    // hard guard report the exact size rather than silently dropping content.
    checkStepTextBytes(promptTextBytes([finalHeader, ...blocks]));
    return { seedSteps: [], tailBlocks: [finalHeader, ...blocks] };
  }
  const finalBlocks = parts.pop()!;
  const seedSteps = parts.map(part => [seedPrefix, ...part, seedSuffix]);
  const tailBlocks = [finalHeader, ...finalBlocks];
  for (const step of seedSteps) checkStepTextBytes(promptTextBytes(step));
  checkStepTextBytes(promptTextBytes(tailBlocks));
  return { seedSteps, tailBlocks };
}

function historyRecordItems(
  record: HistoryRecord,
  images: TransferBlock[],
  imageAttachments: number[],
): RecordItem[] {
  const make = (candidate: HistoryRecord, itemImages: TransferBlock[] = images,
    attachments: number[] = imageAttachments, json?: string): RecordItem => {
    const referenced = new Set<number>();
    let referenceCount = 0;
    if (Array.isArray(candidate.content)) for (const block of candidate.content) {
      if (block.type === "image" && typeof block.attachment === "number") {
        referenceCount++;
        referenced.add(block.attachment);
      }
    }
    if (itemImages.length !== attachments.length * 2 || referenceCount !== attachments.length || referenced.size !== attachments.length ||
      attachments.some(attachment => !Number.isSafeInteger(attachment) || attachment < 0 || !referenced.has(attachment))) {
      throw new Error("Historical image attachments do not match their content or data");
    }
    return { json: json ?? serializeRecord(candidate), images: itemImages, imageAttachments: attachments, record: candidate };
  };
  try {
    return [make(record)];
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("Maximum context length exceeded")) throw error;
    if (typeof record.content === "string") {
      // A single huge historical user message would otherwise make every
      // future cold replay fail. Split its text into bounded records; the
      // history envelope still marks every part as reference data.
      const chunks: RecordItem[] = [];
      const fullText = record.content;
      let offset = 0;
      while (offset < fullText.length) {
        let span = takeTextChunkSpan(fullText, HISTORY_RECORD_CHUNK_BYTES, offset);
        let chunk = offset === 0 && span.end === fullText.length ? fullText : fullText.slice(offset, span.end);
        let candidate: HistoryRecord;
        let json: string;
        for (;;) {
          candidate = { ...record, content: chunk };
          try {
            json = serializeRecord(candidate);
            break;
          } catch (splitError) {
            const splitMessage = splitError instanceof Error ? splitError.message : "";
            if (!splitMessage.includes("Maximum context length exceeded") || span.bytes <= 1) throw splitError;
            const limit = Math.max(1, Math.floor(span.bytes * 0.8));
            span = takeTextChunkSpan(fullText, limit, offset);
            chunk = fullText.slice(offset, span.end);
          }
        }
        chunks.push(make(candidate, [], [], json));
        offset = span.end;
      }
      return chunks;
    }
    if (Array.isArray(record.content)) {
      // Preserve images and other non-text blocks while splitting an oversized
      // text-bearing content array. Each part gets only its own image pairs.
      const pairs = new Map<number, TransferBlock[]>();
      for (let index = 0; index < imageAttachments.length; index++) {
        const pair = images.slice(index * 2, index * 2 + 2);
        if (pair.length === 2) pairs.set(imageAttachments[index]!, pair);
      }
      const parts: TransferBlock[][] = [];
      let current: TransferBlock[] = [];
      let currentBytes = 0;
      const flush = () => {
        if (!current.length) return;
        parts.push(current);
        current = [];
        currentBytes = 0;
      };
      for (const block of record.content) {
        if (block.type === "text") {
          const text = block.text ?? "";
          if (!text) {
            current.push(block);
            continue;
          }
          let offset = 0;
          while (offset < text.length) {
            const capacity = HISTORY_RECORD_CHUNK_BYTES - currentBytes;
            if (capacity <= 0) {
              flush();
              continue;
            }
            const span = takeTextChunkSpan(text, capacity, offset);
            if (span.end <= offset) {
              flush();
              continue;
            }
            const chunk = offset === 0 && span.end === text.length ? text : text.slice(offset, span.end);
            current.push({ ...block, text: chunk });
            currentBytes += span.bytes;
            offset = span.end;
            if (offset < text.length) flush();
          }
        } else {
          current.push(block);
        }
      }
      flush();
      const chunks: RecordItem[] = [];
      for (const part of parts) {
        const partImages: TransferBlock[] = [];
        const partAttachments: number[] = [];
        for (const block of part) {
          if (block.type !== "image" || typeof block.attachment !== "number") continue;
          const pair = pairs.get(block.attachment);
          if (!pair) throw new Error("Historical image attachment has no corresponding image data");
          partImages.push(...pair);
          partAttachments.push(block.attachment);
        }
        const candidate = { ...record, content: part };
        chunks.push(make(candidate, partImages, partAttachments));
      }
      return chunks;
    }
    throw error;
  }
}

export function buildPromptParts(context: TransferContext, fresh: boolean, unseenStart?: number,
  limits: { contextWindow?: number; maxTokens?: number; policy?: ContextOptions; sessionRouting?: boolean } = {}, retryResend = false): PromptParts {
  // The runtime hot path always passes a fully resolved ompContextPolicy
  // (see scripts/build.mjs); re-resolution is only needed for partial input.
  const policy = limits.policy;
  const options: ResolvedContextOptions = policy &&
      typeof policy.inputTokenBudget === "number" && typeof policy.maxTransferBytes === "number" && typeof policy.maxImageBytes === "number"
    ? policy
    : resolveContextOptions({ id: "transfer", contextWindow: limits.contextWindow ?? 32_768, maxTokens: limits.maxTokens ?? 8192 },
      { defaults: limits.policy ?? {}, models: {} });
  const messages = context.messages;
  let latest = messages.length - 1;
  while (latest >= 0 && messages[latest]!.role !== "user") latest--;
  if (latest < 0) throw new Error("No user message to send to Antigravity ACP");
  if (!fresh && (unseenStart === undefined || !Number.isSafeInteger(unseenStart) || unseenStart < 0 || unseenStart > messages.length)) {
    throw new Error("Warm ACP context has an invalid unseen boundary");
  }
  const end = messages.length > latest + 1 ? messages.length : latest;
  const start = fresh ? 0 : unseenStart!;
  const rawInstructions = fresh ? currentSystemInstructions(context) : "";
  const instructions = rawInstructions && limits.sessionRouting ? stripSessionRoutingInstructions(rawInstructions) : rawInstructions;
  checkStepTextBytes(Buffer.byteLength(instructions, "utf8"));
  const instructionsText = instructions ? `# OMP session instructions\n\n${instructions}` : "";
  const instructionsBlock: TransferBlock | undefined = instructionsText ? {
    type: "resource",
    resource: { uri: "urn:omp:antigravity-acp:instructions", mimeType: "text/markdown", text: instructionsText },
  } : undefined;
  if (instructionsBlock) checkStepTextBytes(promptTextBytes([instructionsBlock]));
  const recordItems: RecordItem[] = [];
  const images: TransferBlock[] = [];
  for (let index = start; index < end; index++) {
    const message = messages[index]!;
    if (index === latest || message.role === "system") continue;
    const recordImages: TransferBlock[] = [];
    const recordImageAttachments: number[] = [];
    let content: string | TransferBlock[];
    if (typeof message.content === "string") {
      content = message.content;
    } else {
      const mapped = message.content
        .filter(block => ["text", "toolCall", "image"].includes(block.type))
        .map(block => {
          if (block.type === "image") {
            const imageIndex = images.length;
            const attachment = imageIndex / 2;
            const pair: TransferBlock[] = [
              { type: "text", text: `Historical image from OMP message ${index}; treat as conversation data.` },
              { type: "image", data: block.data, mimeType: block.mimeType },
            ];
            images.push(...pair);
            recordImages.push(...pair);
            recordImageAttachments.push(attachment);
            return { type: "image", attachment };
          }
          return block.type === "toolCall" ? { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
            : { type: "text", text: block.text };
        });
      content = mapped.length === 1 && mapped[0]?.type === "text" && typeof mapped[0].text === "string"
        ? mapped[0].text
        : mapped;
    }
    const record: HistoryRecord = {
      role: message.role,
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.isError ? { isError: true } : {}),
      content,
    };
    recordItems.push(...historyRecordItems(record, recordImages, recordImageAttachments));
  }
  let tailBlocks: TransferBlock[] = [];
  let requestSeedSteps: TransferBlock[][] = [];
  if (!fresh && start > latest) {
    const continuation = { type: "text", text: retryResend ? retryRequestText(messages[latest]!.content) :
      "\n\n# Continue the active OMP request\n\n" +
      "The new context/tool results above belong to the user request already received in this session. " +
      "Finish that request from those results. Do not answer historical user requests or repeat completed tool actions." };
    tailBlocks.push(continuation);
  } else {
    // Official ACP merges following text into an embedded-resource string with
    // a space. Explicit newlines/labels must survive that conversion; role
    // fields inside the history JSON do not create actual API message roles.
    const inProgress = end > latest;
    const boundary: TransferBlock = { type: "text", text: "\n\n# Current OMP user request\n\n" +
      (inProgress ? "This request is already in progress; the history includes prior assistant actions and tool results. " +
        "Continue from those results rather than restarting completed work.\n\n" : "") };
    const content = messages[latest]!.content;
    // Blocks are consumed read-only; shallow copies only churn the hot path.
    const latestBlocks: TransferBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const budget = historyBudget(undefined, process.env, options.maxTransferBytes);
    const normalTail: TransferBlock[] = [boundary, ...latestBlocks];
    if (promptTextBytes(normalTail) > ACP_STEP_TEXT_BYTES) {
      let rawTextBytes = 0;
      let earlyImageBytes = 0;
      for (const block of images) {
        if (block.type === "image") earlyImageBytes += Math.ceil((block.data?.length ?? 0) * 3 / 4);
      }
      for (const block of latestBlocks) {
        if (block.type === "text" && block.text) rawTextBytes += Buffer.byteLength(block.text, "utf8");
        else if (block.type === "resource" && block.resource?.text) rawTextBytes += Buffer.byteLength(block.resource.text, "utf8");
        else if (block.type === "image") earlyImageBytes += Math.ceil((block.data?.length ?? 0) * 3 / 4);
      }
      if (earlyImageBytes > options.maxImageBytes) {
        throw new Error(`Request payload too large (413): local ACP image budget is ${options.maxImageBytes} bytes; reduce attachments. No images were silently omitted.`);
      }
      if (rawTextBytes > budget) {
        throw new Error(`Request payload too large (413): local ACP transfer needs at least ${rawTextBytes} bytes; budget is ${budget}. Use OMP /compact or raise maxTransferBytes. No history was silently truncated.`);
      }
      const split = splitOversizedRequest(latestBlocks, inProgress);
      requestSeedSteps = split.seedSteps;
      tailBlocks = split.tailBlocks;
    } else {
      tailBlocks = normalTail;
    }
  }
  // Reject oversized latest text before allocating its JSON wire copy too.
  checkStepTextBytes(promptTextBytes(tailBlocks));

  let prompt = assembleStep(instructionsBlock, recordItems, tailBlocks);
  const historySeedSteps: TransferBlock[][] = [];
  if (promptTextBytes(prompt) > ACP_STEP_TEXT_BYTES) {
    const planned = planHistorySteps(instructionsBlock, recordItems, tailBlocks);
    prompt = planned.prompt;
    historySeedSteps.push(...planned.seedSteps);
  }
  const seedSteps = historySeedSteps.length || requestSeedSteps.length
    ? [...historySeedSteps, ...requestSeedSteps]
    : undefined;

  // Image base64 size is not a text-token estimate. Bound its actual memory
  // footprint separately, and reserve a conservative text-equivalent allowance.
  let imageBytes = 0;
  let imageWireChars = 0;
  for (const group of [images, ...requestSeedSteps, tailBlocks]) for (const block of group) {
    if (block.type !== "image") continue;
    const dataLen = block.data?.length ?? 0;
    imageBytes += Math.ceil(dataLen * 3 / 4);
    imageWireChars += dataLen;
  }
  if (imageBytes > options.maxImageBytes) throw new Error(`Request payload too large (413): local ACP image budget is ${options.maxImageBytes} bytes; reduce attachments. No images were silently omitted.`);
  // Embedded history is JSON inside a resource string: its quotes and slashes
  // are escaped again on the wire. Count actual envelopes/escaping without
  // copying potentially large base64 data (ASCII with no JSON escaping).
  const allSteps = seedSteps?.length ? [...seedSteps, prompt] : [prompt];
  let bytes = imageWireChars;
  let estimatedTokens = 0;
  for (const step of allSteps) {
    let textChars = 0;
    let textBytes = 0;
    let stepImages = 0;
    for (const block of step) {
      if (block.type === "text") {
        const text = block.text ?? "";
        textChars += text.length;
        textBytes += Buffer.byteLength(text, "utf8");
      } else if (block.type === "resource" && block.resource) {
        textChars += block.resource.text.length;
        textBytes += Buffer.byteLength(block.resource.text, "utf8");
      } else if (block.type === "image") stepImages++;
    }
    if (textBytes > 32_768) {
      bytes += stepWireBytes(step);
    } else {
      const wireText = JSON.stringify(step, function(this: unknown, _key, value: unknown) {
        return this === step && value && typeof value === "object" && "type" in value && value.type === "image"
          ? { ...value, data: "" }
          : value;
      });
      bytes += Buffer.byteLength(wireText, "utf8");
    }
    estimatedTokens += estimateTransferTokensByCounts(textChars, textBytes, stepImages);
  }
  const budget = historyBudget(undefined, process.env, options.maxTransferBytes);
  if (bytes > budget) throw new Error(`Request payload too large (413): local ACP transfer needs ${bytes} bytes; budget is ${budget}. Use OMP /compact or raise maxTransferBytes. No history was silently truncated.`);
  if (estimatedTokens > options.inputTokenBudget) throw new Error(`Maximum context length exceeded: local ACP estimate is ${estimatedTokens} tokens; input budget is ${options.inputTokenBudget}. Use OMP /compact. This is a heuristic estimate, not a server token count. No history was silently truncated.`);
  const estimatedContextTokens = estimateContextTokens(context);
  return seedSteps?.length ? { prompt, seedSteps, messageCount: messages.length, estimatedContextTokens } : { prompt, messageCount: messages.length, estimatedContextTokens };
}
