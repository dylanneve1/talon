# Talon image for Antigravity-backend testing.
#
# Self-contained Talon configured to use the `agy` backend against a
# dedicated test Telegram bot. See ./README.md — and read the CANNOT
# BE AUTHENTICATED IN CI note there before wiring this into a pipeline.
#
# Not a production image: it carries `devDependencies` because Talon
# runs from TypeScript sources via `node --import tsx`. The root
# `Dockerfile` is the production-optimised build.
#
# Unlike the codex harness there is no npm package to install the CLI
# from: the Antigravity CLI is distributed as a standalone binary, so
# the image expects one to be bind-mounted (or copied in) at
# /usr/local/bin/agy. `AGY_BINARY` points Talon at it.

FROM node:24-slim

# agy shells out to these for its native tools.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl git ripgrep ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ src/
COPY prompts/ prompts/
COPY bin/ bin/
COPY tsconfig.json ./

ENV HOME=/home/node
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
# Where the compose file bind-mounts the host's `agy`.
ENV AGY_BINARY=/usr/local/bin/agy
RUN chown -R node:node /app /home/node
USER node

VOLUME /home/node/.talon
# The OAuth cache and the shared MCP config both live under ~/.gemini.
VOLUME /home/node/.gemini

# Talon gateway port — container-internal, not published.
EXPOSE 19876

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:19876/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
