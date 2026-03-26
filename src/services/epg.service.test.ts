import { describe, it, expect, vi, afterEach } from "vitest";
import { parseXMLTV } from "./epg.service";

// ─────────────────────────────────────────────────────────────────────────────
// parseXMLTV — XMLTV SAX parser unit tests
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
  <channel id="cnn.us"><display-name lang="en">CNN</display-name></channel>
  <channel id="bbc.uk"><display-name lang="en">BBC</display-name></channel>

  <programme start="20231015060000 +0000" stop="20231015070000 +0000" channel="cnn.us">
    <title lang="en">Morning Express</title>
    <desc lang="en">Live news coverage.</desc>
  </programme>

  <programme start="20231015070000 +0000" stop="20231015080000 +0000" channel="cnn.us">
    <title lang="en">Newsroom</title>
    <desc lang="en">Top stories.</desc>
  </programme>

  <programme start="20231015060000 +0000" stop="20231015090000 +0000" channel="bbc.uk">
    <title lang="en">World Service</title>
  </programme>
</tv>`;

function mockXMLTVFetch(xml: string, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(xml),
  });
}

describe("parseXMLTV", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses all programme entries from valid XMLTV", async () => {
    vi.stubGlobal("fetch", mockXMLTVFetch(SAMPLE_XMLTV));

    const entries = await parseXMLTV("http://example.com/xmltv.xml");

    expect(entries).toHaveLength(3);
  });

  it("maps channelId from programme channel attribute", async () => {
    vi.stubGlobal("fetch", mockXMLTVFetch(SAMPLE_XMLTV));

    const entries = await parseXMLTV("http://example.com/xmltv.xml");

    const cnnEntries = entries.filter((e) => e.channelId === "cnn.us");
    expect(cnnEntries).toHaveLength(2);

    const bbcEntries = entries.filter((e) => e.channelId === "bbc.uk");
    expect(bbcEntries).toHaveLength(1);
  });

  it("extracts title correctly", async () => {
    vi.stubGlobal("fetch", mockXMLTVFetch(SAMPLE_XMLTV));

    const entries = await parseXMLTV("http://example.com/xmltv.xml");
    const cnnFirst = entries.find((e) => e.channelId === "cnn.us");

    expect(cnnFirst?.title).toBe("Morning Express");
  });

  it("extracts description when present", async () => {
    vi.stubGlobal("fetch", mockXMLTVFetch(SAMPLE_XMLTV));

    const entries = await parseXMLTV("http://example.com/xmltv.xml");
    const cnnFirst = entries.find((e) => e.channelId === "cnn.us");

    expect(cnnFirst?.description).toBe("Live news coverage.");
  });

  it("uses empty string for description when absent", async () => {
    vi.stubGlobal("fetch", mockXMLTVFetch(SAMPLE_XMLTV));

    const entries = await parseXMLTV("http://example.com/xmltv.xml");
    const bbc = entries.find((e) => e.channelId === "bbc.uk");

    expect(bbc?.description).toBe("");
  });

  it("normalizes XMLTV timestamps to ISO 8601", async () => {
    vi.stubGlobal("fetch", mockXMLTVFetch(SAMPLE_XMLTV));

    const entries = await parseXMLTV("http://example.com/xmltv.xml");
    const first = entries[0];

    // Should look like an ISO timestamp
    expect(first?.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(first?.end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("assigns sequential numeric IDs", async () => {
    vi.stubGlobal("fetch", mockXMLTVFetch(SAMPLE_XMLTV));

    const entries = await parseXMLTV("http://example.com/xmltv.xml");

    const ids = entries.map((e) => Number(e.id));
    // IDs should be numeric and sequential
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(i + 1);
    }
  });

  it("rejects on non-200 HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve(""),
      }),
    );

    await expect(parseXMLTV("http://example.com/xmltv.xml")).rejects.toThrow(
      "503",
    );
  });

  it("rejects on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network unreachable")),
    );

    await expect(parseXMLTV("http://example.com/xmltv.xml")).rejects.toThrow(
      "Network unreachable",
    );
  });

  it("handles empty XMLTV document gracefully", async () => {
    const emptyXml = `<?xml version="1.0"?><tv></tv>`;
    vi.stubGlobal("fetch", mockXMLTVFetch(emptyXml));

    const entries = await parseXMLTV("http://example.com/xmltv.xml");

    expect(entries).toHaveLength(0);
  });

  it("skips programme entries missing channel or timestamps", async () => {
    const malformed = `<?xml version="1.0"?><tv>
      <programme start="20231015060000 +0000" stop="20231015070000 +0000">
        <title>No channel attr</title>
      </programme>
      <programme channel="cnn.us">
        <title>Missing timestamps</title>
      </programme>
      <programme start="20231015060000 +0000" stop="20231015070000 +0000" channel="valid.ch">
        <title>Valid entry</title>
      </programme>
    </tv>`;
    vi.stubGlobal("fetch", mockXMLTVFetch(malformed));

    const entries = await parseXMLTV("http://example.com/xmltv.xml");

    // Only the entry with all required fields should be included
    expect(entries).toHaveLength(1);
    expect(entries[0]?.channelId).toBe("valid.ch");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeXMLTVDate — indirect tests via parseXMLTV
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeXMLTVDate (via parseXMLTV)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles +0000 timezone offset", async () => {
    const xml = `<?xml version="1.0"?><tv>
      <programme start="20231015060000 +0000" stop="20231015070000 +0000" channel="ch1">
        <title>Test</title>
      </programme>
    </tv>`;
    vi.stubGlobal("fetch", mockXMLTVFetch(xml));

    const [entry] = await parseXMLTV("http://example.com/xmltv.xml");

    expect(entry?.start).toBe("2023-10-15T06:00:00+00:00");
    expect(entry?.end).toBe("2023-10-15T07:00:00+00:00");
  });

  it("handles non-UTC timezone offsets", async () => {
    const xml = `<?xml version="1.0"?><tv>
      <programme start="20231015060000 +0530" stop="20231015070000 +0530" channel="ch1">
        <title>IST show</title>
      </programme>
    </tv>`;
    vi.stubGlobal("fetch", mockXMLTVFetch(xml));

    const [entry] = await parseXMLTV("http://example.com/xmltv.xml");

    expect(entry?.start).toBe("2023-10-15T06:00:00+05:30");
  });
});
