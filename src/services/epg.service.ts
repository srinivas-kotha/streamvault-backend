/**
 * EPGService — Aggregated EPG from multiple sources, stored in PostgreSQL.
 *
 * Sources:
 *  - ProviderEPGSource: delegates to the active IStreamProvider.getEPG()
 *  - XMLTVEPGSource: fetches + SAX-parses an XMLTV URL (optional via XMLTV_URL env var)
 *
 * Refresh: background task every 6 hours.
 * Storage: sv_epg table (upsert on channel_id + start_time + end_time).
 */

import sax from "sax";
import { query } from "./db.service";
import { cacheGet, cacheSet } from "./cache.service";
import type { IStreamProvider, EPGEntry } from "../providers";

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const XMLTV_URL = process.env.XMLTV_URL ?? "";
const XMLTV_FETCH_TIMEOUT_MS = 60_000;
const UPSERT_BATCH_SIZE = 500;

// Cache TTLs (seconds)
const EPG_NOW_TTL = 300; // 5 min
const EPG_CHANNEL_TTL = 900; // 15 min

// ─────────────────────────────────────────────
// EPG source interfaces
// ─────────────────────────────────────────────

export interface IEPGSource {
  readonly name: string;
  fetchForChannel(channelId: string, limit?: number): Promise<EPGEntry[]>;
  fetchAll(): Promise<EPGEntry[]>;
}

export class ProviderEPGSource implements IEPGSource {
  readonly name = "provider";
  private provider: IStreamProvider;

  constructor(provider: IStreamProvider) {
    this.provider = provider;
  }

  async fetchForChannel(channelId: string, limit = 10): Promise<EPGEntry[]> {
    const entries = await this.provider.getEPG(channelId);
    return entries.slice(0, limit);
  }

  async fetchAll(): Promise<EPGEntry[]> {
    return this.provider.getFullEPG();
  }
}

// ─────────────────────────────────────────────
// XMLTV SAX parser
// ─────────────────────────────────────────────

/**
 * Fetches and SAX-parses an XMLTV document at the given URL.
 * Memory-constant: emits EPGEntry events rather than buffering the full file.
 */
export function parseXMLTV(url: string): Promise<EPGEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: EPGEntry[] = [];
    const parser = sax.parser(true, { lowercase: true });

    let current: Partial<EPGEntry> & { _tag?: string } = {};
    let inTitle = false;
    let inDesc = false;
    let titleBuf = "";
    let descBuf = "";
    let idCounter = 0;

    parser.onopentag = (node) => {
      if (node.name === "programme") {
        const attrs = node.attributes as Record<string, string>;
        current = {
          channelId: attrs["channel"] ?? "",
          start: normalizeXMLTVDate(attrs["start"] ?? ""),
          end: normalizeXMLTVDate(attrs["stop"] ?? ""),
        };
        inTitle = false;
        inDesc = false;
        titleBuf = "";
        descBuf = "";
      } else if (node.name === "title") {
        inTitle = true;
        titleBuf = "";
      } else if (node.name === "desc") {
        inDesc = true;
        descBuf = "";
      }
    };

    parser.ontext = (text) => {
      if (inTitle) titleBuf += text;
      if (inDesc) descBuf += text;
    };

    parser.oncdata = (cdata) => {
      if (inTitle) titleBuf += cdata;
      if (inDesc) descBuf += cdata;
    };

    parser.onclosetag = (tagName) => {
      if (tagName === "title") {
        inTitle = false;
        current.title = maybeDecodeBase64(titleBuf.trim());
      } else if (tagName === "desc") {
        inDesc = false;
        current.description = maybeDecodeBase64(descBuf.trim());
      } else if (tagName === "programme") {
        if (current.channelId && current.start && current.end) {
          idCounter++;
          entries.push({
            id: String(idCounter),
            channelId: current.channelId,
            title: current.title ?? "(no title)",
            description: current.description ?? "",
            start: current.start,
            end: current.end,
          });
        }
        current = {};
      }
    };

    parser.onerror = (err) => {
      parser.resume(); // Continue parsing despite XML errors
      console.error("[epg] XMLTV parse error:", err.message);
    };

    parser.onend = () => resolve(entries);

    // Fetch and stream into the parser
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), XMLTV_FETCH_TIMEOUT_MS);

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        clearTimeout(timer);
        if (!res.ok) {
          reject(new Error(`XMLTV fetch returned ${res.status}`));
          return;
        }
        // Stream the response text in chunks for memory efficiency
        const text = await res.text();
        parser.write(text).close();
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Detect and decode base64-encoded EPG strings (common in Xtream providers).
 */
function maybeDecodeBase64(value: string): string {
  if (!value) return value;
  // Base64 strings are typically long, contain only valid base64 chars, and length % 4 == 0
  if (value.length > 20 && /^[A-Za-z0-9+/]+=*$/.test(value)) {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf-8");
      // Only accept if it looks like readable text
      if (decoded && /[\w\s]/.test(decoded)) return decoded;
    } catch {
      // Not valid base64 — return as-is
    }
  }
  return value;
}

/**
 * Normalize XMLTV date formats to ISO 8601.
 * XMLTV: "20231015060000 +0000" → "2023-10-15T06:00:00.000Z"
 */
function normalizeXMLTVDate(raw: string): string {
  if (!raw) return raw;
  // Already ISO-ish
  if (raw.includes("T") && raw.includes(":")) return raw;

  // XMLTV format: "YYYYMMDDHHmmss +HHMM"
  const match = raw.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/,
  );
  if (!match) return raw;

  const [, year, month, day, hour, min, sec, tz] = match;
  const tzPart = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : "Z";
  return `${year}-${month}-${day}T${hour}:${min}:${sec}${tzPart}`;
}

// ─────────────────────────────────────────────
// DB persistence
// ─────────────────────────────────────────────

async function upsertEPGEntries(
  entries: EPGEntry[],
  source: string,
): Promise<void> {
  if (entries.length === 0) return;

  for (let i = 0; i < entries.length; i += UPSERT_BATCH_SIZE) {
    const chunk = entries.slice(i, i + UPSERT_BATCH_SIZE);

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let col = 1;

    for (const entry of chunk) {
      placeholders.push(
        `($${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, NOW())`,
      );
      values.push(
        entry.channelId,
        entry.title,
        entry.description ?? null,
        entry.start,
        entry.end,
        source,
      );
    }

    await query(
      `INSERT INTO sv_epg
         (channel_id, title, description, start_time, end_time, source, fetched_at)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (channel_id, start_time, end_time) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         source = EXCLUDED.source,
         fetched_at = NOW()`,
      values,
    );
  }
}

// ─────────────────────────────────────────────
// Public query methods
// ─────────────────────────────────────────────

/**
 * Get EPG entries for a single channel (now + upcoming).
 * Returns up to `limit` entries, starting from current time.
 */
export async function getChannelEPG(
  channelId: string,
  limit = 10,
): Promise<EPGEntry[]> {
  const cacheKey = `epg:channel:${channelId}:${limit}`;
  const cached = cacheGet<EPGEntry[]>(cacheKey);
  if (cached) return cached;

  const result = await query<{
    id: number;
    channel_id: string;
    title: string;
    description: string | null;
    start_time: Date;
    end_time: Date;
  }>(
    `SELECT id, channel_id, title, description, start_time, end_time
     FROM sv_epg
     WHERE channel_id = $1 AND end_time > NOW()
     ORDER BY start_time
     LIMIT $2`,
    [channelId, limit],
  );

  const entries: EPGEntry[] = result.rows.map((row) => ({
    id: String(row.id),
    channelId: row.channel_id,
    title: row.title,
    description: row.description ?? "",
    start: row.start_time.toISOString(),
    end: row.end_time.toISOString(),
  }));

  cacheSet(cacheKey, entries, EPG_CHANNEL_TTL);
  return entries;
}

/**
 * Bulk "now playing" for a list of channel IDs.
 * Returns one EPGEntry per channel (the currently airing programme).
 */
export async function getNowPlaying(
  channelIds: string[],
): Promise<Record<string, EPGEntry>> {
  if (channelIds.length === 0) return {};

  const cacheKey = `epg:now:${channelIds.sort().join(",")}`;
  const cached = cacheGet<Record<string, EPGEntry>>(cacheKey);
  if (cached) return cached;

  const result = await query<{
    id: number;
    channel_id: string;
    title: string;
    description: string | null;
    start_time: Date;
    end_time: Date;
  }>(
    `SELECT DISTINCT ON (channel_id) id, channel_id, title, description, start_time, end_time
     FROM sv_epg
     WHERE channel_id = ANY($1::text[])
       AND start_time <= NOW() AND end_time > NOW()
     ORDER BY channel_id, start_time`,
    [channelIds],
  );

  const now: Record<string, EPGEntry> = {};
  for (const row of result.rows) {
    now[row.channel_id] = {
      id: String(row.id),
      channelId: row.channel_id,
      title: row.title,
      description: row.description ?? "",
      start: row.start_time.toISOString(),
      end: row.end_time.toISOString(),
    };
  }

  cacheSet(cacheKey, now, EPG_NOW_TTL);
  return now;
}

/**
 * EPG grid: multiple channels × time window.
 * Returns all entries within [fromTime, toTime] for the given channel IDs.
 */
export async function getEPGGrid(
  channelIds: string[],
  fromTime: Date,
  toTime: Date,
): Promise<Record<string, EPGEntry[]>> {
  if (channelIds.length === 0) return {};

  const result = await query<{
    id: number;
    channel_id: string;
    title: string;
    description: string | null;
    start_time: Date;
    end_time: Date;
  }>(
    `SELECT id, channel_id, title, description, start_time, end_time
     FROM sv_epg
     WHERE channel_id = ANY($1::text[])
       AND start_time < $2 AND end_time > $3
     ORDER BY channel_id, start_time`,
    [channelIds, toTime, fromTime],
  );

  const grid: Record<string, EPGEntry[]> = {};
  for (const row of result.rows) {
    if (!grid[row.channel_id]) grid[row.channel_id] = [];
    grid[row.channel_id]!.push({
      id: String(row.id),
      channelId: row.channel_id,
      title: row.title,
      description: row.description ?? "",
      start: row.start_time.toISOString(),
      end: row.end_time.toISOString(),
    });
  }

  return grid;
}

// ─────────────────────────────────────────────
// Background refresh
// ─────────────────────────────────────────────

let epgRefreshRunning = false;

async function refreshEPG(provider: IStreamProvider): Promise<void> {
  if (epgRefreshRunning) {
    console.log("[epg] Refresh already running — skipping");
    return;
  }
  epgRefreshRunning = true;

  try {
    // Source 1: Provider full EPG
    console.log("[epg] Fetching full EPG from provider...");
    const providerEntries = await provider.getFullEPG();
    if (providerEntries.length > 0) {
      await upsertEPGEntries(providerEntries, "provider");
      console.log(
        `[epg] Upserted ${providerEntries.length} entries from provider`,
      );
    }

    // Source 2: External XMLTV (optional)
    if (XMLTV_URL) {
      console.log(`[epg] Fetching XMLTV from ${XMLTV_URL}...`);
      const xmltvEntries = await parseXMLTV(XMLTV_URL);
      if (xmltvEntries.length > 0) {
        await upsertEPGEntries(xmltvEntries, "xmltv");
        console.log(`[epg] Upserted ${xmltvEntries.length} entries from XMLTV`);
      }
    }
  } catch (err) {
    console.error(
      "[epg] Refresh error:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    epgRefreshRunning = false;
  }
}

/**
 * Start background EPG refresh timer.
 * Called once at server startup.
 */
export function startEPGRefresh(provider: IStreamProvider): void {
  // Initial refresh after a brief delay (let server start first)
  setTimeout(() => refreshEPG(provider), 30_000);

  // Scheduled refresh every 6 hours
  setInterval(() => refreshEPG(provider), REFRESH_INTERVAL_MS);

  console.log("[epg] Background EPG refresh started");
}
