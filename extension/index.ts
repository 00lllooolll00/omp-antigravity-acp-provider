// OMP 18.x adapter for vendored pi-antigravity-acp-provider 0.1.15 (Pi 1.1 API).
// Upstream source is vendored under ./vendor/pi-antigravity-acp-provider; keep it intact and translate only the provider registration contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyApiCostEstimate } from "./pricing.ts";
import { ensureLoopbackBypass } from "./proxy-env.ts";
import {
  assertSelectedAcpCliLaunch,
  preferNewestAcpRuntime,
  prepareManagedAcpForQuota,
  resolveAcpPermissionProfile,
  type AcpRuntimePreference,
} from "./acp-runtime-source.ts";
import { SessionRuntimePool } from "./runtime-pool.ts";
import { createStructuredFingerprintMemo } from "./structured-fingerprint.ts";
import { Diagnostics, instrumentRuntime } from "./diagnostics.ts";
import { stableTools } from "./tool-order.ts";
import { toolDeclarations, normalizeOmpSystemDeltas, type OmpToolDeclaration } from "./omp-context.ts";
import { OmpSessionLifecycle, type OmpProviderSessionState } from "./omp-session-lifecycle.ts";
import { DEFAULT_USAGE_MODE, loadContextSettings } from "./context-settings.ts";
import { PARTNER_FALLBACK_MODELS, projectCatalog, selectRuntimeModel, type PublicCatalogModel } from "./model-catalog.ts";
import { loadAdapterConfig, resolveAdapterPermissionMode, type AdapterPermissionMode } from "./adapter-config.ts";
import { ownerRoutingId, sessionOwnerId } from "./routing.ts";
import { TOOL_ROUTING } from "./tool-routing.ts";
import { TranscriptRouting, type RoutingAttempt } from "./transcript-routing.ts";
import { sourceId } from "./omp-session-source.ts";
import { loadToolPolicy } from "./tool-policy.ts";
import {
  MARKER,
  OmpAuthCoordinator,
  authReady,
  keychain,
  logoutFollow,
  resolveAntigravityAccountEmail,
  secretService,
  type OmpCommandContext,
} from "./auth-sync.ts";
import { CatalogStore } from "./catalog-store.ts";
import { createAntigravityUsageProvider } from "./usage-report.ts";
import { createAntigravityArgumentCompletions, createAntigravityCommandHandler, type AntigravityCompletionItem, type RuntimeBundleView, type ToolAuditSummary } from "./commands.ts";
import type { ConfiguredCatalogModel } from "./catalog-store.ts";
import { formatCompactionNotice } from "./acp-compaction.ts";
import { classifyAcpFailure } from "./acp-errors.ts";
import {
  AcpSessionStore,
  AntigravityRuntime,
  clearAntigravityCredentials,
  FALLBACK_MODELS,
  PERMISSION_RESULT_KIND,
  PERMISSION_TOOL_NAME,
  PiEventWriter,
  SessionCleanup,
  TierConnection,
  Type,
  createAntigravityProvider,
  ensureAntigravityAcpReady,
  planToolProjection,
} from "./runtime.mjs";

export { keychain, logoutFollow, secretService };

interface OmpHostApi {
  on: (name: string, handler: (event: unknown, ctx: OmpCommandContext) => unknown) => void;
  registerProvider: (name: string, config: unknown) => void;
  unregisterProvider?: (name: string) => void;
  registerTool: (tool: unknown) => void;
  registerCommand: (name: string, command: {
    description: string;
    handler: (args: string, ctx: OmpCommandContext) => Promise<void>;
    // OMP's autocomplete calls this with the text after "/<name> " and renders
    // the returned items; optional so older hosts simply skip completion.
    getArgumentCompletions?: (args: string) => AntigravityCompletionItem[] | null | Promise<AntigravityCompletionItem[] | null>;
  }) => void;
}

export function resolveAdapterStateDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  // OMP sets this to the active named profile's agent directory during CLI
  // bootstrap; it also honors an explicit default-profile override.
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured ? configured === "~" ? home : configured.startsWith("~/") ? path.join(home, configured.slice(2)) : path.resolve(configured)
    : path.join(home, env.PI_CONFIG_DIR || ".omp", "agent");
  return path.join(agentDir, "antigravity-acp-provider");
}

// Offline catalog used before the first ACP discovery. Keep the newest
// families here so a fresh install or an auth gap still exposes them.
export function offlineFallbackModels(): PublicCatalogModel[] {
  return [
    ...(FALLBACK_MODELS as PublicCatalogModel[]),
    ...projectCatalog([
      { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (low)" },
      { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (medium)" },
      { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (high)" },
      { modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (low)" },
      { modelId: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (medium)" },
      { modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (high)" },
      { modelId: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (xhigh)" },
    ]),
    ...PARTNER_FALLBACK_MODELS,
  ];
}

export default async function (pi: OmpHostApi) {
  return registerOmpAdapter(pi, resolveAdapterStateDir());
}

// Explicit state injection keeps command integration tests away from user data.
export interface OmpAdapterOptions {
  standbyWarmup?: boolean;
  prepareRuntime?: () => Promise<void>;
  authReady?: () => Promise<boolean>;
}

export async function registerOmpAdapter(
  pi: OmpHostApi,
  stateDir: string,
  createConnection?: (options: ConstructorParameters<typeof TierConnection>[0]) => TierConnection,
  adapterOptions?: OmpAdapterOptions,
) {
  const standbyWarmupEnabled = (adapterOptions?.standbyWarmup ?? createConnection === undefined)
    && process.env.OMP_ACP_WARMUP !== "off";
  const makeConnection = createConnection ?? ((options: ConstructorParameters<typeof TierConnection>[0]): TierConnection => new TierConnection(options));
  const configPath = path.join(stateDir, "config.json");
  const cachePath = path.join(stateDir, "models-cache.json");
  const toolPolicyPath = path.join(stateDir, "omp-tools.json");
  const contextPath = path.join(stateDir, "context.json");
  let contextSettings = loadContextSettings(contextPath);
  let toolPolicy = loadToolPolicy(toolPolicyPath);
  let permissionPreference: AdapterPermissionMode = loadAdapterConfig(configPath).permissions;
  const ompAgentDir = path.dirname(stateDir);
  const effectivePermissionMode = () => resolveAdapterPermissionMode(permissionPreference, ompAgentDir);
  const sessionStorePath = path.join(stateDir, "sessions.json");
  const sessionStore = new AcpSessionStore(sessionStorePath);
  const cleanup = new SessionCleanup(stateDir);
  const diagnostics = new Diagnostics(path.join(stateDir, "diagnostics.json"));
  // Count saved records from disk so /antigravity-acp account needs no runtime.
  let savedSessionCache: { stamp: string; count: number } | undefined;
  const savedSessionCount = (): number => {
    let stamp: string | undefined;
    try {
      const stat = fs.statSync(sessionStorePath);
      stamp = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    } catch { /* Missing or unreadable store: fall through to a fresh read. */ }
    if (stamp !== undefined && savedSessionCache?.stamp === stamp) return savedSessionCache.count;
    let count = 0;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(sessionStorePath, "utf8"));
      if (Array.isArray(parsed)) for (const record of parsed) {
        if (record && typeof record === "object" && "piSessionId" in record && typeof record.piSessionId === "string") count++;
      }
    } catch { return 0; }
    if (stamp !== undefined) savedSessionCache = { stamp, count };
    return count;
  };

  // Loading this global extension must not start ACP or query Google.
  let readiness: Promise<void> | undefined;
  let runtimePreference: Promise<AcpRuntimePreference | undefined> | undefined;
  let selectedRuntimePreference: AcpRuntimePreference | undefined;
  const currentPermissionProfile = () => resolveAcpPermissionProfile(selectedRuntimePreference, effectivePermissionMode());
  const currentRuntimeKey = () => `${selectedRuntimePreference?.source ?? ""}:${selectedRuntimePreference?.cliPath ?? ""}`;
  const checkAuthReady = adapterOptions?.authReady ?? authReady;
  function prepareRuntime() {
    if (adapterOptions?.prepareRuntime) {
      readiness ??= adapterOptions.prepareRuntime().catch((error: unknown) => {
        readiness = undefined;
        throw error;
      });
      return readiness;
    }
    runtimePreference ??= preferNewestAcpRuntime(stateDir).then(preference => {
      selectedRuntimePreference = preference;
      return preference;
    }).catch(() => undefined);
    readiness ??= runtimePreference.then(() => ensureAntigravityAcpReady()).catch((error: unknown) => {
      readiness = undefined;
      throw error;
    });
    return readiness;
  }

  let managedQuotaReadiness: Promise<void> | undefined;
  async function prepareManagedRuntimeForQuota(): Promise<void> {
    await prepareRuntime();
    if (createConnection !== undefined) return;
    managedQuotaReadiness ??= prepareManagedAcpForQuota(stateDir, () => ensureAntigravityAcpReady())
      .then(() => undefined)
      .catch((error: unknown) => {
        managedQuotaReadiness = undefined;
        throw error;
      });
    await managedQuotaReadiness;
  }

  function abortError(): Error {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
  }

  async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw abortError();
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        value => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        error => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  let quotaRuntime: AntigravityRuntime | undefined;

  async function fetchQuotaSnapshot(signal?: AbortSignal) {
    await awaitWithAbort(prepareManagedRuntimeForQuota(), signal);
    const runtime = (quotaRuntime ??= new AntigravityRuntime((options: ConstructorParameters<typeof TierConnection>[0]) => {
      const connection = spawnConnection({
        ...options,
        ompPurpose: "quota",
        ompCleanup: cleanup,
        ompDiagnostics: diagnostics,
      });
      connections.add(connection);
      void connection.process.exited.finally(() => { connections.delete(connection); });
      return connection;
    }, currentPermissionProfile().wireMode, sessionStore));
    return await runtime.quota(undefined, signal);
  }

  // Inference and model discovery must not let the ACP server open an
  // interactive Google consent flow at session/new. A missing local login is a
  // user action, not a reason to leave the submitted message pending.
  async function requireAcpAuth(): Promise<void> {
    if (await checkAuthReady()) return;
    throw new Error("Antigravity ACP is not signed in. Run /login (or /antigravity-acp login) before sending a message.");
  }

  const connections = new Set<TierConnection>();
  interface StandbyConnection {
    connection: TierConnection;
    cwd: string;
    autoApproveProcess: boolean;
    nativeTools: typeof toolPolicy.nativeTools;
    runtimeKey: string;
    controller: AbortController;
    consumed: boolean;
    idleTimer?: NodeJS.Timeout;
  }
  const standbyTtlRaw = process.env.OMP_ACP_STANDBY_TTL_MS;
  const standbyTtlMs = standbyTtlRaw === undefined ? 300_000 : Number(standbyTtlRaw);
  let shuttingDown = false;
  let standby: StandbyConnection | undefined;
  let warmupInFlight: Promise<void> | undefined;
  let warmupController: AbortController | undefined;
  let warmupGeneration = 0;

  async function closeStandby(): Promise<void> {
    warmupGeneration++;
    warmupController?.abort();
    const current = standby;
    standby = undefined;
    if (current && !current.consumed) {
      clearTimeout(current.idleTimer);
      current.idleTimer = undefined;
      current.controller.abort();
      await current.connection.close().catch(() => {});
    }
    await warmupInFlight?.catch(() => {});
  }

  // Only warm up when the active session actually uses antigravity-acp and has
  // valid local auth, so non-Antigravity OMP sessions pay zero process cost.
  function scheduleWarmup(modelProvider?: string): void {
    if (!standbyWarmupEnabled || shuttingDown || modelProvider !== "antigravity-acp" || standby || warmupInFlight) return;
    if (connections.size > 0) return;
    const generation = warmupGeneration;
    const controller = new AbortController();
    warmupController = controller;
    let warmupConnection: TierConnection | undefined;
    let published = false;
    warmupInFlight = (async () => {
      try {
        if (!(await checkAuthReady()) || shuttingDown || controller.signal.aborted || generation !== warmupGeneration) return;
        await diagnostics.measure("runtime.prepare", prepareRuntime);
        if (shuttingDown || controller.signal.aborted || generation !== warmupGeneration || standby) return;
        const cwd = process.cwd();
        const profile = currentPermissionProfile();
        const nativeTools = toolPolicy.nativeTools;
        const runtimeKey = currentRuntimeKey();
        const connection = spawnConnection({
          cwd,
          ompNativeTools: nativeTools,
          ompDebugToolUpdates: toolPolicy.debugToolUpdates,
          ompUsageMode: contextSettings.defaults.usageMode ?? DEFAULT_USAGE_MODE,
          ompCleanup: cleanup,
          ompDiagnostics: diagnostics,
        });
        warmupConnection = connection;
        await diagnostics.measure("warmup.initialize", () => connection.initialize(controller.signal));
        if (
          shuttingDown
          || controller.signal.aborted
          || generation !== warmupGeneration
          || standby
          || !connection.process.alive
          || cwd !== process.cwd()
          || nativeTools !== toolPolicy.nativeTools
          || profile.autoApproveProcess !== currentPermissionProfile().autoApproveProcess
          || runtimeKey !== currentRuntimeKey()
        ) {
          return;
        }
        const entry: StandbyConnection = {
          connection,
          cwd,
          autoApproveProcess: profile.autoApproveProcess,
          nativeTools,
          runtimeKey,
          controller,
          consumed: false,
        };
        standby = entry;
        published = true;
        if (Number.isSafeInteger(standbyTtlMs) && standbyTtlMs > 0) {
          entry.idleTimer = setTimeout(() => {
            if (standby === entry && !entry.consumed) void closeStandby();
          }, standbyTtlMs);
          entry.idleTimer.unref();
        }
        void connection.process.exited.finally(() => {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = undefined;
          if (standby === entry && !entry.consumed) standby = undefined;
        });
      } catch {
        diagnostics.record("warmup.error", 0);
        // Warmup is strictly advisory; cold-start fallback runs on first prompt.
      } finally {
        if (!published && warmupConnection) {
          await warmupConnection.close().catch(() => {});
        }
        if (warmupController === controller) warmupController = undefined;
      }
    })().finally(() => { warmupInFlight = undefined; });
  }

  const idleTimeoutMs = Number(process.env.OMP_ACP_IDLE_TIMEOUT_MS ?? 900_000);
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0 || idleTimeoutMs > 2_147_483_647 || (idleTimeoutMs > 0 && idleTimeoutMs < 1000)) {
    throw new Error("OMP_ACP_IDLE_TIMEOUT_MS must be 0 (disabled) or an integer between 1000 and 2147483647");
  }
  const maxIdleEntries = Number(process.env.OMP_ACP_MAX_IDLE_RUNTIMES ?? 1);
  if (!Number.isSafeInteger(maxIdleEntries) || maxIdleEntries < 0) throw new Error("OMP_ACP_MAX_IDLE_RUNTIMES must be a nonnegative integer (0 disables the cap)");
  const toolProjectionMemo = createStructuredFingerprintMemo();
  let toolRevision = 0;

  let lastToolAudit: ToolAuditSummary | undefined;
  let cachedToolProjection: {
    revision: string;
    tools: OmpToolDeclaration[];
    availableNames: string;
    audit: ToolAuditSummary;
  } | undefined;

  function hasCustomLaunchOverrides(options: ConstructorParameters<typeof TierConnection>[0]): boolean {
    return options.command !== undefined
      || options.entryPath !== undefined
      || options.args !== undefined
      || options.env !== undefined
      || options.credentialStorage !== undefined
      || options.initializeTimeoutMs !== undefined
      || options.operationTimeoutMs !== undefined
      || options.promptIdleTimeoutMs !== undefined
      || options.promptWorkIdleTimeoutMs !== undefined
      || options.maxFrameBytes !== undefined
      || options.ompSteerMode !== undefined
      || options.ompSteerTimings !== undefined
      || options.ompAcpDirectory !== undefined;
  }

  function spawnConnection(options: ConstructorParameters<typeof TierConnection>[0]): TierConnection {
    const profile = currentPermissionProfile();
    if (standbyWarmupEnabled && !shuttingDown && options.ompPurpose !== "quota" && options.handlers !== undefined) {
      if (standby && !standby.consumed) {
        if (!hasCustomLaunchOverrides(options)
          && standby.cwd === options.cwd
          && standby.autoApproveProcess === profile.autoApproveProcess
          && standby.nativeTools === options.ompNativeTools
          && standby.runtimeKey === currentRuntimeKey()
          && standby.connection.process.alive) {
          const entry = standby;
          standby = undefined;
          entry.consumed = true;
          clearTimeout(entry.idleTimer);
          entry.idleTimer = undefined;
          entry.connection.configureUsage(options.ompUsageMode ?? DEFAULT_USAGE_MODE);
          entry.connection.rebindHandlers(options.handlers);
          diagnostics.record("warmup.hit", 0);
          return entry.connection;
        }
        diagnostics.record("warmup.evict", 0);
        void closeStandby();
      } else {
        diagnostics.record("warmup.miss", 0);
        if (warmupInFlight) void closeStandby();
      }
    }
    const env = ensureLoopbackBypass({
      ...process.env,
      ...options.env,
      OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS: profile.autoApproveProcess ? "1" : "",
    });
    const launch = options.command || options.entryPath ? undefined
      : assertSelectedAcpCliLaunch(stateDir, selectedRuntimePreference, env, options.ompPurpose === "quota" ? "quota" : "inference");
    return makeConnection({ ...options, ...launch, env });
  }

  const lifecycle = new OmpSessionLifecycle(
    id => runtimes.close(ownerRoutingId(id)),
    async id => { if (id) await cleanup.releaseSession(id); },
    ownerRoutingId,
    async (ownerId, sessionId) => { await runtimes.peek(ownerId)?.runtime.closeSessionBinding?.(sessionId); },
  );
  const runtimes = new SessionRuntimePool<RuntimeBundleView>(() => {
    const ownedConnections = new Set<TierConnection>();
    const runtime = new AntigravityRuntime((options: ConstructorParameters<typeof TierConnection>[0]) => {
      const connection = spawnConnection({
        ...options,
        ompNativeTools: toolPolicy.nativeTools,
        ompDebugToolUpdates: toolPolicy.debugToolUpdates,
        ompUsageMode: contextSettings.defaults.usageMode ?? DEFAULT_USAGE_MODE,
        ompCleanup: cleanup,
        ompDiagnostics: diagnostics,
      });
      connections.add(connection);
      ownedConnections.add(connection);
      void connection.process.exited.finally(() => {
        connections.delete(connection);
        ownedConnections.delete(connection);
      });
      return connection;
    }, currentPermissionProfile().wireMode, sessionStore);
    instrumentRuntime(runtime, diagnostics);
    return {
      runtime,
      provider: createAntigravityProvider(runtime).provider,
      isBusy: () => {
        for (const connection of ownedConnections) if (connection.activePrompts > 0) return true;
        return false;
      },
    };
  }, (bundle, id) => lifecycle.disposeRuntime(id, bundle, () => bundle.runtime.close()),
  { timeoutMs: idleTimeoutMs, maxIdleEntries, canDispose: bundle => !bundle.isBusy() });

  async function closePool() {
    await closeStandby();
    const activeQuota = quotaRuntime;
    quotaRuntime = undefined;
    await Promise.allSettled([
      lifecycle.closeAll(),
      runtimes.closeAll(),
      activeQuota ? activeQuota.close() : Promise.resolve(),
    ]);
    cachedToolProjection = undefined;
    toolProjectionMemo.clear();
  }

  const routing = new TranscriptRouting();
  const sessionIdOf = (ctx: OmpCommandContext | undefined): string | undefined => ctx?.sessionManager?.getSessionId?.();
  pi.on("session_shutdown", async (_event: unknown, ctx: OmpCommandContext) => {
    shuttingDown = true;
    auth.releaseContext(ctx);
    const failures: unknown[] = [];
    const sessionId = sessionIdOf(ctx);
    if (sessionId) {
      const routingId = routing.forget(sessionId, ctx?.sessionManager?.getSessionFile?.());
      const closing = [closeStandby(), lifecycle.closeSession(sessionId)];
      if (routingId !== sessionId) closing.push(lifecycle.closeSession(routingId));
      const results = await Promise.allSettled([...closing, lifecycle.waitClosing(), runtimes.closeIdle()]);
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    } else {
      await closePool();
    }
    await sessionStore.flush().catch(error => { failures.push(error); });
    const poolEmpty = !runtimes.hasEntries();
    if (poolEmpty) {
      cachedToolProjection = undefined;
      toolProjectionMemo.clear();
    }
    await Promise.allSettled([
      cleanup.flushStoreNotes(),
      poolEmpty ? cleanup.stop() : Promise.resolve(),
    ]).then(results => {
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    });
    if (failures.length) throw failures[0];
  });

  function syncProviderRegistration() {
    // Re-registering without an apiKey does not clear OMP's stored key
    // config; unregister first so a logout report finds no remaining
    // "provider config (fallback)" source.
    try { pi.unregisterProvider?.("antigravity-acp"); } catch { /* older hosts */ }
    try { adapted.registerProvider(); } catch { /* advisory */ }
  }

  const auth = new OmpAuthCoordinator({
    pi,
    stateDir,
    connections,
    isPoolBusy: () => runtimes.values().some(bundle => bundle.isBusy()),
    logoutAllRuntimes: async () => {
      await closeStandby();
      await Promise.all([
        ...runtimes.values().map(bundle => bundle.runtime.logout()),
        ...(quotaRuntime ? [quotaRuntime.logout()] : []),
      ]);
      // Finish the Antigravity-side cleanup even when the pool is empty,
      // instead of instantiating a runtime just to log it out.
      await sessionStore.clear();
      clearAntigravityCredentials();
    },
    closeAllRuntimes: closePool,
    onSyncProvider: syncProviderRegistration,
  });

  const trackOmpSource = async (_event: unknown, ctx: OmpCommandContext) => {
    const transcriptId = ctx.sessionManager?.getSessionId?.(), file = ctx.sessionManager?.getSessionFile?.();
    if (!transcriptId || !file || transcriptId.includes(":side:")) return;
    const id = routing.take(transcriptId, file);
    try { await cleanup.trackSource(id, file); } catch { /* Unproven or not-yet-persisted sources remain protected. */ }
  };

  const notifyAcpCompactions = (ctx: OmpCommandContext) => {
    for (const connection of connections) {
      for (const notice of connection.takeCompactionNotices?.() ?? []) {
        try { ctx.ui.notify(formatCompactionNotice(notice), notice.status === "failed" ? "warning" : "info"); }
        catch { /* A notification failure must not affect inference. */ }
      }
    }
  };
  const activeModelProvider = (event: unknown, ctx: OmpCommandContext | undefined): string | undefined => {
    const fromEvent = event && typeof event === "object"
      ? (event as { model?: { provider?: unknown } }).model?.provider
      : undefined;
    if (typeof fromEvent === "string") return fromEvent;
    const fromContext = (ctx as (OmpCommandContext & { model?: { provider?: unknown } }) | undefined)?.model?.provider;
    return typeof fromContext === "string" ? fromContext : undefined;
  };
  pi.on("session_start", async (event: unknown, ctx: OmpCommandContext) => {
    shuttingDown = false;
    routing.clearPending();
    auth.watchOmpCredentials(ctx); await trackOmpSource(event, ctx); notifyAcpCompactions(ctx); cleanup.start();
    scheduleWarmup(activeModelProvider(event, ctx));
  });
  pi.on("model_select", (event: unknown, ctx: OmpCommandContext) => {
    const provider = activeModelProvider(event, ctx);
    if (provider && provider !== "antigravity-acp") {
      void closeStandby();
    } else {
      scheduleWarmup(provider);
    }
  });
  pi.on("agent_end", async (event: unknown, ctx: OmpCommandContext) => {
    await trackOmpSource(event, ctx);
    notifyAcpCompactions(ctx);
  });
  const handleSourceTransition = async (event: unknown, ctx: OmpCommandContext) => {
    routing.clearPending();
    const transcriptId = sessionIdOf(ctx), file = ctx.sessionManager?.getSessionFile?.();
    const reason: unknown = typeof event === "object" && event !== null ? Reflect.get(event, "reason") : undefined;
    if ((reason === "new" || reason === "resume" || reason === "fork" || reason === "branch" || reason === "btw")
      && !transcriptId?.includes(":side:")) {
      if (!transcriptId || !file) {
        routing.invalidateUnknownSource();
      } else {
        const candidate: unknown = Reflect.get(event, "previousSessionFile");
        const previousFile = typeof candidate === "string" ? candidate : undefined;
        const previousTranscriptId = previousFile ? await sourceId(previousFile).catch(() => undefined) : undefined;
        routing.noteSourceSwitch(reason, transcriptId, file, previousTranscriptId, previousFile);
      }
    }
    await trackOmpSource(event, ctx);
    notifyAcpCompactions(ctx);
  };
  pi.on("session_switch", handleSourceTransition);
  pi.on("session_branch", handleSourceTransition);

  pi.registerTool({
    name: PERMISSION_TOOL_NAME,
    label: "Antigravity ACP Permission",
    description: "Answer a pending Antigravity permission request.",
    parameters: Type.Object({ requestId: Type.String({ minLength: 1 }) }),
    async execute(_id: string, params: { requestId: string }, _signal: unknown, _update: unknown, ctx: OmpCommandContext) {
      const request = runtimes.values().map(bundle => bundle.runtime.getPermission(params.requestId)).find(Boolean);
      if (!request) throw new Error("Permission request expired or missing");
      const labels = request.options.map((option: { label: string }) => option.label);
      const selected = await ctx.ui.select?.(request.title, labels);
      const optionId = selected !== undefined ? request.options[labels.indexOf(selected)]?.id : undefined;
      return {
        content: [{ type: "text", text: optionId ? `Permission: ${selected}` : "Permission denied." }],
        details: { kind: PERMISSION_RESULT_KIND, requestId: request.id, optionId, cancelled: !optionId },
      };
    },
  });

  const catalogStore = new CatalogStore(
    cachePath,
    cleanup,
    prepareRuntime,
    offlineFallbackModels,
    requireAcpAuth,
    spawnConnection,
  );
  let initialModels: ConfiguredCatalogModel[];
  try {
    initialModels = catalogStore.loadInitialOrCached(contextSettings);
  } catch (error) {
    console.warn("[antigravity-acp] Context budgets do not fit the catalog; using model defaults.", error instanceof Error ? error.message : String(error));
    contextSettings = { defaults: { usageMode: contextSettings.defaults.usageMode }, models: {} };
    try {
      initialModels = catalogStore.loadInitialOrCached(contextSettings);
    } catch {
      initialModels = catalogStore.projectWithSettings(offlineFallbackModels(), contextSettings, false);
    }
  }

  pi.registerCommand("antigravity-acp", {
    description: "Inspect ACP status/account/tools/usage/quota/context/cleanup, manage Antigravity login/logout, configure budgets, toggle debug, refresh models or set tool policies",
    handler: createAntigravityCommandHandler({
      configPath,
      contextPath,
      toolPolicyPath,
      cleanup,
      diagnostics,
      connections,
      auth,
      catalog: catalogStore,
      prepareRuntime,
      prepareQuotaRuntime: prepareManagedRuntimeForQuota,
      getContextSettings: () => contextSettings,
      setContextSettings: next => { contextSettings = next; },
      getToolPolicy: () => toolPolicy,
      setToolPolicy: next => {
        const changed = next.nativeTools !== toolPolicy.nativeTools;
        toolPolicy = next;
        if (changed) void closeStandby();
      },
      setPermissionModeState: mode => {
        const next = mode as AdapterPermissionMode;
        const changed = next !== permissionPreference;
        permissionPreference = next;
        if (changed) void closeStandby();
      },
      getLastToolAudit: () => lastToolAudit,
      getRuntimeForSession: sessionId => runtimes.get(sessionId),
      acquireRuntimeForSession: sessionId => runtimes.acquire(sessionId),
      peekRuntimeForSession: sessionId => runtimes.peek(sessionId),
      getSavedSessionCount: savedSessionCount,
      getPermissionMode: effectivePermissionMode,
      getPermissionPreference: () => permissionPreference,
      getAllRuntimes: () => runtimes.values(),
      closeAllRuntimes: closePool,
      onModelsUpdated: models => {
        initialModels = models;
        adapted.registerProvider();
      },
    }),
    getArgumentCompletions: createAntigravityArgumentCompletions({ catalog: catalogStore }),
  });

  const adapted = new Proxy(pi, {
    get(target, key) {
      if (key !== "registerProvider") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return () => target.registerProvider("antigravity-acp", {
        api: "antigravity-acp",
        baseUrl: "acp://antigravity",
        // A config apiKey keeps OMP's own logout report claiming a remaining
        // "provider config (fallback)" source, but dropping it entirely hides
        // the catalog before the first /login. Register it only while an OMP
        // marker is known to exist or before any logout was observed.
        apiKey: auth.apiKeyFallback ? MARKER : undefined,
        models: initialModels,
        async fetchDynamicModels() {
          // OMP may call this during startup, even for another provider.
          // Network discovery is reserved for explicit refresh or first ACP use.
          return catalogStore.getDynamicModels(contextSettings);
        },
        usage: createAntigravityUsageProvider({
          authReady,
          fetchQuota: fetchQuotaSnapshot,
          getAccountEmail: resolveAntigravityAccountEmail,
        }),
        streamSimple(
          model: { id: string },
          context: { tools?: OmpToolDeclaration[]; systemPrompt?: string | string[]; messages: unknown[] },
          options?: { sessionId?: string; parentSessionId?: string; reasoning?: string; signal?: AbortSignal; providerSessionState?: Map<string, OmpProviderSessionState> },
        ) {
          const inputTools = toolDeclarations(context.tools ?? []);
          let tools: OmpToolDeclaration[];
          let availableNames: string;
          const cached = cachedToolProjection;
          const revision = toolProjectionMemo(inputTools, () => String(++toolRevision));
          // Validate live definitions, including mutation of the same array.
          if (cached && cached.revision === revision) {
            tools = cached.tools;
            availableNames = cached.availableNames;
            lastToolAudit = cached.audit;
          } else {
            tools = stableTools(inputTools);
            const bridged = tools.filter(tool => tool.name !== PERMISSION_TOOL_NAME);
            const omitted: Array<{ name: string; reason: string }> = planToolProjection(tools);
            const omittedNames = new Set(omitted.map(tool => tool.name));
            const available = bridged.filter(tool => !omittedNames.has(tool.name));
            availableNames = available.length
              ? available.map(tool => `pi_${tool.name}`).join(", ")
              : "none currently available; report missing capabilities before proposing native operations";
            lastToolAudit = {
              offered: bridged.map(tool => tool.name),
              available: available.map(tool => tool.name),
              omitted,
            };
            cachedToolProjection = { revision, tools, availableNames, audit: lastToolAudit };
          }
          const routedContext = {
            ...context,
            tools,
            messages: normalizeOmpSystemDeltas(context.messages),
            systemPrompt: `${Array.isArray(context.systemPrompt) ? context.systemPrompt.join("\n\n") : context.systemPrompt ?? ""}\n\n${TOOL_ROUTING}\nOMP tool names: ${availableNames}`,
          };
          if (process.env.OMP_ACP_TRACE === "1") {
            console.error("[ACP tools]", JSON.stringify(lastToolAudit));
          }
          // OMP needs a stream synchronously. Defer runtime setup behind it so
          // loading/selecting/listing models performs no ACP process activity.
          const deferred = new PiEventWriter(model);
          const routingId = options?.sessionId;
          const ownerId = sessionOwnerId(routingId, options?.parentSessionId);
          let replacedOwner: OmpProviderSessionState | undefined;
          const ticket = lifecycle.capture(routingId, options?.providerSessionState,
            previous => { replacedOwner = previous; });
          const routingAttempt: RoutingAttempt | undefined = routing.noteStream(routingId, ticket.scope, replacedOwner);
          let routingFailed = false;
          void (async () => {
            try {
              if (options?.signal?.aborted) throw new Error("ACP request cancelled before startup");
              await lifecycle.ready(ticket);
              await requireAcpAuth();
              await diagnostics.measure("runtime.prepare", prepareRuntime);
              if (options?.signal?.aborted) throw new Error("ACP request cancelled during startup");
              if (!catalogStore.upstreamModels.has(model.id)) {
                initialModels = await catalogStore.refresh(contextSettings);
                try { adapted.registerProvider(); } catch { /* advisory */ }
              }
              const original = catalogStore.upstreamModels.get(model.id);
              if (!original) throw new Error(`Antigravity model was not discovered: ${model.id}. Run /antigravity-acp refresh.`);
              await lifecycle.ready(ticket);
              const lease = runtimes.acquire(ownerId);
              const { runtime, provider } = lease.value;
              try {
                lifecycle.attach(ticket, lease.value);
                await runtime.setPermissionMode(currentPermissionProfile().wireMode);
                const stream = provider.streamSimple(selectRuntimeModel(original, options?.reasoning), routedContext, { ...options, sessionId: routingId });
                for await (const event of stream) {
                  const message = event.message ?? event.partial;
                  if (message?.usage) applyApiCostEstimate(model.id, message.usage, message.timestamp ?? Date.now());
                  deferred.stream.push(event);
                }
                deferred.stream.end();
                routing.noteSuccess(routingAttempt);
                if (process.env.OMP_ACP_TRACE === "1") {
                  const snapshot = await runtime.snapshot();
                  console.error("[ACP bridge]", JSON.stringify(snapshot.processes.map((item: { mcpHttp: boolean; omittedTools: unknown[] }) => ({ mcpHttp: item.mcpHttp, omittedTools: item.omittedTools }))));
                }
              } finally { lease.release(); }
            } catch (error) {
              routingFailed = true;
              deferred.fail(classifyAcpFailure(error), options?.signal?.aborted === true);
            } finally {
              if (routingFailed) routing.noteFailure(routingAttempt);
              lifecycle.finish(ticket);
            }
          })();
          return deferred.stream;
        },
        oauth: {
          name: "Google Antigravity (ACP)",
          async login(callbacks: {
            signal?: AbortSignal;
            onAuth: (info: { url: string; instructions?: string }) => void;
            onProgress?: (message?: string) => void;
            onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
          }) {
            await prepareRuntime();
            // Always offer a fresh Google sign-in; without this a new server
            // process silently reuses the saved login and keeps the old account.
            await auth.beginFreshGoogleLogin();
            const lease = runtimes.acquire();
            try {
              const result = await lease.value.provider.auth.oauth.login({
                signal: callbacks.signal,
                notify(event: { message?: string; links?: Array<{ url: string }> }) {
                  if (event.links?.length) {
                    for (const link of event.links) callbacks.onAuth({ url: link.url, instructions: event.message });
                  } else callbacks.onProgress?.(event.message);
                },
                prompt: (request: { message: string; placeholder?: string }) => callbacks.onPrompt({ message: request.message, placeholder: request.placeholder }),
              });
              auth.noteLoginSucceeded();
              // Record the signed-in account on the marker credential so OMP's
              // account list can label it; the email is identity data, not a secret.
              const email = await resolveAntigravityAccountEmail();
              return email ? { ...result, email } : result;
            } finally {
              lease.release();
              auth.endFreshGoogleLogin();
            }
          },
          refreshToken: async (credentials: unknown) => {
            const leased = runtimes.acquireExisting() ?? runtimes.acquire();
            try {
              return await leased.value.provider.auth.oauth.refresh(credentials);
            } finally {
              leased.release();
            }
          },
          getApiKey: () => MARKER,
        },
      });
    },
  });
  adapted.registerProvider();
}
