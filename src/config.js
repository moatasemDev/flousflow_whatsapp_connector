"use strict";

const path = require("path");
const fs = require("fs");

require("dotenv").config();

const env = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};

const intEnv = (name, fallback) => {
  const value = parseInt(env(name, ""), 10);
  return Number.isFinite(value) ? value : fallback;
};

const boolEnv = (name, fallback) => {
  const value = env(name, "");
  if (value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const sessionKeys = () =>
  env("WHATSAPP_SESSIONS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const dataDir = env("CONNECTOR_DATA_DIR", path.join(__dirname, "..", "data"));

function ensureDirs() {
  for (const dir of [dataDir, path.join(dataDir, "sessions"), path.join(dataDir, "media")]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

const config = {
  // --- Odoo connection ---
  odooBaseUrl: env("ODOO_BASE_URL", "http://localhost:8069").replace(/\/+$/, ""),
  secret: env("FLOUSFLOW_WHATSAPP_CONNECTOR_SECRET", ""),

  // --- Sessions ---
  sessionKeys,
  dataDir,
  authDirFor: (key) => path.join(dataDir, "sessions", key.replace(/[^a-zA-Z0-9_-]/g, "_")),

  // --- Timing ---
  outboxPollSeconds: intEnv("OUTBOX_POLL_SECONDS", 2),
  heartbeatSeconds: intEnv("HEARTBEAT_SECONDS", 30),
  connectRetryMs: intEnv("CONNECT_RETRY_MS", 10000),
  qrReportEveryMs: intEnv("QR_REPORT_EVERY_MS", 10000),

  // --- Ban avoidance / rate limiting ---
  minSendDelayMs: intEnv("MIN_SEND_DELAY_MS", 1500),
  maxSendDelayMs: intEnv("MAX_SEND_DELAY_MS", 4000),
  maxSendsPerMinute: intEnv("MAX_SENDS_PER_MINUTE", 15),
  customerWindowHours: intEnv("CUSTOMER_WINDOW_HOURS", 24),

  // --- Attachment ---
  maxAttachmentBytes: intEnv("MAX_ATTACHMENT_BYTES", 10 * 1024 * 1024),

  // --- Logging ---
  logLevel: env("LOG_LEVEL", "info"),

  // --- Auto-update ---
  autoUpdateEnabled: boolEnv("AUTO_UPDATE_ENABLED", true),
  autoUpdateIntervalMs: intEnv("AUTO_UPDATE_INTERVAL_MS", 6 * 60 * 60 * 1000), // every 6h
};

ensureDirs();

module.exports = config;
