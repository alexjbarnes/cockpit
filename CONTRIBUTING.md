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

After `next` merges into `main`:

1. Bump the version in `package.json`
2. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new dated version heading
3. Tag and push: `git tag v0.x.y && git push --tags`
4. `npm publish`
5. Reset `next` to match `main`:

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
