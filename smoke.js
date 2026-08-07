// Live smoke test: verifies the connector's HMAC signing and Odoo client
// against a real Odoo test server with the shared secret.
process.env.ODOO_BASE_URL = process.env.ODOO_BASE_URL || "http://localhost:8079";
process.env.FLOUSFLOW_WHATSAPP_CONNECTOR_SECRET =
  process.env.FLOUSFLOW_WHATSAPP_CONNECTOR_SECRET || "flousflow-e2e-test-secret-2026";
process.env.WHATSAPP_SESSIONS = process.env.WHATSAPP_SESSIONS || "connector-smoke-1";

const config = require("./src/config");
const odoo = require("./src/odoo");
const { sign } = require("./src/signer");

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

(async () => {
  console.log("== Connector live smoke test ==");
  console.log("odoo base:", config.odooBaseUrl);
  console.log("sessions:", config.sessionKeys());
  console.log("secret set:", Boolean(config.secret));

  // 1) Signer shape
  const s = sign(config.secret, { session_key: "connector-smoke-1", state: "qr", qr_image: PNG_1PX });
  console.log("signer headers present:",
    Boolean(s.headers["X-FlousFlow-Timestamp"] && s.headers["X-FlousFlow-Nonce"] && s.headers["X-FlousFlow-Signature"]));

  // 2) Report a QR state -> Odoo must accept and store it
  const res = await odoo.reportSession("connector-smoke-1", { state: "qr", qrImage: PNG_1PX });
  console.log("reportSession(qr) ->", JSON.stringify(res));

  // 3) Report connected -> state + last_connected_at
  const res2 = await odoo.reportSession("connector-smoke-1", { state: "connected" });
  console.log("reportSession(connected) ->", JSON.stringify(res2));

  // 4) Claim outbox (should be empty but accepted)
  const claimed = await odoo.claimOutbox("connector-smoke-1", 10);
  console.log("claimOutbox ->", JSON.stringify(claimed));

  console.log("== SMOKE TEST PASSED ==");
  process.exit(0);
})().catch((err) => {
  console.error("SMOKE TEST FAILED:", err.status, err.code, err.message);
  process.exit(1);
});
