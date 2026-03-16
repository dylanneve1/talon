FROM node:22-slim

WORKDIR /app

# Install Claude Code (required for Agent SDK)
RUN npm install -g @anthropic-ai/claude-code

# Copy package files first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ src/
COPY prompts/ prompts/
COPY bin/ bin/
COPY tsconfig.json ./

# Workspace persisted via volume
VOLUME /app/workspace

EXPOSE 19876

CMD ["node", "--import", "tsx", "src/index.ts"]
