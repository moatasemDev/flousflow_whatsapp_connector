"use strict";

const { downloadMediaMessage, isJidGroup, isJidStatusBroadcast, extractMessageContent } =
  require("@whiskeysockets/baileys");

const config = require("./config");
const logger = require("./logger");
const odoo = require("./odoo");

/** 201012345678@s.whatsapp.net -> +201012345678  (matches Odoo normalize_phone) */
function toOdooPhone(remoteJid) {
  if (!remoteJid) return "";
  const digits = (remoteJid.split("@")[0] || "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/** +201012345678 -> 201012345678@s.whatsapp.net */
function toJid(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function extractText(msgContent) {
  const c = msgContent || {};
  if (typeof c.conversation === "string") return c.conversation;
  if (c.extendedTextMessage && typeof c.extendedTextMessage.text === "string") {
    return c.extendedTextMessage.text;
  }
  if (c.imageMessage && typeof c.imageMessage.caption === "string") return c.imageMessage.caption;
  if (c.documentMessage && typeof c.documentMessage.caption === "string") return c.documentMessage.caption;
  if (c.videoMessage && typeof c.videoMessage.caption === "string") return c.videoMessage.caption;
  return null;
}

function classifyMessage(msgContent) {
  const c = msgContent || {};
  if (c.conversation || c.extendedTextMessage) return { type: "text" };
  if (c.imageMessage) return { type: "image" };
  if (c.documentMessage) return { type: "document" };
  if (c.audioMessage) return { type: "audio" };
  if (c.videoMessage) return { type: "video" };
  if (c.stickerMessage) return { type: "sticker" };
  return { type: "other" };
}

async function mediaToPayload(session, msg, msgContent) {
  // Returns { content_base64, filename, mimetype } or {} if no media / video.
  const c = msgContent || {};
  const kind = classifyMessage(c).type;
  if (kind === "video") return {}; // Odoo stores video_metadata only (media policy).
  const target = c.imageMessage || c.documentMessage || c.audioMessage || c.stickerMessage;
  if (!target) return {};
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger });
    if (!buffer) return {};
    if (buffer.length > config.maxAttachmentBytes) return {};
    return {
      content_base64: buffer.toString("base64"),
      filename: target.fileName || target.mimetype || "whatsapp_media",
      mimetype: target.mimetype || "application/octet-stream",
    };
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to download inbound media");
    return {};
  }
}

/** Handle one upserted WhatsApp message (inbound or outbound echo). */
async function handleInboundUpsert(session, msg) {
  const key = msg.key || {};
  const remoteJid = key.remoteJid;
  if (!remoteJid || isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) return;
  if (remoteJid.endsWith("@broadcast") || remoteJid.endsWith("@newsletter")) return;

  const fullMessage = msg.message;
  if (!fullMessage || msg.messageStubType) return; // skip protocol/stub/system

  const msgContent = extractMessageContent(fullMessage);
  if (!msgContent) return;

  const externalMessageId = key.id;
  if (!externalMessageId) return;

  const phone = toOdooPhone(remoteJid);
  const { type } = classifyMessage(msgContent);
  const body = extractText(msgContent) || "";
  const media = await mediaToPayload(session, msg, msgContent);

  const base = {
    session_key: session.sessionKey,
    external_message_id: externalMessageId,
    source_jid: remoteJid,
    customer_phone_normalized: phone,
    customer_name: msg.pushName || undefined,
    message_type: type === "video" ? "video_metadata" : type === "other" || type === "sticker" ? "text" : type,
    body: body || (type === "video" ? "Incoming video was blocked by media policy." : undefined),
  };

  if (key.fromMe) {
    // Echo of a message we sent — Odoo uses it to de-duplicate.
    await odoo.sendEvent({ ...base, direction: "outbound" });
    return;
  }

  // Real inbound customer message.
  session.lastInboundAt.set(remoteJid, new Date());
  await odoo.sendEvent({ ...base, direction: "inbound", ...media });
}

/** Handle delivery/read receipts (messages.update). */
async function handleMessageUpdates(session, updates) {
  for (const update of updates) {
    const key = update.key || {};
    if (!key.id || !key.remoteJid || isJidGroup(key.remoteJid)) continue;
    const status = update.status; // Baileys status codes: 2 = delivered, 3 = read
    let state = null;
    if (status === 2) state = "delivered";
    else if (status === 3) state = "read";
    if (!state) continue;
    try {
      await odoo.sendReceipt(session.sessionKey, state, key.id);
    } catch (err) {
      logger.warn({ err: err.message, id: key.id }, "Failed to send receipt to Odoo");
    }
  }
}

// ---------------------------------------------------------------- outbound ---

class RateLimiter {
  constructor(session) {
    this.session = session;
    this.queue = [];
    this.sending = false;
    this.sentInWindow = [];
  }

  _canSend() {
    const now = Date.now();
    this.sentInWindow = this.sentInWindow.filter((t) => now - t < 60000);
    return this.sentInWindow.length < config.maxSendsPerMinute;
  }

  _randomDelay() {
    return config.minSendDelayMs + Math.random() * (config.maxSendDelayMs - config.minSendDelayMs);
  }

  push(fn) {
    this.queue.push(fn);
    this._drain();
  }

  async _drain() {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        if (!this._canSend()) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const fn = this.queue.shift();
        try {
          await fn();
          this.sentInWindow.push(Date.now());
        } catch (err) {
          logger.error({ err: err.message }, "Outbound send task failed");
        }
        await new Promise((r) => setTimeout(r, this._randomDelay()));
      }
    } finally {
      this.sending = false;
    }
  }
}

/** Send one claimed Odoo outbound message through the WhatsApp socket. */
async function sendOutbound(session, claimed) {
  if (!session.socket || !session.connected) {
    await odoo.ackOutbound(claimed.id, session.sessionKey, "failed", {
      error_code: "connector_disconnected",
      error_summary: "WhatsApp session is not connected.",
    });
    return;
  }

  const jid = toJid(claimed.customer_phone);
  if (!jid) {
    await odoo.ackOutbound(claimed.id, session.sessionKey, "failed", {
      error_code: "invalid_phone",
      error_summary: "Invalid customer phone number.",
    });
    return;
  }

  // 24-hour customer-service window (ban avoidance): only message customers who
  // have written recently, unless the setting is disabled (0).
  if (config.customerWindowHours > 0) {
    const lastInbound = session.lastInboundAt.get(jid);
    if (!lastInbound) {
      await odoo.ackOutbound(claimed.id, session.sessionKey, "failed", {
        error_code: "outside_window",
        error_summary: `No recent inbound message; outside the ${config.customerWindowHours}h customer-service window.`,
      });
      return;
    }
    const ageHours = (Date.now() - lastInbound.getTime()) / 3600000;
    if (ageHours > config.customerWindowHours) {
      await odoo.ackOutbound(claimed.id, session.sessionKey, "failed", {
        error_code: "outside_window",
        error_summary: `Last inbound message is ${Math.round(ageHours)}h old; outside the window.`,
      });
      return;
    }
  }

  // Build Baileys content.
  let content;
  try {
    content = await buildContent(session, claimed);
  } catch (err) {
    await odoo.ackOutbound(claimed.id, session.sessionKey, "failed", {
      error_code: "build_content_failed",
      error_summary: err.message,
    });
    return;
  }

  const limiter = (session._limiter ||= new RateLimiter(session));
  limiter.push(async () => {
    try {
      const sent = await session.socket.sendMessage(jid, content, {});
      const externalId = sent?.key?.id || null;
      await odoo.ackOutbound(claimed.id, session.sessionKey, "sent", {
        external_message_id: externalId,
      });
      logger.info({ msgId: claimed.id, jid, externalId }, "Outbound message sent");
    } catch (err) {
      await odoo.ackOutbound(claimed.id, session.sessionKey, "failed", {
        error_code: "send_error",
        error_summary: String(err.message || err).slice(0, 500),
      });
    }
  });
}

async function buildContent(session, claimed) {
  const type = claimed.message_type;
  const body = claimed.body || "";
  if (type === "text" || !type) {
    return { text: body };
  }
  if (!claimed.attachment_id) {
    return { text: body || "(attachment)" };
  }
  const att = await odoo.getAttachment(claimed.attachment_id, session.sessionKey);
  if (!att || !att.content_base64) {
    throw new Error("Attachment could not be downloaded from Odoo.");
  }
  const buffer = Buffer.from(att.content_base64, "base64");
  const mimetype = att.mimetype || "application/octet-stream";
  const fileName = att.name || "file";
  if (type === "image") {
    return { image: buffer, mimetype, caption: body || undefined };
  }
  if (type === "audio") {
    return { audio: buffer, mimetype, ptt: mimetype === "audio/ogg" };
  }
  if (type === "document") {
    return { document: buffer, mimetype, fileName, caption: body || undefined };
  }
  return { text: body };
}

module.exports = {
  handleInboundUpsert,
  handleMessageUpdates,
  sendOutbound,
  toOdooPhone,
  toJid,
};
