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

CMD ["node", "--import", "tsx", "src/index.ts"]
