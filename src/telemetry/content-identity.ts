/**
 * Content-identity telemetry emitters — Phase 1 observability layer.
 *
 * 8 metrics per spec §Observability:
 *   1. content_identity_sync_duration_seconds (histogram per content type)
 *   2. content_identity_items_processed_total (counter per content type)
 *   3. content_identity_resolution_confidence_total (counter per type × tier)
 *   4. content_identity_conflicts_total (counter per content type)
 *   5. content_identity_near_duplicates_total (counter per content type)
 *   6. content_identity_review_queue_depth (gauge — unresolved rows)
 *   7. content_identity_epg_uid_hits_total (counter — EPG rows that got content_uid)
 *   8. content_identity_epg_uid_misses_total (counter — EPG rows without match)
 *
 * Implementation: lightweight in-process counters + periodic console export.
 * No external APM dependency — designed to be swapped for Prometheus/StatsD later.
 * Counters reset on process restart (acceptable for Phase 1 observability).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Internal counters (singleton, module-scope)
// ─────────────────────────────────────────────────────────────────────────────

interface Metrics {
  syncDurationSeconds: Record<string, number[]>; // type → [duration, ...]
  itemsProcessedTotal: Record<string, number>;
  resolutionConfidenceTotal: Record<string, Record<string, number>>;
  conflictsTotal: Record<string, number>;
  nearDuplicatesTotal: Record<string, number>;
  reviewQueueDepth: number;
  epgUidHitsTotal: number;
  epgUidMissesTotal: number;
}

const metrics: Metrics = {
  syncDurationSeconds: {},
  itemsProcessedTotal: {},
  resolutionConfidenceTotal: {},
  conflictsTotal: {},
  nearDuplicatesTotal: {},
  reviewQueueDepth: 0,
  epgUidHitsTotal: 0,
  epgUidMissesTotal: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Emitters (public API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metric 1: Record the duration of a full dual-write sync cycle for a content type.
 */
export function recordSyncDurationSeconds(
  contentType: string,
  durationSeconds: number,
): void {
  if (!metrics.syncDurationSeconds[contentType]) {
    metrics.syncDurationSeconds[contentType] = [];
  }
  metrics.syncDurationSeconds[contentType]!.push(durationSeconds);
  console.log(
    `[telemetry:content-identity] sync_duration type=${contentType} duration=${durationSeconds.toFixed(3)}s`,
  );
}

/**
 * Metric 2: Record the number of items processed in a sync pass.
 */
export function recordItemsProcessed(contentType: string, count: number): void {
  metrics.itemsProcessedTotal[contentType] =
    (metrics.itemsProcessedTotal[contentType] ?? 0) + count;
  console.log(
    `[telemetry:content-identity] items_processed type=${contentType} count=${count}`,
  );
}

/**
 * Metric 3: Record resolution confidence tier for a batch of items.
 */
export function recordResolutionConfidence(
  contentType: string,
  confidence: "high" | "medium" | "low",
  count: number,
): void {
  if (!metrics.resolutionConfidenceTotal[contentType]) {
    metrics.resolutionConfidenceTotal[contentType] = {};
  }
  const byType = metrics.resolutionConfidenceTotal[contentType]!;
  byType[confidence] = (byType[confidence] ?? 0) + count;
  console.log(
    `[telemetry:content-identity] resolution_confidence type=${contentType} confidence=${confidence} count=${count}`,
  );
}

/**
 * Metric 4: Record external_id conflicts (external_uid ≠ title_uid).
 */
export function recordConflict(contentType: string, count: number): void {
  metrics.conflictsTotal[contentType] =
    (metrics.conflictsTotal[contentType] ?? 0) + count;
  console.log(
    `[telemetry:content-identity] conflicts type=${contentType} count=${count}`,
  );
}

/**
 * Metric 5: Record near-duplicate pairs written to review queue.
 */
export function recordNearDuplicate(contentType: string): void {
  metrics.nearDuplicatesTotal[contentType] =
    (metrics.nearDuplicatesTotal[contentType] ?? 0) + 1;
}

/**
 * Metric 6: Snapshot the review queue depth (unresolved rows).
 */
export function recordReviewQueueDepth(depth: number): void {
  metrics.reviewQueueDepth = depth;
  if (depth > 100) {
    console.warn(
      `[telemetry:content-identity] ALERT: review_queue_depth=${depth} exceeds threshold 100`,
    );
  } else {
    console.log(`[telemetry:content-identity] review_queue_depth=${depth}`);
  }
}

/**
 * Metric 7: Record EPG rows that got content_uid populated.
 */
export function recordEpgUidHit(count = 1): void {
  metrics.epgUidHitsTotal += count;
}

/**
 * Metric 8: Record EPG rows that had no matching content_uid.
 */
export function recordEpgUidMiss(count = 1): void {
  metrics.epgUidMissesTotal += count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot export (for tests + debug endpoints)
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a snapshot of all current metric values. */
export function getMetricsSnapshot(): Readonly<Metrics> {
  return { ...metrics };
}

/** Reset all counters — used in tests. */
export function resetMetrics(): void {
  metrics.syncDurationSeconds = {};
  metrics.itemsProcessedTotal = {};
  metrics.resolutionConfidenceTotal = {};
  metrics.conflictsTotal = {};
  metrics.nearDuplicatesTotal = {};
  metrics.reviewQueueDepth = 0;
  metrics.epgUidHitsTotal = 0;
  metrics.epgUidMissesTotal = 0;
}
