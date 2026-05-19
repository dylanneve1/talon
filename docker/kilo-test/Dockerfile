# Talon image for Kilo-backend testing.
#
# Self-contained Talon configured to use the Kilo backend against a
# dedicated test Telegram bot. See ./README.md for usage.
#
# Not a production image: this carries `devDependencies` because Talon
# runs from TypeScript sources via `node --import tsx`. The root
# `Dockerfile` is the production-optimised build.

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ src/
COPY prompts/ prompts/
COPY bin/ bin/
COPY tsconfig.json ./

ENV HOME=/home/node
ENV NODE_ENV=production
RUN chown -R node:node /app /home/node
USER node

VOLUME /home/node/.talon

# Talon gateway port — container-internal, not published. The Kilo HTTP
# server (port 4097) is also container-internal.
EXPOSE 19876

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:19876/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
