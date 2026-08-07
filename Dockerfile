# Flous Flow WhatsApp connector
FROM node:20-slim

# Some WhatsApp-client transitive dependencies install from git.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy source.
COPY src ./src
COPY scripts ./scripts
COPY .env.example ./.env.example
RUN chmod +x scripts/update-libs.sh

# Persistent data (Baileys auth state, media cache, update log).
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV APP_DIR=/app
ENV CONNECTOR_DATA_DIR=/app/data

CMD ["node", "src/index.js"]
