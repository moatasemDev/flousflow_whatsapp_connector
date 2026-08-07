#!/usr/bin/env bash
#
# Flous Flow WhatsApp connector — automatic library updater.
#
# WhatsApp frequently changes its protocol; outdated Baileys versions are a
# leading cause of number bans and disconnections. This script:
#   1. updates the WhatsApp client library (and helpers) to the latest release
#   2. applies low-risk security fixes
#   3. records the update and restarts the connector so the new library loads
#
# The container is expected to run with `restart: unless-stopped`, so exiting
# the main process (kill -TERM 1) makes Docker start it again with the new code.
set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
LOG_DIR="${APP_DIR}/data"
LOG_FILE="${LOG_DIR}/lib-updates.log"

mkdir -p "${LOG_DIR}"

echo "=== [$(date -Is)] Running WhatsApp library auto-update ===" | tee -a "${LOG_FILE}"

cd "${APP_DIR}"

BEFORE=$(node -e "console.log(require('@whiskeysockets/baileys/package.json').version)" 2>/dev/null || echo "unknown")

echo "Baileys before: ${BEFORE}" | tee -a "${LOG_FILE}"

# Update the WhatsApp client library and helper packages.
npm install @whiskeysockets/baileys@latest qrcode@latest 2>>"${LOG_FILE}" || {
  echo "npm install failed — keeping previous version" | tee -a "${LOG_FILE}"
  exit 0
}

# Low-risk security patches only (never --force, to avoid breaking changes).
npm audit fix --audit-level=high 2>>"${LOG_FILE}" || true

AFTER=$(node -e "console.log(require('@whiskeysockets/baileys/package.json').version)" 2>/dev/null || echo "unknown")

echo "Baileys after: ${AFTER}" | tee -a "${LOG_FILE}"

if [ "${BEFORE}" != "${AFTER}" ]; then
  echo "Library updated (${BEFORE} -> ${AFTER}); restarting connector" | tee -a "${LOG_FILE}"
  # Restart the container's main process so the new library is loaded.
  kill -TERM 1
else
  echo "No update needed" | tee -a "${LOG_FILE}"
fi
