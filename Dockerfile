# syntax=docker/dockerfile:1

# Talon's production image. The daemon runs on Bun (`bun src/index.ts` —
# the same entry `npm start` uses); `--build-arg RUNTIME=node` selects a
# node:24 + tsx base instead, kept as a fallback for one release cycle
# (docs/ts-migration-plan.md, Phase 1).
ARG RUNTIME=bun

# ── deps ──────────────────────────────────────────────────────────────
# node_modules is materialised by npm, not bun, in both variants: npm is
# this repo's lockfile of record (CI's "Lockfile Portability" job gates
# on package-lock.json and no bun.lock is checked in), and `bun install`
# cannot read package-lock.json. npm ci resolves the tree byte-for-byte
# per the lockfile, runs the postinstalls that unpack native artefacts,
# and picks the os/cpu-matching optional deps for whatever platform the
# build runs on (linux/amd64 and linux/arm64 both work — buildx runs
# this stage natively per target). Bun needs nothing installed at
# runtime; it just resolves the tree npm produced.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The Claude Agent SDK publishes its native `claude` CLI as one optional
# dep per platform, including linux-<arch>-musl (Alpine) next to
# linux-<arch> (glibc), and probes musl first. Modern npm honours the
# packages' `libc` field and skips the musl variant on a glibc host, so
# this is usually a no-op — but it is cheap insurance against an npm
# without libc filtering, where the SDK would spawn a musl binary on
# Debian and Talon would die at startup with "native binary not found".
# It also keeps the glob below unambiguous. (Invert it if you ever
# rebase the runtime onto alpine.)
RUN rm -rf /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl

# ── runtime bases ─────────────────────────────────────────────────────
# Two interchangeable bases; the ARG above picks one. Everything that
# differs between the runtimes (interpreter, CMD, healthcheck probe)
# lives here and is inherited by the final stage — the rest of the build
# is runtime-agnostic.
#
# HOME is /home/bun in *both* so a single docker-compose.yml serves
# either variant: the mount paths never move. Both base images ship an
# unprivileged UID 1000 (`bun` / `node`), which is what the app runs as.

FROM oven/bun:1 AS base-bun
ENV TALON_RUNTIME=bun HOME=/home/bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:19876/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
CMD ["bun", "src/index.ts"]

FROM node:24-slim AS base-node
ENV TALON_RUNTIME=node HOME=/home/bun
RUN mkdir -p /home/bun && chown node:node /home/bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:19876/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/index.ts"]

# ── runtime ───────────────────────────────────────────────────────────
FROM base-${RUNTIME} AS runtime
WORKDIR /app

COPY --from=deps --chown=1000:1000 /app/node_modules ./node_modules

# package.json is required at runtime, not just for the install: its
# `imports` map routes #prompt-assets to the embedded prompts under Bun
# and to the on-disk ones under Node.
COPY --chown=1000:1000 package.json tsconfig.json ./
COPY --chown=1000:1000 src/ src/
COPY --chown=1000:1000 prompts/ prompts/
COPY --chown=1000:1000 bin/ bin/

# `talon doctor`, `talon login claude`, and the interactive
# `claude auth login` bootstrap documented in docker-compose.yml all want
# a `claude` on PATH. The Agent SDK already ships that exact binary (the
# full Claude Code CLI, version-matched to the SDK), so link it instead
# of installing @anthropic-ai/claude-code globally a second time — the
# binary is ~220 MB, and the global install is also npm-only, which the
# bun base image has no use for.
RUN set -eux; \
  claude_bin="$(ls -d /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude | head -n1)"; \
  ln -sf "$claude_bin" /usr/local/bin/claude; \
  mkdir -p "$HOME/.talon"; \
  chown -R 1000:1000 "$HOME"

USER 1000:1000

# Persistent state lives under ~/.talon/ — bind-mount this from the host
# so config, sessions, workspace, palace, and userbot session survive
# container restarts. See docker-compose.yml for the canonical layout.
VOLUME /home/bun/.talon

EXPOSE 19876

# CMD and HEALTHCHECK are inherited from the selected base stage.
