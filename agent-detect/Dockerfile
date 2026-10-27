# Demo app image (server/demo.js). Run it with compose.yaml, behind the nginx image; see deploy/DOCKER.md.
FROM node:24.22.1-alpine3.24

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DEMO_DB_PATH=/data/demo.db
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY client/agent-detect.js ./client/agent-detect.js

# /data holds the SQLite database (a volume); everything else stays read-only at run time.
RUN install -d -o node -g node /data
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/__agent').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/demo.js"]
