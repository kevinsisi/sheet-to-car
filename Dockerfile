# ── Stage 1: Build ──────────────────────────────────────────
FROM node:22-bookworm AS builder

ARG INTERNAL_GIT_MIRROR=""
WORKDIR /app

# Native build tools for better-sqlite3 + git for dependencies
RUN apt-get update && apt-get install -y python3 make g++ git curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Configure git redirect if internal mirror is provided
RUN if [ -n "$INTERNAL_GIT_MIRROR" ]; then \
      git config --global url."${INTERNAL_GIT_MIRROR}".insteadOf "https://github.com/kevinsisi/"; \
    fi

COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# ── Stage 2: Production ────────────────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y git curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && rm -rf /root/.npm

COPY --from=builder /app/dist dist/
COPY src/db/migrations dist/db/migrations/
COPY src/prompts dist/prompts/
COPY src/public dist/public/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "dist/index.js"]
