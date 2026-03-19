# Model configuration

Learn about the Claude Code model configuration, including model aliases like `opusplan`

## Available models

For the `model` setting in Claude Code, you can configure either:

* A **model alias**
* A **model name**
  * Anthropic API: A full model name
  * Bedrock: an inference profile ARN
  * Foundry: a deployment name
  * Vertex: a version name

### Model aliases

Model aliases provide a convenient way to select model settings without
remembering exact version numbers:

| Model alias      | Behavior                                                                |
| ---------------- | ----------------------------------------------------------------------- |
| **`default`**    | Recommended model setting, depending on your account type               |
| **`sonnet`**     | Uses the latest Sonnet model (currently Sonnet 4.6) for daily coding    |
| **`opus`**       | Uses the latest Opus model (currently Opus 4.6) for complex reasoning   |
| **`haiku`**      | Uses the fast and efficient Haiku model for simple tasks                |
| **`sonnet[1m]`** | Uses Sonnet with a 1 million token context window for long sessions     |
| **`opus[1m]`**   | Uses Opus with a 1 million token context window for long sessions       |
| **`opusplan`**   | Uses `opus` during plan mode, then switches to `sonnet` for execution   |

Aliases always point to the latest version. To pin to a specific version, use the full model name (for example, `claude-opus-4-6`) or set the corresponding environment variable like `ANTHROPIC_DEFAULT_OPUS_MODEL`.

### Setting your model

You can configure your model in several ways, listed in order of priority:

1. **During session** - Use `/model <alias|name>` to switch models mid-session
2. **At startup** - Launch with `claude --model <alias|name>`
3. **Environment variable** - Set `ANTHROPIC_MODEL=<alias|name>`
4. **Settings** - Configure permanently in your settings file using the `model` field.

Example usage:

```bash
# Start with Opus
claude --model opus

# Switch to Sonnet during session
/model sonnet
```

Example settings file:

```json
{
    "permissions": {
        ...
    },
    "model": "opus"
}
```

## Restrict model selection

Enterprise administrators can use `availableModels` in managed or policy settings to restrict which models users can select.

When `availableModels` is set, users cannot switch to models not in the list via `/model`, `--model` flag, Config tool, or `ANTHROPIC_MODEL` environment variable.

```json
{
  "availableModels": ["sonnet", "haiku"]
}
```

### Default model behavior

The Default option in the model picker is not affected by `availableModels`. It always remains available and represents the system's runtime default based on the user's subscription tier.

Even with `availableModels: []`, users can still use Claude Code with the Default model for their tier.

### Control the model users run on

To fully control the model experience, use `availableModels` together with the `model` setting:

* **availableModels**: restricts what users can switch to
* **model**: sets the explicit model override, taking precedence over the Default

This example ensures all users run Sonnet 4.6 and can only choose between Sonnet and Haiku:

```json
{
  "model": "sonnet",
  "availableModels": ["sonnet", "haiku"]
}
```

### Merge behavior

When `availableModels` is set at multiple levels, such as user settings and project settings, arrays are merged and deduplicated. To enforce a strict allowlist, set `availableModels` in managed or policy settings which take highest priority.

## Special model behavior

### `default` model setting

The behavior of `default` depends on your account type:

* **Max and Team Premium**: defaults to Opus 4.6
* **Pro and Team Standard**: defaults to Sonnet 4.6
* **Enterprise**: Opus 4.6 is available but not the default

Claude Code may automatically fall back to Sonnet if you hit a usage threshold with Opus.

### `opusplan` model setting

The `opusplan` model alias provides an automated hybrid approach:

* **In plan mode** - Uses `opus` for complex reasoning and architecture decisions
* **In execution mode** - Automatically switches to `sonnet` for code generation and implementation

### Adjust effort level

Effort levels control adaptive reasoning, which dynamically allocates thinking based on task complexity. Lower effort is faster and cheaper for straightforward tasks, while higher effort provides deeper reasoning for complex problems.

Three levels persist across sessions: **low**, **medium**, and **high**. A fourth level, **max**, provides the deepest reasoning with no constraint on token spending, so responses are slower and cost more than at `high`. `max` is available on Opus 4.6 only and applies to the current session without persisting. Opus 4.6 defaults to medium effort for Max and Team subscribers.

**Setting effort:**

* **`/effort`**: run `/effort low`, `/effort medium`, `/effort high`, or `/effort max` to change the level, or `/effort auto` to reset to the model default
* **In `/model`**: use left/right arrow keys to adjust the effort slider when selecting a model
* **`--effort` flag**: pass `low`, `medium`, `high`, or `max` to set the level for a single session when launching Claude Code
* **Environment variable**: set `CLAUDE_CODE_EFFORT_LEVEL` to `low`, `medium`, `high`, `max`, or `auto`
* **Settings**: set `effortLevel` in your settings file to `"low"`, `"medium"`, or `"high"`

The environment variable takes precedence, then your configured level, then the model default.

### Extended context

Opus 4.6 and Sonnet 4.6 support a 1 million token context window for long sessions with large codebases.

Availability varies by model and plan. On Max, Team, and Enterprise plans, Opus is automatically upgraded to 1M context with no additional configuration. This applies to both Team Standard and Team Premium seats.

| Plan                      | Opus 4.6 with 1M context | Sonnet 4.6 with 1M context |
| ------------------------- | ------------------------ | -------------------------- |
| Max, Team, and Enterprise | Included with subscription | Requires extra usage      |
| Pro                       | Requires extra usage     | Requires extra usage       |
| API and pay-as-you-go     | Full access              | Full access                |

To disable 1M context entirely, set `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. This removes 1M model variants from the model picker.

The 1M context window uses standard model pricing with no premium for tokens beyond 200K.

You can also use the `[1m]` suffix with model aliases or full model names:

```bash
# Use the opus[1m] or sonnet[1m] alias
/model opus[1m]
/model sonnet[1m]

# Or append [1m] to a full model name
/model claude-opus-4-6[1m]
```

## Checking your current model

You can see which model you're currently using in several ways:

1. In status line (if configured)
2. In `/status`, which also displays your account information.

## Environment variables

You can use the following environment variables, which must be full model names (or equivalent for your API provider), to control the model names that the aliases map to.

| Environment variable             | Description                                                              |
| -------------------------------- | ------------------------------------------------------------------------ |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`   | The model to use for `opus`, or for `opusplan` when Plan Mode is active  |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | The model to use for `sonnet`, or for `opusplan` when not in Plan Mode   |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL`  | The model to use for `haiku`, or background functionality                |
| `CLAUDE_CODE_SUBAGENT_MODEL`     | The model to use for subagents                                           |

Note: `ANTHROPIC_SMALL_FAST_MODEL` is deprecated in favor of `ANTHROPIC_DEFAULT_HAIKU_MODEL`.

### Pin models for third-party deployments

When deploying Claude Code through Bedrock, Vertex AI, or Foundry, pin model versions before rolling out to users.

Without pinning, Claude Code uses model aliases (`sonnet`, `opus`, `haiku`) that resolve to the latest version. When Anthropic releases a new model, users whose accounts don't have the new version enabled will break silently.

Set all three model environment variables to specific version IDs as part of your initial setup.

### Prompt caching configuration

Claude Code automatically uses prompt caching to optimize performance and reduce costs. You can disable prompt caching globally or for specific model tiers:

| Environment variable            | Description                                                    |
| ------------------------------- | -------------------------------------------------------------- |
| `DISABLE_PROMPT_CACHING`        | Set to `1` to disable for all models (overrides per-model)     |
| `DISABLE_PROMPT_CACHING_HAIKU`  | Set to `1` to disable for Haiku models only                    |
| `DISABLE_PROMPT_CACHING_SONNET` | Set to `1` to disable for Sonnet models only                   |
| `DISABLE_PROMPT_CACHING_OPUS`   | Set to `1` to disable for Opus models only                     |
