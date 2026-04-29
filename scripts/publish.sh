#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <tag>" >&2
  echo "Example: $0 v0.1.0" >&2
  exit 1
fi

TAG="$1"

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "Tag must look like vX.Y.Z (got: $TAG)" >&2
  exit 1
fi

VERSION="${TAG#v}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "==> Fetching from origin"
git fetch origin --tags --force --prune

echo "==> Verifying tag $TAG exists"
if ! git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG not found after fetch" >&2
  exit 1
fi

TAG_SHA="$(git rev-parse "$TAG^{commit}")"

echo "==> Verifying $TAG is on origin/main"
if ! git merge-base --is-ancestor "$TAG_SHA" origin/main; then
  echo "Tag $TAG ($TAG_SHA) is not on origin/main" >&2
  exit 1
fi

echo "==> Verifying npm login"
if ! NPM_USER="$(npm whoami 2>/dev/null)"; then
  echo "Not logged in to npm. Run: npm login" >&2
  exit 1
fi
echo "    Logged in as: $NPM_USER"

WORKTREE_DIR="$(mktemp -d -t "cockpit-publish-${VERSION}.XXXXXX")"
cleanup() {
  cd "$REPO_ROOT"
  git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
}
trap cleanup EXIT

echo "==> Checking out $TAG into $WORKTREE_DIR"
git worktree add --detach "$WORKTREE_DIR" "$TAG"
cd "$WORKTREE_DIR"

PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="$(node -p "require('./package.json').version")"

if [[ "$PKG_VERSION" != "$VERSION" ]]; then
  echo "package.json version ($PKG_VERSION) does not match tag ($VERSION)" >&2
  exit 1
fi

echo "==> Verifying $PKG_NAME@$VERSION not already published"
if npm view "$PKG_NAME@$VERSION" version >/dev/null 2>&1; then
  echo "$PKG_NAME@$VERSION is already published" >&2
  exit 1
fi

echo "==> npm ci"
npm ci

echo "==> Lint"
npm run lint

echo "==> Typecheck"
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.server.json

echo "==> Tests"
npx vitest run

echo "==> Publishing $PKG_NAME@$VERSION (prepublishOnly runs the build)"
echo "    npm will prompt for your 2FA OTP."
npm publish --access public

echo "==> Done. Published $PKG_NAME@$VERSION"
