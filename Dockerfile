# TenacitOS - apptolast fork - Dockerfile
# Multi-stage build para Next.js 16 standalone con better-sqlite3 native module.
# Diseñado para correr como sidecar en el pod openclaw del cluster apptolast K8s.
#
# Stages:
#   1. deps    - install dependencies con build tools (python3, make, g++)
#   2. builder - build de Next.js (output: standalone)
#   3. runner  - imagen final minimal (Debian slim) corriendo como nextjs (uid 1000)

# ============================================================================
# Stage 1: deps - instalar dependencies con build tools nativos
# ============================================================================
FROM node:22-bookworm AS deps
WORKDIR /app

# Build tools necesarios para better-sqlite3 (native module)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      build-essential && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# ============================================================================
# Stage 2: builder - build Next.js standalone
# ============================================================================
FROM node:22-bookworm AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ============================================================================
# Stage 3: runner - imagen final minimal
# ============================================================================
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# Usuario no-root: el usuario 'node' ya existe en node:22-bookworm-slim
# con uid 1000:1000 — exactamente lo que necesitamos para compartir el PVC
# openclaw-data con el container openclaw del mismo pod (que tambien usa
# uid 1000 via securityContext.runAsUser y fsGroup).

# Copy standalone output (servidor minimal de Next.js)
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Copy native deps que serverExternalPackages excluye del bundle
# better-sqlite3 + bindings + file-uri-to-path son requeridos en runtime
COPY --from=builder --chown=node:node /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder --chown=node:node /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder --chown=node:node /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

# Copy data/ inicial (TenacitOS lo crea si no existe pero queremos el dir presente)
COPY --from=builder --chown=node:node /app/data ./data

USER node

EXPOSE 3000

# Healthcheck endpoint nativo de TenacitOS
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
