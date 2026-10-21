# syntax=docker/dockerfile:1

# Debian (glibc) with the same Node as CI: @confluentinc/kafka-javascript downloads a
# prebuilt librdkafka binary that must match the runtime's Node ABI, libc and architecture
FROM node:22-bookworm-slim AS base

WORKDIR /app


# Compiles TypeScript and rewrites the #/ alias; the native install scripts aren't needed for that
FROM base AS build

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


# Production dependencies only, including the native Kafka client
FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force


FROM base AS production

ENV NODE_ENV=production

RUN groupadd --system --gid 10001 app && \
    useradd --system --uid 10001 --gid app --no-create-home --home-dir /app app

# Owned by root: the app user can read the code but not change it
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# For `npm run migrate up`, run with the image before starting a new version
COPY migrations ./migrations

# Tag or commit SHA, reported as service.version in logs and traces:
# docker build --target production --build-arg SERVICE_VERSION=$(git rev-parse --short HEAD) .
ARG SERVICE_VERSION=dev
ENV SERVICE_VERSION=${SERVICE_VERSION}

USER app

EXPOSE 3173

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HTTP_PORT || 3173) + '/health').then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1))"]

# The settings are validated on startup: anything missing exits with a message naming it
CMD ["node", "-r", "./dist/instrumentation.js", "dist/server.js"]
