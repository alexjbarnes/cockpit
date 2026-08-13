# Contributing

## Branching

Two long-lived branches:

- `main`: stable. Always installable, always runnable. What gets published to npm. Anyone cloning the repo lands here and should get something that works.
- `next`: integration target. All in-progress work goes here.

Day-to-day work commits directly to `next`. External contributors should open PRs against `next`. When `next` has accumulated enough to ship, open one PR from `next` into `main` and merge.

```
direct commits ----> next --PR--> main --tag--> npm
contributor PR ---> next
```

CI runs on every push to `main` and `next`, and on PRs targeting either branch.

## Releasing

Steps 1 and 2 land on `next` and reach `main` through the release PR:

1. Bump with `npm version 0.x.y --no-git-tag-version`, so `package-lock.json` stays in step. Editing `package.json` by hand leaves the lockfile stale.
2. Add the dated version heading to `CHANGELOG.md`, then commit both as `chore(release): 0.x.y`
3. Open the release PR (`next` into `main`, titled `Release 0.x.y`) and squash merge it
4. Tag `main`'s release commit and push just that tag:

   ```sh
   git checkout main && git pull
   git tag -a v0.x.y -m "Release 0.x.y"
   git push origin v0.x.y
   ```

5. `make publish`, which refuses unless the tree is clean, you are on `main` in sync with `origin/main`, and `v0.x.y` exists, points at `HEAD`, and is pushed
6. Reset `next` to match `main`. This discards anything on `next` that did not go through the release PR, so check for post-release merges (Dependabot lands there) before running it:

   ```sh
   git checkout next
   git fetch origin
   git reset --hard origin/main
   git push --force-with-lease
   ```

   Alternatively, delete and recreate:

   ```sh
   git push origin --delete next
   git checkout main && git pull
   git checkout -b next
   git push -u origin next
   ```

`next` is treated as disposable. Anything not merged to `main` before the reset is discarded, so confirm nothing important is sitting on `next` first.

## Why

Cockpit is published to npm. Most users hit `npx @alexjbarnes/cockpit`, which pulls a tagged release and is unaffected by branch state. People who clone the repo to run from source land on `main`, so `main` should not be broken between releases. `next` absorbs in-progress work without exposing half-built features to those cloners.
