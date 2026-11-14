import type { AntigravityQuotaSnapshot } from "./usage-accounting.ts";

export interface OmpUsageCredential {
  type: string;
  accountId?: string;
  email?: string;
  projectId?: string;
}

export interface OmpUsageFetchParams {
  provider: string;
  credential: OmpUsageCredential;
  accountKey?: string;
  signal?: AbortSignal;
}

export interface OmpUsageLimit {
  id: string;
  label: string;
  scope: {
    provider: string;
    accountId?: string;
    windowId?: string;
  };
  window?: {
    id: string;
    label: string;
    durationMs?: number;
    resetsAt?: number;
  };
  amount: {
    unit: "percent";
    remainingFraction: number;
    usedFraction: number;
    remaining: number;
    used: number;
    limit: number;
  };
  status: "ok" | "warning" | "exhausted" | "unknown";
}

export interface OmpUsageReport {
  provider: string;
  fetchedAt: number;
  limits: OmpUsageLimit[];
  metadata?: {
    email?: string;
    accountId?: string;
  };
}

export interface OmpUsageProvider {
  id: string;
  cacheVersion: number;
  supports: (params: OmpUsageFetchParams) => boolean;
  fetchUsage: (params: OmpUsageFetchParams) => Promise<OmpUsageReport | null>;
}

const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;

function slugify(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "default";
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function quotaStatus(remainingFraction: number): OmpUsageLimit["status"] {
  if (!Number.isFinite(remainingFraction)) return "unknown";
  if (remainingFraction <= 0) return "exhausted";
  if (remainingFraction <= 0.1) return "warning";
  return "ok";
}

function windowMetadata(window: string, resetTime?: string): OmpUsageLimit["window"] {
  const parsedReset = resetTime ? Date.parse(resetTime) : Number.NaN;
  const resetsAt = Number.isFinite(parsedReset) ? parsedReset : undefined;
  if (window === "5h") {
    return {
      id: "5h",
      label: "5h",
      durationMs: FIVE_HOURS_MS,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
  }
  if (window === "weekly") {
    return {
      id: "weekly",
      label: "Weekly",
      durationMs: SEVEN_DAYS_MS,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
  }
  return {
    id: slugify(window),
    label: window,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/** Converts an ACP `/usage` quota snapshot into an OMP `UsageReport` for `/usage show`. */
export function quotaSnapshotToUsageReport(
  snapshot: AntigravityQuotaSnapshot,
  options: { provider?: string; email?: string; accountId?: string } = {},
): OmpUsageReport {
  const provider = options.provider ?? "antigravity-acp";
  const limits: OmpUsageLimit[] = [];
  const seenIds = new Map<string, number>();

  for (const group of snapshot.groups) {
    const groupSlug = slugify(group.displayName);
    for (const bucket of group.buckets) {
      const window = windowMetadata(bucket.window, bucket.resetTime);
      const windowId = window?.id ?? slugify(bucket.window);
      const baseId = `${provider}:${groupSlug}:${windowId}`;
      const duplicateCount = seenIds.get(baseId) ?? 0;
      seenIds.set(baseId, duplicateCount + 1);
      const id = duplicateCount === 0 ? baseId : `${baseId}:${duplicateCount + 1}`;
      const remainingFraction = clampFraction(bucket.remainingFraction);
      const usedFraction = Math.round(clampFraction(1 - remainingFraction) * 1_000_000) / 1_000_000;
      limits.push({
        id,
        label: group.displayName,
        scope: {
          provider,
          windowId,
          ...(options.accountId ? { accountId: options.accountId } : {}),
        },
        window,
        amount: {
          unit: "percent",
          remainingFraction,
          usedFraction,
          remaining: Math.round(remainingFraction * 1000) / 10,
          used: Math.round(usedFraction * 1000) / 10,
          limit: 100,
        },
        status: quotaStatus(remainingFraction),
      });
    }
  }

  const metadata: OmpUsageReport["metadata"] = {};
  if (options.email) metadata.email = options.email;
  if (options.accountId) metadata.accountId = options.accountId;

  return {
    provider,
    fetchedAt: snapshot.at,
    limits,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** Creates an OMP `UsageProvider` backed strictly by the official ACP `/usage` quota snapshot. */
export function createAntigravityUsageProvider(deps: {
  providerId?: string;
  authReady: () => Promise<boolean>;
  fetchQuota: (signal?: AbortSignal) => Promise<AntigravityQuotaSnapshot>;
  getAccountEmail: () => string | undefined | Promise<string | undefined>;
}): OmpUsageProvider {
  const providerId = deps.providerId ?? "antigravity-acp";
  let inFlight: {
    controller: AbortController;
    subscribers: number;
    promise: Promise<OmpUsageReport | null>;
  } | undefined;
  return {
    id: providerId,
    cacheVersion: 1,
    supports: params => params.provider === providerId,
    async fetchUsage(params) {
      if (params.signal?.aborted) return null;
      if (!(await deps.authReady())) return null;
      if (params.signal?.aborted) return null;
      let shared = inFlight;
      if (!shared) {
        const controller = new AbortController();
        const load = (async () => {
          try {
            const snapshot = await deps.fetchQuota(controller.signal);
            if (controller.signal.aborted) return null;
            return quotaSnapshotToUsageReport(snapshot, {
              provider: providerId,
              email: (await deps.getAccountEmail()) ?? params.credential.email,
              accountId: params.credential.accountId,
            });
          } catch (error) {
            if (controller.signal.aborted) return null;
            throw error;
          } finally {
            if (inFlight?.promise === load) inFlight = undefined;
          }
        })();
        shared = { controller, subscribers: 0, promise: load };
        inFlight = shared;
      }
      shared.subscribers++;
      const outcome = Promise.withResolvers<OmpUsageReport | null>();
      let subscribed = true;
      const detach = () => {
        if (!subscribed) return;
        subscribed = false;
        shared.subscribers--;
        params.signal?.removeEventListener("abort", onAbort);
        if (shared.subscribers !== 0) return;
        if (inFlight?.promise === shared.promise) inFlight = undefined;
        shared.controller.abort();
      };
      const onAbort = () => {
        detach();
        outcome.resolve(null);
      };
      shared.promise.then(
        report => {
          detach();
          outcome.resolve(report);
        },
        error => {
          const aborted = shared.controller.signal.aborted || params.signal?.aborted;
          detach();
          if (aborted) outcome.resolve(null);
          else outcome.reject(error);
        },
      );
      params.signal?.addEventListener("abort", onAbort, { once: true });
      if (params.signal?.aborted) onAbort();
      return outcome.promise;
    },
  };
}
