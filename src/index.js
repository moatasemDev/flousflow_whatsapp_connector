"use strict";

const { execFile } = require("child_process");
const path = require("path");

const config = require("./config");
const logger = require("./logger");
const { WhatsAppSession } = require("./wa");
const { startOutboxPoller } = require("./outbox");

const sessions = new Map();

function runUpdateScript() {
  const script = path.join(__dirname, "..", "scripts", "update-libs.sh");
  logger.info("Running WhatsApp library auto-update");
  execFile("bash", [script], { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
    if (err) {
      logger.warn({ err: err.message, stderr }, "Library auto-update failed");
      return;
    }
    logger.info({ stdout }, "Library auto-update completed");
  });
}

function startAutoUpdate() {
  if (!config.autoUpdateEnabled) {
    logger.info("Auto-update of WhatsApp libraries is disabled");
    return () => {};
  }
  runUpdateScript();
  const timer = setInterval(runUpdateScript, config.autoUpdateIntervalMs);
  return () => clearInterval(timer);
}

async function main() {
  const keys = config.sessionKeys();
  if (keys.length === 0) {
    logger.error(
      "No WhatsApp sessions configured. Set WHATSAPP_SESSIONS (comma-separated connector session keys)."
    );
    process.exit(1);
  }
  if (!config.secret) {
    logger.error("Connector secret missing: set FLOUSFLOW_WHATSAPP_CONNECTOR_SECRET.");
    process.exit(1);
  }

  for (const key of keys) {
    const session = new WhatsAppSession(key);
    sessions.set(key, session);
    session.start().catch((err) => logger.error({ err: err.message }, "Session start failed"));
  }

  const stopOutbox = startOutboxPoller(sessions);
  const stopUpdate = startAutoUpdate();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    stopOutbox();
    stopUpdate();
    for (const session of sessions.values()) {
      if (session.socket) {
        try {
          session.socket.end(undefined);
        } catch (_) {
          /* ignore */
        }
      }
    }
    // Give sockets a moment to flush, then exit so Docker can restart us.
    setTimeout(() => process.exit(0), 800);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info({ sessions: keys, odoo: config.odooBaseUrl }, "Flous Flow WhatsApp connector started");
}

main().catch((err) => {
  logger.error({ err: err.message }, "Fatal startup error");
  process.exit(1);
});
