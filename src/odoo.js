"use strict";

const axios = require("axios");
const { sign } = require("./signer");
const config = require("./config");
const logger = require("./logger");

const BASE = "/flousflow/whatsapp/v1";

class OdooClient {
  constructor() {
    this.baseUrl = config.odooBaseUrl;
    this.secret = config.secret;
  }

  async _post(route, payload, { silent = false } = {}) {
    const { headers, body } = sign(this.secret, payload);
    let res;
    try {
      res = await axios.post(this.baseUrl + route, body, {
        headers,
        timeout: 30000,
        validateStatus: () => true,
        maxContentLength: 32 * 1024 * 1024,
      });
    } catch (err) {
      logger.error({ route, err: err.message }, "Odoo request failed");
      throw err;
    }
    const data = res.data || {};
    if (res.status < 200 || res.status >= 300) {
      const message = data.message || data.error || `HTTP ${res.status}`;
      if (!silent) {
        logger.warn({ route, status: res.status, error: data.error, message }, "Odoo returned error");
      }
      const error = new Error(`Odoo ${res.status}: ${message}`);
      error.status = res.status;
      error.code = data.error;
      throw error;
    }
    return data;
  }

  /** Report a connector session state (qr / connecting / connected / reconnect / error). */
  reportSession(sessionKey, { state, qrImage = null, errorSummary = null } = {}) {
    const payload = { session_key: sessionKey, state };
    if (qrImage !== null && qrImage !== undefined) payload.qr_image = qrImage;
    if (errorSummary) payload.error_summary = String(errorSummary).slice(0, 1000);
    return this._post(`${BASE}/sessions/${encodeURIComponent(sessionKey)}/status`, payload);
  }

  /** Push an inbound (or outbound-echo) WhatsApp event to Odoo. */
  sendEvent(payload) {
    return this._post(`${BASE}/events`, payload, { silent: true });
  }

  /** Claim queued outbound messages for a session. */
  async claimOutbox(sessionKey, limit = 20) {
    const data = await this._post(`${BASE}/outbox/claim`, { session_key: sessionKey, limit });
    return data.messages || [];
  }

  /** Acknowledge an outbound message (sent / delivered / read / failed). */
  ackOutbound(messageId, sessionKey, state, extras = {}) {
    const payload = { session_key: sessionKey, state, ...extras };
    return this._post(`${BASE}/outbox/${messageId}/ack`, payload);
  }

  /** Report a delivery / read receipt by external WhatsApp message id. */
  sendReceipt(sessionKey, state, externalMessageId) {
    return this._post(`${BASE}/outbox/receipt`, {
      session_key: sessionKey,
      state,
      external_message_id: externalMessageId,
    });
  }

  /** Download the binary attachment for an outbound message. */
  async getAttachment(attachmentId, sessionKey) {
    const data = await this._post(`${BASE}/attachments/${attachmentId}`, { session_key: sessionKey });
    return data;
  }
}

module.exports = new OdooClient();
