/**
 * PlaybackService — resolves a content_uid to a StreamInfo via the provider map.
 *
 * Phase 3 — content-identity read-side cutover.
 *
 * Call graph:
 *   resolveStreamUrl(content_uid)
 *     → lookup (content_uid, ACTIVE_PROVIDER_ID) in sv_content_provider_map
 *     → if found: getProvider().getStreamInfo(item_id, content_type)
 *     → if not found but master exists: throw ContentDormant
 *     → if master missing: throw ContentNotFound
 */

import { query } from "./db.service";
import { ACTIVE_PROVIDER_ID } from "../config";
import { getProvider } from "../providers";
import type { StreamInfo, ContentType } from "../providers/provider.types";

// ─────────────────────────────────────────────────────────────────────────────
// Typed errors
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when the content_uid is not present in sv_content_master at all. */
export class ContentNotFound extends Error {
  constructor(uid: string) {
    super(`content_uid not in master: ${uid}`);
    this.name = "ContentNotFound";
  }
}

/**
 * Thrown when the content_uid exists in sv_content_master but has no row
 * for the active provider in sv_content_provider_map. The content was seen
 * on a previous provider and is dormant on the current one.
 */
export class ContentDormant extends Error {
  constructor(
    public uid: string,
    public lastSeenProviderId?: string,
  ) {
    super(`content not on active provider: ${uid}`);
    this.name = "ContentDormant";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveStreamUrl
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a content_uid to a StreamInfo by looking up the active provider's
 * item_id in sv_content_provider_map, then delegating to the provider.
 *
 * @param uid  16-char lowercase hex content_uid (CHAR(16) from schema)
 * @param ext  Optional extension hint passed through to provider.getStreamInfo
 * @throws ContentDormant  if master row exists but no map row for ACTIVE_PROVIDER_ID
 * @throws ContentNotFound if content_uid is absent from sv_content_master entirely
 */
export async function resolveStreamUrl(
  uid: string,
  ext?: string,
): Promise<StreamInfo> {
  // Step 1: look up the active provider mapping (item_id only)
  const mapResult = await query<{ item_id: string }>(
    `SELECT item_id
       FROM sv_content_provider_map
      WHERE content_uid = $1
        AND provider_id = $2`,
    [uid, ACTIVE_PROVIDER_ID],
  );

  if (mapResult.rows.length > 0) {
    // Happy path: mapping found — fetch content_type from master, then call provider
    const { item_id } = mapResult.rows[0]!;
    const masterForType = await query<{ content_type: ContentType }>(
      `SELECT content_type FROM sv_content_master WHERE content_uid = $1`,
      [uid],
    );
    const content_type = masterForType.rows[0]?.content_type ?? "vod";
    return getProvider().getStreamInfo(item_id, content_type, ext);
  }

  // No mapping for active provider — check if master row exists at all
  const masterResult = await query<{ content_type: ContentType }>(
    `SELECT content_type FROM sv_content_master WHERE content_uid = $1`,
    [uid],
  );

  if (masterResult.rows.length === 0) {
    throw new ContentNotFound(uid);
  }

  // Master exists but not on active provider — content is dormant.
  // Find the last seen provider for diagnostic context (if any).
  const lastSeenResult = await query<{ provider_id: string }>(
    `SELECT provider_id
       FROM sv_content_provider_map
      WHERE content_uid = $1
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`,
    [uid],
  );

  const lastSeenProviderId = lastSeenResult.rows[0]?.provider_id;
  throw new ContentDormant(uid, lastSeenProviderId);
}
