FROM oven/bun:latest

RUN bun install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY . .
RUN bun run build

EXPOSE 3000
CMD ["bun", "dist/server.js"]
