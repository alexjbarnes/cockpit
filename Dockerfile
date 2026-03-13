FROM node:22-bookworm-slim

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/server.js"]
