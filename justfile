# Unix/macOS only. On Windows, use package.json scripts.

# Kill any running cockpit servers
kill:
    @-pkill -f "bun.*server\.ts" 2>/dev/null
    @-pkill -f "bun.*dist/server\.js" 2>/dev/null
    @-fuser -k 3000/tcp 2>/dev/null
    @sleep 0.5

# Start dev server (Next.js dev mode with HMR)
dev:
    unset GITHUB_TOKEN && COCKPIT_DEBUG=1 COCKPIT_TOKEN=test bun --watch --env-file=.env.development server.ts

# Build for production
build:
    bunx next build && bunx tsc -p tsconfig.server.json

# Start production server
start: build
    unset GITHUB_TOKEN && NODE_ENV=production COCKPIT_DEBUG=1 bun --env-file=.env.production dist/server.js

# Type check
check:
    bunx tsc --noEmit

# Run tests
test:
    bunx vitest run

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
