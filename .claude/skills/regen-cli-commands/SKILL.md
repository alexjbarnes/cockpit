---
description: Regenerate the CLI slash-command classification map (src/lib/cli-commands.ts) from the installed Claude CLI. Use after upgrading Claude Code, or when a slash command behaves wrong in a PTY session (hangs on "processing" or is wrongly blocked).
disable-model-invocation: true
---

## Version check
- Installed CLI: !`claude --version`
- Map generated from: !`grep CLI_VERSION src/lib/cli-commands.ts`

## Task
If the two versions match, the map is current — say so and stop unless a forced regen was requested.

Otherwise:
1. Run `node scripts/gen-cli-commands.mjs > src/lib/cli-commands.ts && npx biome format --write src/lib/cli-commands.ts`
2. Show `git diff src/lib/cli-commands.ts` and summarise the changes (added/removed commands, type or alias changes).
3. Call out any command that moved between `prompt` and `local`/`local-jsx` — that shifts PTY routing and deserves a look.
4. Run `npx vitest run tests/cli-commands.test.ts` to confirm the classifier contract holds.

Leave the diff for review; do not commit.
