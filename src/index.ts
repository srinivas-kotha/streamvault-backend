import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { config } from "./config";
import { corsMiddleware } from "./middleware/cors";
import { csrfMiddleware } from "./middleware/csrf";
import { apiLimiter, streamLimiter } from "./middleware/rateLimiter";
import { errorHandler } from "./middleware/errorHandler";
import { closePool } from "./services/db.service";
import { recoverDownloadQueue } from "./services/download.service";
import { killAllFFmpeg } from "./utils/ffmpeg";
import { initProvider } from "./providers";
import { startCatalogSync } from "./services/catalog.service";
import { startEPGRefresh } from "./services/epg.service";
import { startCacheWarmup } from "./services/warmup.service";

// Router imports — built by other agents
import authRouter from "./routers/auth.router";
import liveRouter from "./routers/live.router";
import vodRouter from "./routers/vod.router";
import seriesRouter from "./routers/series.router";
import searchRouter from "./routers/search.router";
import favoritesRouter from "./routers/favorites.router";
import historyRouter from "./routers/history.router";
import healthRouter from "./routers/health.router";

// Phase 3 routers
import accountRouter from "./routers/account.router";

// CEO Dashboard routers
import alertsRouter from "./routers/alerts.router";

import audioTracksRouter from "./routers/audio-tracks.router";

// Adaptive responsive (Phase 1)
import configRouter from "./routers/config.router";

// Placeholder routers — Phase 2/3
import streamRouter from "./routers/stream.router";
import downloadsRouter from "./routers/downloads.router";
import recordingsRouter from "./routers/recordings.router";
import settingsRouter from "./routers/settings.router";
import eventsRouter from "./routers/events.router";

// Last-resort safety net. Crashed the API process in prod 2026-04-28: an
// AbortError from a stream-body pump escaped every local catch when a client
// disconnected mid-stream. Per-call defenses live in vod-flight.service +
// stream.router, but Node's default unhandled-rejection handler is "exit
// process" — log and continue instead so a single rogue request can't take
// the whole API down for the catalog-resync window (~90s).
process.on("unhandledRejection", (reason) => {
  const msg =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : String(reason);
  console.error("[unhandledRejection]", msg);
});

const app = express();

// Trust first proxy (Nginx Proxy Manager) — fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set("trust proxy", 1);

// --- Global middleware ---
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
        mediaSrc: ["'self'", "blob:", "https:", "http:"],
        connectSrc: ["'self'", "https:", "http:"],
        fontSrc: ["'self'", "data:"],
      },
    },
  }),
);
app.use(corsMiddleware);
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(csrfMiddleware);

// --- Stream routes (higher rate limit — HLS generates many segment requests) ---
app.use("/api/stream", streamLimiter, streamRouter);

// --- Rate limiter (applied to all routes except /api/stream) ---
app.use(apiLimiter);

// --- Route mounts ---
app.use("/", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/live", liveRouter);
app.use("/api/vod", vodRouter);
app.use("/api/series", seriesRouter);
// Search router defines router.get("/"), so mount at /api/search — not /api.
// Previous mount at /api had the router match only /api/ itself; any
// /api/search?q=... request fell through to the /api catch-all events
// router and returned 501. Fixed 2026-04-22 after live-site smoke found
// Search screen was empty.
app.use("/api/search", searchRouter);
app.use("/api/favorites", favoritesRouter);
app.use("/api/history", historyRouter);
app.use("/api/downloads", downloadsRouter);
app.use("/api/recordings", recordingsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/account", accountRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/audio-tracks", audioTracksRouter);
app.use("/api/config", configRouter);
// IMPORTANT: events router is the /api/* 404 catchall (`router.all('*')`).
// It MUST be mounted LAST among /api routers — anything that follows it
// will never receive requests because the catchall terminates with 404
// before next() is called. Three routers (account, alerts, audio-tracks)
// silently 404'd in prod because they had been mounted after this line.
app.use("/api", eventsRouter);

// --- Error handler (must be last) ---
app.use(errorHandler);

// --- Startup ---
async function startServer(): Promise<void> {
  try {
    // Recover interrupted downloads
    await recoverDownloadQueue();

    // Kill orphaned FFmpeg processes from previous run
    killAllFFmpeg();

    // Initialize stream provider (config passed explicitly for testability)
    const provider = initProvider(config);

    // Start Phase 3 background services
    startCatalogSync(provider);
    startEPGRefresh(provider);

    const server = app.listen(config.port, () => {
      console.log(`StreamVault API listening on port ${config.port}`);
      // ADR-009: prime Xtream cache + start TTL pre-refresh AFTER the server
      // is accepting connections — warmup is non-blocking and must never
      // delay the listen socket.
      startCacheWarmup(provider);
    });

    // --- Graceful shutdown ---
    const shutdown = async (signal: string): Promise<void> => {
      console.log(`Shutting down... (${signal})`);
      killAllFFmpeg();
      await closePool();
      server.close(() => {
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    console.error("[startup] Fatal error:", (err as Error).message);
    process.exit(1);
  }
}

startServer();

export { app };
