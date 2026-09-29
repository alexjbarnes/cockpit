# Ask before a command widens the sandbox

With the Claude Code sandbox on, a Bash command can get past the sandbox's limits in two ways:

- It can be retried with `dangerouslyDisableSandbox: true`, which runs it outside the sandbox.
- In auto mode, it can list hosts it needs in `allowed_domains`, which lets it reach them although they are not on the allowed list.

In default mode the first asks you and the second does not arise (a blocked host raises the CLI's own network prompt). In auto mode neither asks: the auto mode classifier approves both, and the command runs without anyone being asked.

This hook turns both into a permission prompt, in any mode, and leaves every other command alone.

## The hook

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -e '(.tool_input.dangerouslyDisableSandbox == true) or ((.tool_input.allowed_domains // []) | length > 0)' >/dev/null && echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"Widens the sandbox\"}}' || true"
          }
        ]
      }
    ]
  }
}
```

It runs on every Bash call. When the call sets `dangerouslyDisableSandbox` or lists any `allowed_domains`, it answers `ask`, and the CLI shows a normal permission prompt with the reason "Widens the sandbox". For any other call the hook answers nothing, so the usual rules apply.

## Built-in alternatives

Claude Code's own settings cover both cases without a hook, per its [sandboxing docs](https://code.claude.com/docs/en/sandboxing). These were not tested here:

- Retries outside the sandbox: an ask rule, `"permissions": { "ask": ["Bash(dangerouslyDisableSandbox:true)"] }`, prompts on every one, auto mode included. No `jq`, and nothing to fail open.
- Hosts a command lists in auto mode: `"sandbox": { "network": { "strictAllowlist": true } }` refuses per-command lists, so a host outside the allowed domains is denied outright instead of going to the classifier. That is a refusal, not a prompt. Use the hook if a person should be able to say yes.

## Requirements

- The sandbox switched on: `"sandbox": { "enabled": true }`.
- `sandbox.allowUnsandboxedCommands` left at its default of `true`. With `false`, the CLI ignores `dangerouslyDisableSandbox` completely, so nothing can run outside the sandbox and there is nothing for the hook to ask about.
- `jq` on the PATH. The hook fails open: without `jq` it answers nothing and the retry goes back to the classifier. Check `jq --version` on every machine that gets the hook.

## Where to put it

- Managed settings, to apply it to everyone with no way to switch it off: `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux. Managed hooks still run when `allowManagedHooksOnly` is on.
- User settings (`~/.claude/settings.json`), for just you.
- A file passed with `--settings`, for a single run.

If the file already has a `hooks` block, add this entry to it rather than replacing it.

## What changes in each mode

| Mode | Retry outside the sandbox, no hook | With the hook |
|---|---|---|
| Default | Asks you | Asks you (no change) |
| Accept edits | Asks you | Asks you (no change) |
| Auto, retry outside the sandbox | Classifier decides, no prompt | Asks you |
| Auto, command listing its own hosts | Classifier decides, no prompt | Asks you |

The auto mode rows were tested live. The other rows come from reading the CLI's code. Bypass permissions mode was not tested.

## How it was tested

Real Claude Code CLI 2.1.282 on Linux (bubblewrap sandbox), auto mode, Sonnet. Claude was asked to `touch` a file in the home directory, outside the project, and to retry outside the sandbox if blocked.

- Without the hook, the sandboxed attempt failed with "Read-only file system". The retry went to the classifier, which took about 7 seconds and approved it, and the file was written outside the sandbox with no prompt.
- With the hook, the sandboxed attempt failed the same way and was not prompted. The retry raised a permission prompt about 30 ms after the call, so the classifier was never consulted. The prompt was denied and nothing ran.

A second run covered hosts: in auto mode, Claude ran `curl https://example.org/` with `allowed_domains: ["example.org"]`, a host on no allowed list. Without the hook the classifier approved it and the request returned 200. With the hook the call raised a permission prompt, and nothing ran until it was answered. The same classifier approval was seen on macOS, reaching amazon.com with no prompt.

Not yet tested with the hook on macOS, where the sandbox uses Seatbelt instead of bubblewrap.

## Try it yourself

1. Save the hook plus `"sandbox": { "enabled": true }` in one file, for example `sandbox-test.json`.
2. In a scratch folder, run `claude --settings sandbox-test.json --permission-mode auto`.
3. Ask: "Run `touch ~/sandbox-test-marker`. If the sandbox blocks it, retry once with dangerouslyDisableSandbox set to true."
4. The first attempt should fail and the retry should show a permission prompt. Deny it, then check that `~/sandbox-test-marker` does not exist.

## Limits

- It matches the Bash tool only. Add any other shell tool your CLI has to the matcher.
- It only covers commands, because that is all the sandbox covers. Edit and Write outside the project go through the normal permission checks, not the sandbox.
- It depends on the CLI's `dangerouslyDisableSandbox` and `allowed_domains` field names. Recheck them after CLI upgrades.
- A non-interactive run (`claude -p`) has nobody to ask, so the CLI refuses the retry instead. This comes from reading the CLI's code and was not tested.

## With cockpit

Cockpit answers the same "ask" itself for every Bash call that sets `dangerouslyDisableSandbox`, marks the card "Runs outside the sandbox", and never approves one automatically, in bypass or plan mode either. It does not yet do the same for `allowed_domains`, so a cockpit session in auto mode still lets the classifier approve a command's own hosts.

Cockpit needs its own hooks to run. `allowManagedHooksOnly: true` or `disableAllHooks: true` in managed settings switches them off, and cockpit stops working.
