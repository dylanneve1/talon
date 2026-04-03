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

# Run as non-root user
RUN useradd -m -u 1000 talon && chown -R talon:talon /app
USER talon

# Workspace persisted via volume
VOLUME /app/workspace

EXPOSE 19876

CMD ["node", "--import", "tsx", "src/index.ts"]
