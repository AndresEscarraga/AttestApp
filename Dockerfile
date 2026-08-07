# syntax=docker/dockerfile:1
# Attest — Fly.io deployment
FROM node:22-alpine

WORKDIR /app

# SQLite build dependencies for better-sqlite3 on Alpine
RUN apk add --no-cache build-base python3

RUN mkdir -p data Reports && chown node:node data Reports

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev
# Force rebuild native module for this architecture
RUN npm rebuild better-sqlite3

# Copy app source
# Copy app source (cache bust: v4)
COPY server.js logStore.js adminUserStore.js activityStore.js dataStore.js fileSafety.js db.js ./
COPY public ./public
COPY Reports ./Reports
COPY scripts ./scripts

# Fly.io PORT
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_STORE=local
ENV REPORTS_DIR=/app/Reports
ENV DB_PATH=/app/data/attest.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node
CMD ["node", "server.js"]
