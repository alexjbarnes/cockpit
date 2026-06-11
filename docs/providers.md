# Model providers

Cockpit can drive Claude Code against more than the built-in Anthropic models. A provider is a named set of environment variables plus a list of models. Selecting a provider model injects that provider's environment into the Claude Code process when the session spawns, so you can point the same UI at a proxy, a gateway, or an Anthropic-compatible endpoint. Run cheaper or faster models through a gateway like OpenRouter, route to a self-hosted or local model, or keep traffic inside your own proxy, while the rest of Cockpit behaves exactly the same. Provider models are selectable per session and per scheduled job.

The built-in **Anthropic** provider is always present and needs no configuration. It exposes Haiku, Sonnet, and Opus with their version and context-size options.

## Adding a provider

Go to Settings, open the Providers page, and add a provider. The editor has two tabs.

**General**

- **Name.** A label shown in the model picker (for example `OpenRouter` or `Deepseek`).
- **Environment variables.** Arbitrary `KEY` / `value` pairs that are set on the Claude Code process for sessions using this provider. Values that look like secrets are masked in the form. Common variables:
  - `ANTHROPIC_BASE_URL` redirects the API to your endpoint.
  - `ANTHROPIC_AUTH_TOKEN` is sent as a `Bearer` token. Prefer this over `ANTHROPIC_API_KEY`, which makes the CLI prompt for confirmation on first use.
  - `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL` map Claude's model aliases onto your endpoint's names, if needed.

**Models**

Add each model the provider offers:

- **Model ID.** The identifier passed to the CLI as `--model`.
- **Display name.** What the picker shows. Defaults to the model ID.
- **Context sizes.** One or more of 200K and 1M. A model with two sizes shows a size selector in the session settings (see [Sessions](sessions.md#session-settings)).
- **Effort levels.** Which thinking levels (Low, Medium, High, XHigh, Max) the model supports. The thinking selector only shows levels listed here.

A model must declare at least one context size.

## Selecting a provider model

Provider models appear in the model picker and in the per-session settings popover, grouped by provider. Picking one stores it on the session in the qualified form `provider:modelId`. On the next spawn, Cockpit resolves the provider, passes the bare model ID to `--model`, and applies the provider's environment variables.

Models can be set per slot. The **main** slot drives the conversation. The **subagent** and **fast** slots, when set to a different model, are exported to the CLI so subagents and lightweight calls can use a cheaper or faster model.

## Storage

Custom providers are stored in `~/.cockpit/providers.json`. The built-in Anthropic provider is constructed in code and is not written to disk. Relocate the file with `COCKPIT_CONFIG_DIR` (see [Settings](settings.md#environment-variables)).

## Notes

- Context size drives the CLI's 1M-context switch: choosing 200K sets `CLAUDE_CODE_DISABLE_1M_CONTEXT` for that spawn.
- A context-size change takes effect on the next CLI start, because the switch is applied at spawn time. Cockpit restarts the process for you when the size changes.
- The context gauge denominator reflects the size you picked, not what the API reports.

## Subagents and effort levels

When a session spawns a subagent via the Agent tool, the subagent inherits the provider's environment variables. This means any `CLAUDE_CODE_EFFORT_LEVEL` you put in a provider's env vars applies to subagents too, not just the main session.

That causes a conflict if a subagent disables thinking (for example, the Explore agent type) while `CLAUDE_CODE_EFFORT_LEVEL=max` is also in the environment. The provider endpoint receives both `reasoning_effort=max` and `thinking.type=disabled` in the same request, which is invalid and returns a 400 error. The session then terminates without completing.

**Do not set `CLAUDE_CODE_EFFORT_LEVEL` in a provider's environment variables.** Use the job's Thinking Level setting instead. Cockpit passes the thinking level as a `--effort` CLI flag to the main session, which does not propagate to subagents. Subagents then use the model's default effort, which avoids the conflict.
