# openai-responses-uva

A [Pi](https://pi.dev) coding-agent **provider extension** for the University of
Amsterdam (UvA) LiteLLM proxy (`https://llmproxy.uva.nl/v1`).

It does two things:

1. **Fixes "thinking then nothing".** The UvA proxy speaks the OpenAI
   **Responses API** (`/v1/responses`). When a request contains no tools it
   streams normally, but when tool definitions are present — i.e. **every agent
   turn** — the proxy collapses the SSE stream to a single terminal
   `response.completed` event and emits none of the incremental delta events.
   Pi's built-in Responses parser only builds the reply from those delta events,
   so the assistant message comes back **empty, with no error**. This extension
   works around it (see [How it works](#how-it-works)).

2. **Auto-discovers every model.** It fetches `GET /v1/models` at startup and
   registers all chat/response models (filtering out embeddings, whisper,
   image, document-AI, etc.), so new UvA models appear automatically without a
   code change.

## Why the built-in provider isn't enough

If you configure UvA as a normal `openai-responses` provider in `models.json`,
reasoning models require `reasoning.effort`, which the proxy only accepts on
`/v1/responses` (not `/v1/chat/completions`). Once you switch to the Responses
API, the streaming-with-tools bug above makes every turn return nothing. This
extension is the fix.

## Install

You need Pi installed and a UvA proxy API key.

### 1. Clone

```bash
git clone https://github.com/<you>/openai-responses-uva.git
```

### 2. Set your key

```bash
# add to your shell profile (.bashrc / .zshrc / PowerShell profile)
export UVA_API_KEY="sk-...your-uva-key..."
```

### 3. Load the extension

Pick one:

- **Try it once:**
  ```bash
  pi -e /path/to/openai-responses-uva
  ```
- **Load it always** — add to `~/.pi/agent/settings.json`:
  ```jsonc
  {
    "packages": [
      "/path/to/openai-responses-uva"
    ]
  }
  ```
- **Or drop it in the auto-load folder** — copy `index.ts` to
  `~/.pi/agent/extensions/` (it is picked up automatically). If you go this
  route you can rename it, e.g. `~/.pi/agent/extensions/uva.ts`.

### 4. Use it

```bash
pi --provider uva --model gpt-5.6-sol -p "hello"
# or select a uva model interactively with /model
pi --list-models | grep uva
```

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `UVA_API_KEY` | **yes** | – | Your UvA proxy API key. |
| `UVA_BASE_URL` | no | `https://llmproxy.uva.nl/v1` | Proxy base URL (must end at the `/v1` root). |
| `UVA_PROVIDER_ID` | no | `uva` | Provider id shown in `/model` and `--provider`. |
| `UVA_MODEL_OVERRIDES_FILE` | no | – | Path to a JSON file overriding per-model capabilities (below). |

### Per-model overrides

Model capabilities (context window, max output, reasoning, vision) are inferred
from the model id using a researched family table. If the proxy exposes a model
the table doesn't know — or you disagree with a value — point
`UVA_MODEL_OVERRIDES_FILE` at a JSON file:

```json
{
  "claude-opus-4.8": { "reasoning": true, "contextWindow": 1000000, "maxTokens": 64000 },
  "some-new-model":  { "reasoning": false, "input": ["text", "image"], "contextWindow": 200000, "maxTokens": 32000 }
}
```

Each key is a model id; each value may set any of `reasoning`, `input`,
`contextWindow`, `maxTokens`, `name`, `cost`, `thinkingLevelMap`.

## How it works

For each turn the custom stream handler:

1. Lets Pi's **pristine built-in `openai-responses` handler** build the exact
   request params (full message + tool conversion, reasoning, caching) via an
   `onPayload` hook that captures the params and throws **before** the network
   call — so nothing extra is billed.
2. Reissues that request **non-streaming** (`stream: false`) to
   `…/responses`, which the proxy returns complete and correct.
3. Synthesizes Pi's content events (`text` / `thinking` / `toolCall`) from
   `response.output[]`, preserving tool-call ids and signatures so multi-turn
   tool + reasoning replay stays intact.

Turns with **no** tools are delegated to the built-in handler unchanged, so they
still stream token-by-token.

### Trade-off

Tool turns are **non-streaming** — the reply appears at once rather than
token-by-token. That is the cost of correctness while the proxy drops streaming
events under tools. Delete the extension if the proxy is ever fixed upstream or
Pi's parser learns to harvest `response.output[]` from the terminal event.

## Reasoning models

`reasoning.effort` is enabled only for the OpenAI reasoning families
(`gpt-5*`, `o*`, `gpt-oss`), where it is native to the Responses API. Anthropic /
Qwen / Mistral are registered as non-thinking chat models for reliability; flip
them on per-id via `UVA_MODEL_OVERRIDES_FILE` if your proxy translates effort for
them.

## Compatibility

- Pi coding-agent with the `@earendil-works/pi-ai` runtime (verified on 0.80.x).
- Imports only the extension-facing `@earendil-works/pi-ai` surface, so it keeps
  working across Pi updates (it does not patch `node_modules`).

## License

MIT — see [LICENSE](./LICENSE).
