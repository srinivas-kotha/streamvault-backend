/**
 * AccountService — Provider account info with active connection tracking.
 *
 * Responsibilities:
 *  - Fetch account info (maxConnections, expiryDate, status) from provider
 *  - Track active proxy streams in memory (increment on start, decrement on end)
 *  - Expose combined account + connection state
 *  - Return { supported: false } when provider lacks the authenticate capability
 */

import { cacheGet, cacheSet } from "./cache.service";
import type { IStreamProvider, AccountInfo } from "../providers";

// In-memory connection counter
let activeConnections = 0;

// Set to track active stream IDs (dedup protection)
const activeStreamIds = new Set<string>();

// Cache TTL for account info (5 minutes)
const ACCOUNT_INFO_TTL = 300;

export interface AccountStatus extends AccountInfo {
  supported: boolean;
  trackedActiveConnections: number;
}

/**
 * Increment the active connection count.
 * Uses a stream key (e.g., `userId:streamId`) to prevent double-counting.
 * Returns the new count.
 */
export function incrementConnections(streamKey: string): number {
  if (!activeStreamIds.has(streamKey)) {
    activeStreamIds.add(streamKey);
    activeConnections++;
  }
  return activeConnections;
}

/**
 * Decrement the active connection count.
 * Safe to call multiple times for the same key.
 * Returns the new count.
 */
export function decrementConnections(streamKey: string): number {
  if (activeStreamIds.has(streamKey)) {
    activeStreamIds.delete(streamKey);
    activeConnections = Math.max(0, activeConnections - 1);
  }
  return activeConnections;
}

/**
 * Get the current active connection count.
 */
export function getActiveConnections(): number {
  return activeConnections;
}

/**
 * Fetch account info from the provider, merged with tracked active connections.
 *
 * If the provider doesn't support authenticate(), returns { supported: false }.
 * Result is cached for 5 minutes.
 */
export async function getAccountStatus(
  provider: IStreamProvider,
): Promise<AccountStatus> {
  const cacheKey = `account:status:${provider.name}`;
  const cached = cacheGet<AccountStatus>(cacheKey);
  if (cached) {
    // Always return fresh activeConnections — not the cached value
    return { ...cached, trackedActiveConnections: activeConnections };
  }

  // Provider doesn't support authentication info
  if (typeof provider.authenticate !== "function") {
    return {
      supported: false,
      trackedActiveConnections: activeConnections,
    };
  }

  try {
    const info: AccountInfo = await provider.authenticate();

    const status: AccountStatus = {
      supported: true,
      trackedActiveConnections: activeConnections,
      ...info,
    };

    // Cache but don't store the live connection count
    const toCache = { ...status };
    cacheSet(cacheKey, toCache, ACCOUNT_INFO_TTL);

    return status;
  } catch (err) {
    console.error(
      "[account] Failed to fetch account info:",
      err instanceof Error ? err.message : err,
    );

    // Return partial info on error
    return {
      supported: true,
      trackedActiveConnections: activeConnections,
      status: undefined,
    };
  }
}

/**
 * Check whether a new stream connection should be allowed.
 * Returns true if under the maxConnections limit (or if limit is unknown).
 */
export async function canStartStream(
  provider: IStreamProvider,
): Promise<{ allowed: boolean; reason?: string }> {
  const status = await getAccountStatus(provider);

  if (!status.supported) return { allowed: true };

  const max = status.maxConnections;
  if (max == null) return { allowed: true };

  // Use whichever is higher: provider's reported active count or our tracked count
  const current = Math.max(
    status.activeConnections ?? 0,
    status.trackedActiveConnections,
  );

  if (current >= max) {
    return {
      allowed: false,
      reason: `Connection limit reached (${current}/${max} active connections)`,
    };
  }

  return { allowed: true };
}
