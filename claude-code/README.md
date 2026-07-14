# Claude Code + UvA / HvA proxy

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) is Anthropic's
terminal coding agent. It talks the Anthropic Messages API, and the proxy
exposes that API natively (`/v1/messages`), so this is the easiest setup of
all: two environment variables, no config files, no extension.

This path serves Claude models (`claude-sonnet`, `claude-opus`,
`claude-haiku`). For GPT models, use [Pi](../pi/README.md) or
[VS Code](./vscode.md) instead.

## Setup

Set two environment variables, then run `claude` as usual.

macOS / Linux (add to `~/.bashrc`, `~/.zshrc`, or `~/.profile`):

```bash
export ANTHROPIC_BASE_URL="https://llmproxy.uva.nl"      # or https://llmproxy.hva.nl
export ANTHROPIC_AUTH_TOKEN="YOUR_PROXY_KEY"
```

Windows (PowerShell) (persist for your user):

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "https://llmproxy.uva.nl", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "YOUR_PROXY_KEY", "User")
```

Open a fresh terminal so the variables take effect, then:

```bash
claude
```

Pick a Claude model with `/model` (for example `claude-sonnet-4.5`). The proxy
translates the Anthropic calls to its Bedrock backend for you.

## Choosing a model

List what your key can reach:

```bash
curl -s https://llmproxy.uva.nl/v1/models \
  -H "Authorization: Bearer YOUR_PROXY_KEY" | jq '.data[].id' | grep -i claude
```

Then set it per session with `/model <id>`, or pin a default:

```bash
export ANTHROPIC_MODEL="claude-sonnet-4.5"
```

## Notes

- Why this is clean: Claude Code is built for the Anthropic API, and the
  proxy speaks it natively. None of the OpenAI Responses-API quirks (empty tool
  turns, `reasoning_effort` rejections) apply on this path.
- Thinking: Claude's extended thinking works through the proxy. Use Claude
  Code's normal thinking controls.
- GPT models: not reachable this way. Claude Code only speaks the Anthropic
  API; a GPT model would need an Anthropic-to-OpenAI translation layer. Use
  [Pi](../pi/README.md) or [VS Code](./vscode.md) for GPT.
- Key handling: `ANTHROPIC_AUTH_TOKEN` is your proxy key. Prefer setting it
  as a user environment variable over hard-coding it in scripts.

## Troubleshooting

- 401 / authentication error: the key is wrong or expired. Re-check
  `ANTHROPIC_AUTH_TOKEN`.
- 404 / model not found: the model id isn't offered by the proxy (or isn't a
  Claude model). List models with the `curl` command above.
- Nothing happens on a new key: you set the variables in one terminal but ran
  `claude` in another. Environment variables only apply to terminals opened
  after they were set (or set at the User scope on Windows).
