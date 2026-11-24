"use strict";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidGroup,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");

const config = require("./config");
const logger = require("./logger");
const odoo = require("./odoo");
const { handleInboundUpsert, handleMessageUpdates, sendOutbound } = require("./handlers");

class WhatsAppSession {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
    this.socket = null;
    this.lastQr = null;
    this.lastQrReportedAt = 0;
    this.connecting = false;
    this.connected = false;
    this.retryTimer = null;
    // Track last inbound per chat (for the 24h customer-service window).
    this.lastInboundAt = new Map(); // remoteJid -> Date
    // Map phone digits -> real remoteJid (…@lid or …@s.whatsapp.net).
    // WhatsApp may identify a contact by LID while Odoo stores only the
    // digits; without this map, outbound sends and window checks derive
    // …@s.whatsapp.net from the digits and never match the …@lid inbound,
    // so every reply to a LID contact fails with outside_window.
    this.jidByPhone = new Map(); // digits -> remoteJid
  }

  get authDir() {
    return config.authDirFor(this.sessionKey);
  }

  async start() {
    logger.info({ session: this.sessionKey }, "Starting WhatsApp session");
    await this.connect();
    // Send a heartbeat to Odoo so the number reflects reality if we are up but
    // the socket is idle. The outbox poller also acts as a liveness signal.
  }

  async connect() {
    if (this.connecting) return;
    this.connecting = true;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();
      const socket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger: logger.child({ session: this.sessionKey, component: "baileys" }),
        printQRInTerminal: false,
        browser: ["FlousFlow", "Chrome", "20.0.04"],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });
      this.socket = socket;

      socket.ev.on("connection.update", (update) => this._onConnectionUpdate(update));
      socket.ev.on("creds.update", saveCreds);
      socket.ev.on("messages.upsert", (payload) => this._onMessagesUpsert(payload));
      socket.ev.on("messages.update", (updates) => handleMessageUpdates(this, updates));
    } catch (err) {
      logger.error({ session: this.sessionKey, err: err.message }, "Failed to start Baileys socket");
      this._scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  async _onConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      this.lastQr = qr;
      await this._reportQr(qr);
    }
    if (connection === "connecting") {
      this.connected = false;
      await this._safeReport("connecting");
    } else if (connection === "open") {
      this.connected = true;
      this.lastQr = null;
      logger.info({ session: this.sessionKey }, "WhatsApp connected");
      await this._safeReport("connected");
    } else if (connection === "close") {
      this.connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ session: this.sessionKey, statusCode }, "WhatsApp connection closed");
      if (statusCode === DisconnectReason.loggedOut) {
        // Credentials are gone; the number must be re-paired.
        this.socket = null;
        await this._safeReport("disabled", "Session was logged out; scan the QR again.");
        await this._clearAuthAndRestart();
        return;
      }
      const shouldReconnect =
        statusCode === DisconnectReason.connectionClosed ||
        statusCode === DisconnectReason.connectionLost ||
        statusCode === DisconnectReason.restartRequired ||
        statusCode === DisconnectReason.timedOut ||
        statusCode === undefined ||
        statusCode === DisconnectReason.badSession;
      if (shouldReconnect) {
        await this._safeReport("reconnect", "Connection lost; reconnecting.");
        this._scheduleReconnect();
      } else {
        await this._safeReport("error", lastDisconnect?.error?.message || `Disconnected (${statusCode})`);
        this._scheduleReconnect();
      }
    }
  }

  async _reportQr(qr) {
    const now = Date.now();
    if (now - this.lastQrReportedAt < config.qrReportEveryMs) return;
    this.lastQrReportedAt = now;
    try {
      const png = await QRCode.toBuffer(qr, { type: "png", width: 512, margin: 2 });
      const qrImage = png.toString("base64");
      await odoo.reportSession(this.sessionKey, { state: "qr", qrImage });
      logger.debug({ session: this.sessionKey }, "QR image reported to Odoo");
    } catch (err) {
      logger.warn({ session: this.sessionKey, err: err.message }, "Failed to report QR to Odoo");
    }
  }

  async _safeReport(state, errorSummary) {
    try {
      await odoo.reportSession(this.sessionKey, { state, errorSummary });
    } catch (err) {
      logger.warn({ session: this.sessionKey, state, err: err.message }, "Failed to report session state");
    }
  }

  _scheduleReconnect() {
    if (this.retryTimer) return;
    logger.info({ session: this.sessionKey }, `Reconnecting in ${config.connectRetryMs}ms`);
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      await this.connect();
    }, config.connectRetryMs);
  }

  async _clearAuthAndRestart() {
    // Remove the stale credentials so a fresh QR is issued, then reconnect.
    const fs = require("fs");
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch (_) {
        /* ignore */
      }
      this.socket = null;
    }
    this._scheduleReconnect();
  }

  async _onMessagesUpsert({ messages, type }) {
    if (type !== "notify" && type !== "append") return;
    for (const msg of messages) {
      await handleInboundUpsert(this, msg);
    }
  }

  /** Send one outbound message that was claimed from Odoo. */
  async send(claimed) {
    return sendOutbound(this, claimed);
  }
}

module.exports = { WhatsAppSession };
