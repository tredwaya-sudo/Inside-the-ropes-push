import "dotenv/config";
import express from "express";
import path from "node:path";
import { ApnsSender, loadApnsKeyFromEnv } from "./apns.js";
import { ClippdClient } from "./clippd.js";
import { PushDb } from "./db.js";
import { createRouter } from "./routes.js";
import { PollWorker } from "./worker.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATABASE_PATH =
  process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "push.sqlite");
const CLIPPD_HOST =
  process.env.CLIPPD_HOST ?? "https://scoreboard.clippd.com";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const APNS_DRY_RUN =
  (process.env.APNS_DRY_RUN ?? "false").toLowerCase() === "true";

const db = new PushDb(DATABASE_PATH);

const apnsKey = loadApnsKeyFromEnv(process.env);
const hasApnsCreds =
  !!apnsKey &&
  !!process.env.APNS_KEY_ID &&
  !!process.env.APNS_TEAM_ID &&
  !!process.env.APNS_BUNDLE_ID;

if (!hasApnsCreds && !APNS_DRY_RUN) {
  console.warn(
    "[boot] APNs credentials missing — enabling dry-run. Set APNS_* or APNS_DRY_RUN=true."
  );
}

const apns = new ApnsSender(
  {
    keyId: process.env.APNS_KEY_ID ?? "MISSING",
    teamId: process.env.APNS_TEAM_ID ?? "K95LALRF9A",
    bundleId:
      process.env.APNS_BUNDLE_ID ?? "com.insidetheropes.InsideTheRopes",
    key: apnsKey ?? "-----BEGIN PRIVATE KEY-----\nMISSING\n-----END PRIVATE KEY-----",
    production: (process.env.APNS_PRODUCTION ?? "false").toLowerCase() === "true",
    dryRun: APNS_DRY_RUN || !hasApnsCreds,
  },
  (token, reason, kind) => {
    if (kind === "liveactivity") {
      console.warn(`[apns] dropping LA token ${token.slice(0, 8)}… (${reason})`);
      db.deleteLiveActivityByActivityToken(token);
      return;
    }
    console.warn(`[apns] dropping device ${token.slice(0, 8)}… (${reason})`);
    db.deleteDevice(token);
  }
);

const clippd = new ClippdClient({ host: CLIPPD_HOST });
const worker = new PollWorker({
  db,
  clippd,
  apns,
  intervalMs: POLL_INTERVAL_MS,
});

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(createRouter(db));

/** Manual APNs probe — body optional { "deviceToken": "..." }. */
app.post("/v1/debug/notify", async (req, res) => {
  const token =
    (typeof req.body?.deviceToken === "string" && req.body.deviceToken) ||
    db.listDevices()[0]?.deviceToken;
  if (!token) {
    res.status(404).json({ error: "no device registered" });
    return;
  }
  const ok = await apns.send({
    deviceToken: token,
    title: "Inside the Ropes",
    body: "Manual debug push from server.",
    threadId: "debug",
    notificationId: `debug-${Date.now()}`,
  });
  res.json({
    ok,
    tokenPrefix: token.slice(0, 8),
    lastError: apns.lastError,
    dryRun: APNS_DRY_RUN || !hasApnsCreds,
    production: (process.env.APNS_PRODUCTION ?? "false").toLowerCase() === "true",
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[boot] listening on http://${HOST}:${PORT}`);
  console.log(`[boot] db=${DATABASE_PATH} clippd=${CLIPPD_HOST}`);
  worker.start();
});

async function shutdown(signal: string) {
  console.log(`[boot] ${signal} — shutting down`);
  worker.stop();
  await apns.shutdown();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
