.PHONY: install-hooks uninstall-hooks kill dev build start check test install debug-log debug-clear

TARBALL_DIR := /tmp/cockpit-tarball-test
PORT := $(or $(shell grep -E '^PORT=' .env.development 2>/dev/null | cut -d= -f2 | tr -d ' '),3001)
KILL_PORT := scripts/kill-port.sh

# Kill any running cockpit servers
kill:
	@-pkill -f "tsx.*server\.ts" 2>/dev/null
	@-pkill -f "node.*dist/server\.js" 2>/dev/null
	@-pkill -f "node.*node_modules/@alexjbarnes/cockpit/bin/cockpit.js" 2>/dev/null
	@$(KILL_PORT) $(PORT)

# Start dev server (Next.js dev mode with HMR)
dev:
	@$(KILL_PORT) $(PORT)
	unset GITHUB_TOKEN && COCKPIT_DEBUG=1 COCKPIT_TOKEN=test npm run dev

# Build for production
build:
	npm run build

# Start production server via a packed tarball (simulates `npx @alexjbarnes/cockpit`)
start: build
	@$(KILL_PORT) $(PORT)
	@rm -rf $(TARBALL_DIR)
	@mkdir -p $(TARBALL_DIR)
	@echo ">>> Packing tarball into $(TARBALL_DIR)"
	@npm pack --silent --pack-destination $(TARBALL_DIR) >/dev/null
	@echo ">>> Installing tarball with fresh node_modules"
	@cd $(TARBALL_DIR) && npm init -y >/dev/null 2>&1 && npm install --silent ./alexjbarnes-cockpit-*.tgz >/dev/null
	@echo ">>> Running from $(TARBALL_DIR) on port $(PORT)"
	@unset GITHUB_TOKEN && COCKPIT_DEBUG=1 COCKPIT_PTY_RUNTIME=1 PORT=$(PORT) \
	  node $(TARBALL_DIR)/node_modules/@alexjbarnes/cockpit/bin/cockpit.js

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
