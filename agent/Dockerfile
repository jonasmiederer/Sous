# Suggestion_Agent container image (design.md, "Code layout and packaging";
# Requirements 8.2, 12.14).
#
# Build context: the repository root (CDK DockerImageAsset with
# `file: 'agent/Dockerfile'`). CDK builds this image at deploy /
# asset-publish time, never during `cdk synth`.
#
# AgentCore Runtime HTTP contract (checked for task 19.15, AgentCore developer
# guide, "HTTP protocol contract":
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html):
# ARM64 image, server on 0.0.0.0:8080 with POST /invocations and GET /ping.
#
#   1. build    esbuild bundle of agent/src/main.ts into one ESM file.
#   2. runtime  node:22-slim (arm64), bundle only, unprivileged `node` user.
#
# Base image: public.ecr.aws/docker/library/node:22-slim (Debian bookworm),
# pinned by the digest of the multi-arch index; --platform picks the variant.

# ---------------------------------------------------------------------------
# 1. Bundle. The output is platform-independent JavaScript, so the builder
#    runs on the build host's platform.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /build
COPY package.json package-lock.json ./
# Root package only: the `web` workspace is not in the build context.
RUN npm ci --workspaces=false --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY agent/src ./agent/src
# Tests are never bundled (nothing imports them); drop them from the stage anyway.
RUN find src agent -name '*.test.ts' -delete
RUN npx esbuild agent/src/main.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=esm \
      --main-fields=module,main \
      --minify \
      --sourcemap \
      "--banner:js=import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
      --outfile=/build/out/main.mjs

# ---------------------------------------------------------------------------
# 2. Runtime image.
# ---------------------------------------------------------------------------
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /build/out/main.mjs /build/out/main.mjs.map ./
USER node
EXPOSE 8080
CMD ["node", "main.mjs"]
