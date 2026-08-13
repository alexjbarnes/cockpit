---
description: Publish a cockpit release to npm. Takes the version on `next`, opens and merges the release PR into `main`, tags it, publishes the package, and proves the published tarball actually installs and boots. Use when asked to publish, release, or ship a version, e.g. "publish 0.6.0" or "let's do the release".
---

# Publish a cockpit release

A release is a short sequence where the ordering carries all the risk. The tarball is built from the working tree at publish time, so the only thing that guarantees the published package matches the tag is that the tree, the branch, the tag and the remote all agree first. `make publish-check` enforces that; this skill's job is to get everything into the state that check demands, in the right order, and to stop the moment something does not line up.

**Never work around a failing check.** Every refusal in `publish-check` is there because a published release once went wrong in exactly that way. If it fails, fix the cause or stop and report — do not retag, do not force, do not bump the version to dodge a conflict, do not publish from a branch that is not `main`.

**An npm publish cannot be undone.** A version number is spent the moment it is published, even if unpublished afterwards. Treat step 5 as the point of no return and be sure of everything before it.

## Input
A version, or none. With no version, read `package.json` and propose it, then confirm with the user before touching anything. Never invent a version bump on your own: whether a release is a patch or a minor is the user's call.

## Step 0: Establish the state
Run these and read them before doing anything:

```
git branch --show-current
git status --porcelain
node -p "require('./package.json').version"
gh pr list --json number,title,headRefName,baseRefName --limit 10
npm view @alexjbarnes/cockpit dist-tags
git log --oneline main..next | wc -l
```

Stop and report if: the tree is dirty, the version is already on npm, or there is an open PR from `next` to `main` you did not expect (someone else may be mid-release).

## Step 1: Confirm the version and the changelog agree
`package.json` holds the version being released. `CHANGELOG.md` must have a `## [<version>] - <date>` section at the top whose date is today, describing what is actually in `main..next`.

Check the changelog covers the commits: `git log --oneline main..next`. A commit that changed behaviour a user can see and is not represented in the changelog is a gap — add it (see the `docs: bring the changelog up to date` commits for the voice: what changed for the user, and why it was wrong before). Internal-only work goes under Internal, briefly.

If the version needs bumping, do it now, in one commit with the changelog, on `next`, and push. Everything after this point assumes `next` is final.

## Step 2: Release PR into main
Releases reach `main` through a PR so CI runs on exactly what will be tagged.

```
gh pr create --base main --head next --title "Release <version>" --body "<short summary of the release>"
```

Wait for every check to pass:

```
gh pr view <pr> --json state,mergeStateStatus,statusCheckRollup
```

A red check stops the release. Fix it on `next`, push, and wait again. Do not merge a PR whose checks have not completed, and do not merge with admin privileges to skip them: CI here runs a real production build from a clean install, which is the check that has caught released-and-broken before.

Merge it squashed, matching how previous releases appear on `main`:

```
gh pr merge <pr> --squash --subject "Release <version>"
```

## Step 3: Tag the merged commit
The tag must point at the commit on `main` that was just merged, not at anything on `next`.

```
git checkout main && git pull origin main
git log --oneline -1              # confirm this is the Release <version> commit
git tag -a v<version> -m "Release <version>"
git push origin v<version>
```

## Step 4: Preflight
```
make publish-check
```

This re-checks every one of: version readable, tree clean, on `main`, `main` and `origin/main` identical, the tag exists, the tag points at HEAD, the tag is pushed, and the version is not already on npm. If any of it fails, stop and report which — each one means the release is not what it claims to be.

## Step 5: Publish
```
make publish
```

`prepublishOnly` rebuilds, so the tarball comes from the tree the tag points at. This is irreversible.

## Step 6: Prove the published package installs and boots
Publishing is not the deliverable; a working install is. A release has shipped broken before while every local build passed, so verify against npm itself, not the working tree.

In a temp directory, install the published version the way a user does and boot it on a spare port:

```
cd "$(mktemp -d)" && npm init -y >/dev/null
npm install @alexjbarnes/cockpit@<version>
PORT=<spare port> node node_modules/@alexjbarnes/cockpit/bin/cockpit.js
```

**Never use port 3001** — that is the live instance. Pick an unused high port, and give the process a throwaway `COCKPIT_CONFIG_DIR` so it cannot touch real state (`~/.cockpit` holds real provider keys).

Then confirm it actually serves, rather than merely starting: fetch `/` and one dynamic route (a released build once returned 200 on static pages while every dynamic route was broken). Read the install output too — deprecation and peer warnings are what a user sees.

Kill it by port when done (`lsof -ti:<port> | xargs -r kill`), never by process name, and remove the temp directory.

## Step 7: Put `main` back into `next`
A squash merge leaves `main` with a commit that is not on `next`, so the branches diverge immediately.

```
git checkout next && git merge origin/main && git push origin next
```

## Step 8: Report
Give the user: the version, the tag, the PR, the npm dist-tag now showing, and the result of the install check. If anything was skipped or failed, say so plainly rather than reporting a clean release.

## Stop conditions
Stop and report, rather than improvising, when: CI is red; the tree is dirty; `main` and `origin/main` differ; the tag does not point at HEAD; the version is already on npm; `publish-check` fails for any reason; or the published package fails to install or boot. For the last one the version is already spent — the fix is a new patch version, never a republish of the same one.
