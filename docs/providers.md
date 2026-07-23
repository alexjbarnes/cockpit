# Model providers

Cockpit can drive Claude Code against more than the built-in Anthropic models. Three gateways ship built in (OpenRouter, OpenCode Zen, DeepSeek), each connected with a single API key, plus custom Anthropic-compatible endpoints for anything else. Provider models are selectable per session and per scheduled job.

The built-in **Anthropic** provider is always present and needs no configuration. It exposes Haiku, Sonnet, and Opus with their version and context-size options.

## Built-in gateways

Settings, then Model Providers, shows a card per gateway. Paste an API key to connect:

- **OpenRouter.** The full catalog (roughly 340 models) synced from their public API. The key is validated against their key endpoint on connect.
- **OpenCode Zen.** Model list from zen's public endpoint, enriched with pricing, context windows, and capability flags from models.dev. Zen's model list needs no key, so the key is only truly verified on the first turn.
- **DeepSeek.** Their Anthropic-native endpoint. Connect validates the key against their authenticated model list, so a bad key is rejected immediately.

Model lists refresh keylessly at startup and daily, so the cards show model and free-model counts before you connect. **Manage models** opens a browser with search, filters (All, Free, Tools, Enabled), and per-model toggles. Only enabled models appear in pickers: a fresh connect enables everything, bulk actions narrow it down.

**Free models.** OpenRouter and Zen both carry free models. They get a FREE badge in the picker and browser, and paid models show their per-million pricing. Free status and pricing are always derived from the latest sync and never stored on sessions or jobs, so one resync corrects every surface, including a promo model that stops being free. When OpenRouter declares an expiry date, the badge shows it.

**Sync alerts.** An OpenRouter sync that delists, reprices, or un-frees a model you actually use (enabled, in a slot, or on a job) posts an inbox notification. Repeated sync failures alert once per episode instead of nagging.

**Utility-call pinning.** Sessions on a gateway model pin every internal default-model slot (the opus, sonnet, and haiku-class aliases plus the subagent model) to the session's models. Without this, the CLI's background utility calls would quietly bill Claude models through the gateway.

## The translation proxy

The Claude CLI speaks the Anthropic wire format only. Cockpit runs a local proxy that bridges the difference:

- **OpenAI-format upstreams** (OpenCode Zen) get full request and response translation, streaming included. A reasoning model's chain-of-thought maps to thinking blocks, so it renders in the chat the same way Claude's does.
- **Anthropic-native upstreams** (OpenRouter, DeepSeek) relay through the proxy verbatim, purely to add bounded retries on saturation errors (free-model 429s, gateway 5xx) before the CLI sees them.

Gateway models carry their real context window, and Cockpit pins the CLI's context tracking and auto-compact to it rather than the 200K the CLI would otherwise assume. Reasoning-capable gateway models expose effort levels from catalog metadata: the thinking selector shows them, and for OpenAI-format upstreams the proxy maps the chosen level onto `reasoning_effort`.

## Usage and spend

The usage indicator follows the active session's provider. Anthropic sessions show subscription limits. OpenRouter shows credit spend and key limits from their API. DeepSeek shows the account balance. Zen, which has no spend API, shows an estimate metered by Cockpit from proxied traffic at current model prices.

## Custom providers

For endpoints that are not built in, add a provider by hand. Go to Settings, open the Providers page, and add a provider. The editor has two tabs.

**General**

- **Name.** A label shown in the model picker (for example `Bedrock proxy`).
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

A custom model must declare at least one context size. Gateway models skip this: their real context window comes from the catalog.

## Selecting a provider model

Provider models appear in the model picker and in the per-session settings popover, grouped by provider, with recently used models at the top. Recent rows name their provider, since the same model ID can be served by several (Claude models exist on Anthropic, OpenRouter, and Zen). Gateways only appear in the picker once connected. Picking a model stores it on the session in the qualified form `provider:modelId`. On the next spawn, Cockpit resolves the provider, passes the bare model ID to `--model`, and applies the provider's environment.

Models can be set per slot. The **main** slot drives the conversation. The **subagent** and **fast** slots, when set to a different model, are exported to the CLI so subagents and lightweight calls can use a cheaper or faster model.

Slots are scoped to one provider per session: a CLI process has a single base URL and auth, so the non-main slots must belong to the main model's provider. Changing the main model across providers clears the other slots, and setting a cross-provider non-main slot is refused.

## Storage

Custom providers are stored in `~/.cockpit/providers.json`. The built-in gateways keep only user state there (the API key and the enabled set, plus the synced model list for Zen and DeepSeek). The OpenRouter catalog is cached in `~/.cockpit/provider-catalog.json`, and Zen's metered usage in `~/.cockpit/provider-usage.jsonl`. The Anthropic provider is constructed in code and is not written to disk. Relocate everything with `COCKPIT_CONFIG_DIR` (see [Settings](settings.md#environment-variables)).

## Notes

- The 200K/1M context-size choice applies to Anthropic models and drives the CLI's 1M-context switch: choosing 200K sets `CLAUDE_CODE_DISABLE_1M_CONTEXT` for that spawn. Gateway models use their catalog context length instead.
- A context-size change takes effect on the next CLI start, because the switch is applied at spawn time. Cockpit restarts the process for you when the size changes.
- The context gauge denominator reflects the size you picked (or, for gateway models, the model's real window), not what the API reports.
- Scheduled jobs on a gateway model that has been delisted fail rather than silently switching model. See [Scheduled jobs](scheduled-jobs.md#failure-handling).

## Subagents and effort levels

When a session spawns a subagent via the Agent tool, the subagent inherits the provider's environment variables. This means any `CLAUDE_CODE_EFFORT_LEVEL` you put in a provider's env vars applies to subagents too, not just the main session.

That causes a conflict if a subagent disables thinking (for example, the Explore agent type) while `CLAUDE_CODE_EFFORT_LEVEL=max` is also in the environment. The provider endpoint receives both `reasoning_effort=max` and `thinking.type=disabled` in the same request, which is invalid and returns a 400 error. The session then terminates without completing.

**Do not set `CLAUDE_CODE_EFFORT_LEVEL` in a provider's environment variables.** Use the job's Thinking Level setting instead. Cockpit passes the thinking level as a `--effort` CLI flag to the main session, which does not propagate to subagents. Subagents then use the model's default effort, which avoids the conflict.
