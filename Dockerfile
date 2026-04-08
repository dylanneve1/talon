FROM node:22-slim

WORKDIR /app

# Install Claude Code (required for Agent SDK)
RUN npm install -g @anthropic-ai/claude-code

# Copy package files first for layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ src/
COPY prompts/ prompts/
COPY bin/ bin/
COPY tsconfig.json ./

# Run as the existing non-root node user (UID 1000)
RUN chown -R node:node /app
USER node

# Workspace persisted via volume
VOLUME /app/workspace

EXPOSE 19876

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:19876/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
