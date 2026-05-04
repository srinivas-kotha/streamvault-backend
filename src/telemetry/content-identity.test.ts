import { describe, it, expect, beforeEach } from "vitest";
import {
  recordSyncDurationSeconds,
  recordItemsProcessed,
  recordResolutionConfidence,
  recordConflict,
  recordNearDuplicate,
  recordReviewQueueDepth,
  recordEpgUidHit,
  recordEpgUidMiss,
  getMetricsSnapshot,
  resetMetrics,
} from "./content-identity";

describe("content-identity telemetry", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("recordSyncDurationSeconds accumulates durations per type", () => {
    recordSyncDurationSeconds("live", 1.5);
    recordSyncDurationSeconds("live", 2.3);
    recordSyncDurationSeconds("vod", 5.0);
    const snap = getMetricsSnapshot();
    expect(snap.syncDurationSeconds["live"]).toEqual([1.5, 2.3]);
    expect(snap.syncDurationSeconds["vod"]).toEqual([5.0]);
  });

  it("recordItemsProcessed accumulates per type", () => {
    recordItemsProcessed("live", 100);
    recordItemsProcessed("live", 50);
    recordItemsProcessed("vod", 200);
    const snap = getMetricsSnapshot();
    expect(snap.itemsProcessedTotal["live"]).toBe(150);
    expect(snap.itemsProcessedTotal["vod"]).toBe(200);
  });

  it("recordResolutionConfidence tracks confidence tiers per type", () => {
    recordResolutionConfidence("movie", "high", 10);
    recordResolutionConfidence("movie", "medium", 80);
    recordResolutionConfidence("movie", "low", 10);
    const snap = getMetricsSnapshot();
    expect(snap.resolutionConfidenceTotal["movie"]?.["high"]).toBe(10);
    expect(snap.resolutionConfidenceTotal["movie"]?.["medium"]).toBe(80);
    expect(snap.resolutionConfidenceTotal["movie"]?.["low"]).toBe(10);
  });

  it("recordConflict increments per type", () => {
    recordConflict("vod", 3);
    recordConflict("vod", 2);
    const snap = getMetricsSnapshot();
    expect(snap.conflictsTotal["vod"]).toBe(5);
  });

  it("recordNearDuplicate increments counter", () => {
    recordNearDuplicate("movie");
    recordNearDuplicate("movie");
    const snap = getMetricsSnapshot();
    expect(snap.nearDuplicatesTotal["movie"]).toBe(2);
  });

  it("recordReviewQueueDepth sets the gauge", () => {
    recordReviewQueueDepth(42);
    expect(getMetricsSnapshot().reviewQueueDepth).toBe(42);
    recordReviewQueueDepth(7);
    expect(getMetricsSnapshot().reviewQueueDepth).toBe(7);
  });

  it("recordEpgUidHit and recordEpgUidMiss accumulate", () => {
    recordEpgUidHit(10);
    recordEpgUidMiss(3);
    recordEpgUidHit(5);
    const snap = getMetricsSnapshot();
    expect(snap.epgUidHitsTotal).toBe(15);
    expect(snap.epgUidMissesTotal).toBe(3);
  });

  it("resetMetrics zeroes all counters", () => {
    recordSyncDurationSeconds("live", 1.0);
    recordItemsProcessed("live", 100);
    recordReviewQueueDepth(50);
    resetMetrics();
    const snap = getMetricsSnapshot();
    expect(snap.syncDurationSeconds).toEqual({});
    expect(snap.itemsProcessedTotal).toEqual({});
    expect(snap.reviewQueueDepth).toBe(0);
  });
});
