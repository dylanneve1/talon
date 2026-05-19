# Talon image for Codex-backend testing.
#
# Self-contained Talon configured to use the Codex backend against a
# dedicated test Telegram bot. See ./README.md for usage.
#
# Not a production image: this carries `devDependencies` because Talon
# runs from TypeScript sources via `node --import tsx`, plus the
# `codex` CLI is brought in via `@openai/codex` (transitive of
# `@openai/codex-sdk`). The root `Dockerfile` is the production-
# optimised build.

FROM node:22-slim

# `codex` requires curl/git/ripgrep on PATH for its built-in tools.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl git ripgrep && \
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
RUN chown -R node:node /app /home/node
USER node

VOLUME /home/node/.talon

# Talon gateway port — container-internal, not published.
EXPOSE 19876

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:19876/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
