# syntax=docker/dockerfile:1.7
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
RUN npm install --global pnpm@12.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
COPY cli.js ./
RUN pnpm build && pnpm prune --prod

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    COURT_ALLOW_LIVE_MN=false \
    COURT_STORAGE_DIR=/var/lib/court \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp/court-home
WORKDIR /app
# Bootstrap HTTPS trust through the base image's Debian archive-keyring-verified
# repositories. Do not disable TLS verification or apt signature verification.
# Then freeze PDF/OCR/browser package resolution to the dated HTTPS snapshot.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261101T000000Z bookworm main\ndeb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261101T000000Z bookworm-security main\n' > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates poppler-utils tesseract-ocr tesseract-ocr-eng tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules/
RUN node node_modules/playwright/cli.js install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/* /root/.cache \
    && mkdir -p /var/lib/court \
    && chown node:node /var/lib/court
COPY --from=build /app/dist ./dist/
# JS adapter imports and JSON assets remain available alongside compiled platform code.
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY test/fixtures/adapters/ ./test/fixtures/adapters/
COPY infra/healthcheck.mjs ./infra/healthcheck.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "infra/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/platform/api.js"]
