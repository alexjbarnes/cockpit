.PHONY: install-hooks uninstall-hooks kill dev build start check test install debug-log debug-clear

# Kill any running cockpit servers
kill:
	@-pkill -f "tsx.*server\.ts" 2>/dev/null
	@-pkill -f "node.*dist/server\.js" 2>/dev/null
	@-fuser -k 3000/tcp 2>/dev/null
	@sleep 0.5

# Start dev server (Next.js dev mode with HMR)
dev:
	unset GITHUB_TOKEN && COCKPIT_DEBUG=1 COCKPIT_TOKEN=test npm run dev

# Build for production
build:
	npm run build

# Start production server
start: build
	unset GITHUB_TOKEN && NODE_ENV=production COCKPIT_DEBUG=1 npm run start

# Type check
check:
	npx tsc --noEmit

# Run tests
test:
	npx vitest run

# Install dependencies
install:
	npm install

# Tail the debug log
debug-log:
	tail -f ~/.cockpit/debug.jsonl | jq .

# Clear the debug log
debug-clear:
	@truncate -s 0 ~/.cockpit/debug.jsonl 2>/dev/null || true
	@echo "Debug log cleared"

install-hooks:
	@chmod +x scripts/pre-commit
	@ln -sf ../../scripts/pre-commit .git/hooks/pre-commit
	@echo "pre-commit hook installed"

uninstall-hooks:
	@rm -f .git/hooks/pre-commit
	@echo "pre-commit hook removed"
