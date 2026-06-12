# node:24 matches the package's engines field (>=24) and the CI test matrix.
FROM node:24-slim

WORKDIR /app

# Install Claude Code CLI globally (required by the Agent SDK to spawn its
# subprocess for streaming + model discovery).
RUN npm install -g @anthropic-ai/claude-code

# Install production dependencies using the lockfile for reproducibility.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The Claude Agent SDK ships native `claude` binaries for both linux-x64-musl
# (Alpine) and linux-x64 (glibc) and probes them in that order. node:24-slim is
# Debian/glibc, so the musl variant is unusable but resolves first — when the
# SDK tries to spawn it, the dynamic linker fails and Talon errors at startup
# with "native binary not found". Remove the wrong variant so the SDK falls
# through to the glibc binary. (Switch this if you ever rebase to alpine.)
RUN rm -rf /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl

# Application source
COPY src/ src/
COPY prompts/ prompts/
COPY bin/ bin/
COPY tsconfig.json ./

# Run as the existing non-root node user (UID 1000). Set HOME explicitly so
# the Claude Agent SDK's spawned `claude` subprocess can find auth at
# $HOME/.claude/.credentials.json (mounted from the host — see compose).
ENV HOME=/home/node
RUN chown -R node:node /app /home/node
USER node

# Persistent state lives under ~/.talon/ — bind-mount this from the host so
# config, sessions, workspace, palace, and userbot session survive container
# restarts. See docker-compose.yml for the canonical mount layout.
VOLUME /home/node/.talon

EXPOSE 19876

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:19876/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
