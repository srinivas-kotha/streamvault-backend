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

// Placeholder routers — Phase 2/3
import streamRouter from "./routers/stream.router";
import downloadsRouter from "./routers/downloads.router";
import recordingsRouter from "./routers/recordings.router";
import settingsRouter from "./routers/settings.router";
import eventsRouter from "./routers/events.router";

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
app.use("/api", searchRouter);
app.use("/api/favorites", favoritesRouter);
app.use("/api/history", historyRouter);
app.use("/api/downloads", downloadsRouter);
app.use("/api/recordings", recordingsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api", eventsRouter);
app.use("/api/account", accountRouter);

// --- Error handler (must be last) ---
app.use(errorHandler);

// --- Startup ---
async function startServer(): Promise<void> {
  try {
    // Recover interrupted downloads
    await recoverDownloadQueue();

    // Kill orphaned FFmpeg processes from previous run
    killAllFFmpeg();

    // Initialize stream provider
    const provider = initProvider();

    // Start Phase 3 background services
    startCatalogSync(provider);
    startEPGRefresh(provider);

    const server = app.listen(config.port, () => {
      console.log(`StreamVault API listening on port ${config.port}`);
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
