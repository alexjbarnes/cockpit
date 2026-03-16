# Kill any running aperture servers
kill:
    @-pkill -f "tsx watch.*server.ts" 2>/dev/null
    @-pkill -f "watch-prod" 2>/dev/null
    @-pkill -f "bun dist/server.js" 2>/dev/null
    @-fuser -k 3000/tcp 2>/dev/null
    @sleep 0.5

# Start dev server (Next.js dev mode, slower but has HMR)
dev: kill
    APERTURE_DEBUG=1 APERTURE_TOKEN=test npx tsx watch --env-file=.env server.ts

# Start prod server with file watcher (fast, rebuilds on change)
prod: kill
    APERTURE_DEBUG=1 APERTURE_TOKEN=test bun scripts/watch-prod.ts

# Start prod server without watching
start: kill
    NODE_ENV=production APERTURE_TOKEN=test APERTURE_DEBUG=1 bun dist/server.js

# Build for production
build:
    npx next build && npx tsc -p tsconfig.server.json

# Tail the debug log
debug-log:
    tail -f ~/.aperture/debug.jsonl | jq .

# Clear the debug log
debug-clear:
    @truncate -s 0 ~/.aperture/debug.jsonl 2>/dev/null || true
    @echo "Debug log cleared"

# Type check
check:
    npx tsc --noEmit

# Run tests
test:
    npx vitest run

# Run tests in watch mode
test-watch:
    npx vitest

# Install dependencies
install:
    bun install
