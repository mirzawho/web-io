# Bun runs TypeScript directly, so the image needs no build step: only the
# dependencies, the sources and a Chromium that runs as a non-root user.
FROM oven/bun:1-debian AS dependencies

WORKDIR /app

# Use the Debian chromium package instead of the Chrome build Puppeteer downloads:
# it is installed once in the runtime stage and keeps the layer cache predictable.
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production


FROM oven/bun:1-debian AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    GOOGLE_HEADLESS=true \
    PUPPETEER_NO_SANDBOX=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# chromium pulls in every shared library it needs; the extra fonts keep pages that
# measure text with canvas from failing to render.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# The runtime user owns the app directory, so Chromium can write its profile into .cache/ and
# DEBUG=true can write debug.txt.
RUN mkdir -p .cache && chown -R bun:bun /app

USER bun

EXPOSE 3000

CMD ["bun", "src/index.ts"]
