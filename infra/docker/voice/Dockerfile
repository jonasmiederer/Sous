# Voice Lambda container image (Requirements 14.5, 14.9).
#
# Build context: the repository root (see SousStack, `VoiceFunction`). CDK
# builds this image at deploy / asset-publish time, never during `cdk synth`.
#
#   1. build   esbuild bundle of src/services/voice/lambda.ts, with the same
#              settings as the NodejsFunction bundling of the other Lambdas.
#   2. ffmpeg  static ARM64 ffmpeg from a digest-pinned image.
#   3. final   AWS Lambda Node.js 22 base image (arm64) + bundle + ffmpeg.
#
# ffmpeg licence: mwader/static-ffmpeg (https://github.com/wader/static-ffmpeg)
# configures FFmpeg with --enable-gpl --enable-version3 (libx264, libx265 and
# other GPL libraries are linked in), so the binary is licensed GPLv3. The
# image's build scripts are MIT. We run the binary unmodified as a separate
# process (no linking with our code) inside our own private Lambda image. The
# GPL source-offer obligations apply only if this image is distributed to third
# parties. In that case, point recipients to the FFmpeg 9.0.2 sources and the
# static-ffmpeg Dockerfile at the pinned tag. No prebuilt static LGPL ARM64
# build is widely published; an LGPL build would mean building FFmpeg ourselves.
#
# Only a small part of ffmpeg is used, with fixed arguments (ffmpegArgs in
# src/voice/audioConverter.ts): the matroska (WebM) and mov (MP4) demuxers,
# the native opus and aac decoders, and the pcm_s16le encoder / s16le muxer
# writing to pipe:1, with -protocol_whitelist file,pipe.

# ---------------------------------------------------------------------------
# 1. Bundle the handler. The output is platform-independent JavaScript, so the
#    builder runs on the build host's platform.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/node:22-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
# Root package only: the `web` workspace is not in the build context.
RUN npm ci --workspaces=false --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx esbuild src/services/voice/lambda.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=esm \
      --main-fields=module,main \
      --minify \
      --sourcemap \
      "--banner:js=import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
      --outfile=/build/out/index.mjs

# ---------------------------------------------------------------------------
# 2. Static ffmpeg 9.0.2 (mwader/static-ffmpeg:9.0.2-1), pinned by the digest
#    of the multi-arch index; the arm64 variant is selected by --platform.
# ---------------------------------------------------------------------------
FROM --platform=linux/arm64 mwader/static-ffmpeg:9.0.2-1@sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822 AS ffmpeg

# ---------------------------------------------------------------------------
# 3. Lambda runtime image.
# ---------------------------------------------------------------------------
FROM --platform=linux/arm64 public.ecr.aws/lambda/nodejs:22
COPY --from=ffmpeg /ffmpeg /opt/bin/ffmpeg
COPY --from=build /build/out/index.mjs /build/out/index.mjs.map ${LAMBDA_TASK_ROOT}/
ENV FFMPEG_PATH=/opt/bin/ffmpeg
CMD ["index.handler"]
