"use strict";

const crypto = require("crypto");

const TIMESTAMP_HEADER = "X-FlousFlow-Timestamp";
const NONCE_HEADER = "X-FlousFlow-Nonce";
const SIGNATURE_HEADER = "X-FlousFlow-Signature";

/**
 * Sign an Odoo-bound JSON payload with the shared connector secret.
 * Matches odoo/addons/.../controllers/signing.py `verify_signed_request`:
 *   canonical = timestamp \n nonce \n raw_body
 *   signature = HMAC-SHA256(secret, canonical).hexdigest()
 *
 * Returns { headers, body } where body is the exact string that was signed.
 */
function sign(secret, payload) {
  if (!secret) {
    throw new Error("Connector secret is not configured (FLOUSFLOW_WHATSAPP_CONNECTOR_SECRET).");
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const canonical = `${timestamp}\n${nonce}\n${body}`;
  const signature = crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
  return {
    headers: {
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
      [SIGNATURE_HEADER]: signature,
      "Content-Type": "application/json",
    },
    body,
  };
}

module.exports = { sign, TIMESTAMP_HEADER, NONCE_HEADER, SIGNATURE_HEADER };
