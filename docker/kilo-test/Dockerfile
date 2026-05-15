# Dockerfile for live-tier Kilo backend testing.
#
# What this is:
#   A self-contained Talon image configured to use the Kilo backend
#   against a dedicated test Telegram bot (`@talondebugbot`). Built for
#   live verification of PR changes without touching production Talon.
#
# What it is NOT:
#   - The production Dockerfile. Prod uses the root `Dockerfile` and is
#     wired for Claude SDK.
#   - A general-purpose Kilo runtime. This bakes in dev tools (tsx,
#     vitest) for ergonomics during interactive testing.
#
# Required env (passed via docker-compose):
#   - TALON_TEST_BOT_TOKEN   — Telegram bot token of the test bot
#   - KILO_API_KEY (or providers configured in /home/node/.talon/talon.json)
#
# Volumes (see docker-compose.kilo-test.yml):
#   - /home/node/.talon       — persistent workspace + sessions for the test bot
#   - (optional) /home/node/.kilo — Kilo auth (only if you set up providers
#     via Kilo's interactive auth flow rather than env keys)

FROM node:22-slim

WORKDIR /app

# tsx is needed at runtime because Talon runs from TypeScript sources via
# `node --import tsx src/index.ts`. The full devDependencies install also
# brings vitest in case we want to run a smoke test from inside the
# container against the live Kilo server.
COPY package.json package-lock.json ./
RUN npm ci

# Application source
COPY src/ src/
COPY prompts/ prompts/
COPY bin/ bin/
COPY tsconfig.json ./

ENV HOME=/home/node
ENV NODE_ENV=production
RUN chown -R node:node /app /home/node
USER node

VOLUME /home/node/.talon

# Talon's bridge port — only exposed within the docker network, not
# published externally. The Kilo HTTP server (port 4097) is internal.
EXPOSE 19876

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:19876/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

# Default command — assumes the container's /home/node/.talon/talon.json is
# configured for kilo backend. See the README for the canonical config.
CMD ["node", "--import", "tsx", "src/index.ts"]
