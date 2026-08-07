"use strict";

const config = require("./config");
const logger = require("./logger");
const odoo = require("./odoo");

/**
 * Poll Odoo's outbox for every connected session and dispatch the claimed
 * messages through the WhatsApp socket. Claims are only taken for sessions
 * that are currently connected so queued messages are not lost while pairing.
 */
function startOutboxPoller(sessions) {
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const session of sessions.values()) {
        if (!session.connected) continue;
        try {
          const claimed = await odoo.claimOutbox(session.sessionKey, 20);
          for (const message of claimed) {
            await session.send(message);
          }
        } catch (err) {
          if (err.code === "unknown_session") {
            logger.warn({ session: session.sessionKey }, "Session unknown in Odoo; skipping");
            continue;
          }
          logger.debug({ session: session.sessionKey, err: err.message }, "Outbox claim failed");
        }
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, config.outboxPollSeconds * 1000);
  tick().catch((err) => logger.error({ err: err.message }, "Outbox poller crashed"));

  return () => clearInterval(timer);
}

module.exports = { startOutboxPoller };
