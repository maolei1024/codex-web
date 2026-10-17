# syntax=docker/dockerfile:1
FROM node:22.22.0-bookworm-slim AS node-toolchain

# The installer tests require Python's safe tar extraction filters. Keep both
# build and runtime on Bookworm so native Node addons retain the same ABI.
FROM python:3.12.15-slim-bookworm AS build-dependencies
COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node
COPY --from=node-toolchain /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip patch make g++ git \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -c 'import tarfile; assert callable(tarfile.data_filter)'

FROM build-dependencies AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY . .
RUN npm ci && npm test \
    && npm prune --omit=dev --ignore-scripts \
    && rm -rf scratch/ChatGPT.app

FROM node-toolchain AS runtime
COPY --from=build /app/local-build.json /app/local-build.json
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git openssh-client ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@$(node -p 'require("/app/local-build.json").codexCliVersion')" \
    && npm cache clean --force
WORKDIR /app
COPY --from=build /app/package.json /app/local-build.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/scratch/asar ./scratch/asar
COPY --from=build /app/src/server ./src/server
COPY scripts/container-init.mjs scripts/container-entrypoint ./scripts/
ENV NODE_ENV=production \
    HOME=/data/home \
    CODEX_HOME=/data/codex \
    CODEX_CLI_PATH=/usr/local/bin/codex \
    CODEX_WEB_DATA_DIR=/data/app \
    CODEX_ELECTRON_USER_DATA_PATH=/data/app/userData \
    CODEX_WEB_DOCUMENTS_DIR=/data/documents \
    CODEX_WEB_UPLOAD_ROOT=/data/uploads
RUN mkdir /data && chown node:node /data && usermod -d /data/home node
USER node
# Exercise the actual packaged application and target-native addons before push.
RUN --mount=type=bind,source=.ci/smoke-container.mjs,target=/app/smoke-container.mjs \
    --mount=type=bind,source=test/desktop-app-host-harness.mjs,target=/app/desktop-app-host-harness.mjs \
    --mount=type=bind,source=test/desktop-chunked-message-harness.mjs,target=/app/desktop-chunked-message-harness.mjs \
    node /app/smoke-container.mjs
EXPOSE 8214
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/container-entrypoint"]
CMD ["--host", "0.0.0.0", "--port", "8214"]
