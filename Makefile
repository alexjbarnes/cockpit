.PHONY: install-hooks uninstall-hooks kill dev build start check test install debug-log debug-clear publish publish-check

TARBALL_DIR := /tmp/cockpit-tarball-test
PORT := $(or $(shell grep -E '^PORT=' .env.development 2>/dev/null | cut -d= -f2 | tr -d ' '),3001)
KILL_PORT := scripts/kill-port.sh
# Lazy (=) on purpose: only the publish targets read these, so `make dev` and
# `make kill` do not pay for a node startup on every invocation.
PKG = $(shell node -p "require('./package.json').name" 2>/dev/null)
VERSION = $(shell node -p "require('./package.json').version" 2>/dev/null)
TAG = v$(VERSION)

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

# Preflight the release publish. The tarball is built from the working tree, so
# the branch name alone proves nothing: these checks pin the tree to the commit
# that vX.Y.Z points at, which is what actually guarantees the published package
# matches the tag.
publish-check:
	@test -n "$(VERSION)" || { echo "!!! cannot read version from package.json"; exit 1; }
	@echo ">>> $(PKG)@$(VERSION), expecting tag $(TAG)"
	@test -z "$$(git status --porcelain)" || { echo "!!! working tree is dirty, commit or stash first"; exit 1; }
	@b=$$(git rev-parse --abbrev-ref HEAD); test "$$b" = "main" || { echo "!!! on '$$b', publish from main"; exit 1; }
	@git fetch --quiet origin main --tags
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" || { echo "!!! main and origin/main differ, pull or push first"; exit 1; }
	@git rev-parse -q --verify refs/tags/$(TAG) >/dev/null || { echo "!!! tag $(TAG) does not exist, create it with: git tag -a $(TAG)"; exit 1; }
	@test "$$(git rev-parse "$(TAG)^{commit}")" = "$$(git rev-parse HEAD)" || { echo "!!! tag $(TAG) does not point at HEAD"; exit 1; }
	@git ls-remote --exit-code --tags origin refs/tags/$(TAG) >/dev/null 2>&1 || { echo "!!! tag $(TAG) is not pushed, run: git push origin $(TAG)"; exit 1; }
	@if npm view $(PKG)@$(VERSION) version >/dev/null 2>&1; then echo "!!! $(PKG)@$(VERSION) is already on npm, bump the version"; exit 1; fi
	@echo ">>> preflight passed"

# Publish to npm. Preflight runs first; prepublishOnly rebuilds.
publish: publish-check
	npm publish

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
