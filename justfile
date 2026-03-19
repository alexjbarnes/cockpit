# Kill any running cockpit servers
kill:
    @-pkill -f "tsx watch.*server.ts" 2>/dev/null
    @-pkill -f "bun dist/server.js" 2>/dev/null
    @-fuser -k 3000/tcp 2>/dev/null
    @sleep 0.5

# Start dev server (Next.js dev mode with HMR)
dev:
    COCKPIT_DEBUG=1 COCKPIT_TOKEN=test npx tsx watch --env-file=.env.development server.ts

# Build for production
build:
    npx next build && npx tsc -p tsconfig.server.json

# Start production server with bun
start: build
    NODE_ENV=production COCKPIT_DEBUG=1 bun --env-file=.env.production dist/server.js

# Start production server with node (for debugging bun-specific issues)
start-node: build
    @set -a && . ./.env.production && set +a && NODE_ENV=production COCKPIT_DEBUG=1 node dist/server.js

# Type check
check:
    npx tsc --noEmit

# Run tests
test:
    npx vitest run

# Install dependencies
install:
    bun install

# Tail the debug log
debug-log:
    tail -f ~/.cockpit/debug.jsonl | jq .

# Clear the debug log
debug-clear:
    @truncate -s 0 ~/.cockpit/debug.jsonl 2>/dev/null || true
    @echo "Debug log cleared"
