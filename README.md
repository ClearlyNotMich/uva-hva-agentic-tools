# openai-responses-uva

A [Pi](https://pi.dev) coding-agent **provider extension** for the University of
Amsterdam / Amsterdam University of Applied Sciences LiteLLM proxies
(`https://llmproxy.uva.nl/v1`, `https://llmproxy.hva.nl/v1`).

It does four things:

1. **`/login` connect flow.** Run `/login` (or `/uva-login`), pick a base URL
   (UvA / HvA / custom), paste your API key, and every model is auto-discovered.
   The base URL + key are saved so the next launch reconnects automatically.

2. **Fixes "thinking then nothing".** The proxy speaks the OpenAI **Responses
   API** (`/v1/responses`). When tool definitions are present — i.e. **every
   agent turn** — it collapses the SSE stream to a single terminal
   `response.completed` event and emits none of the incremental delta events.
   Pi's built-in Responses parser only builds the reply from those delta events,
   so the assistant message comes back **empty, with no error**. This extension
   reconciles the terminal `response.output[]` so nothing is lost.

3. **Defeats the gateway 504 on long reasoning turns.** Reasoning turns buffer
   server-side (no interim bytes while the model thinks), so streaming them can
   trip an nginx 504. Those turns are reissued via `background:true` + polling
   `GET /responses/{id}`, where every HTTP request is short and the gateway
   timeout can't fire.

4. **Auto-discovers every model.** It fetches `GET /v1/models` and registers all
   chat/response models (filtering out embeddings, whisper, image, etc.).
   Models that only speak `/v1/chat/completions` (open-weight gpt-oss / Mistral /
   Qwen) are routed to Pi's built-in chat handler; OpenAI GPT + Claude use the
   Responses fix.

## Why the built-in provider isn't enough

If you configure UvA as a normal `openai-responses` provider in `models.json`,
reasoning models require `reasoning.effort`, which the proxy only accepts on
`/v1/responses` (not `/v1/chat/completions`). Once you switch to the Responses
API, the streaming-with-tools bug above makes every turn return nothing. This
extension is the fix.

## Install

You need Pi installed and a UvA/HvA proxy API key.

### 1. Load the extension

Pick one:

- **Load it always** — add to `~/.pi/agent/settings.json`:
  ```jsonc
  {
    "packages": [
      "/path/to/openai-responses-uva"
    ]
  }
  ```
- **Try it once:** `pi -e /path/to/openai-responses-uva`
- **Auto-load folder:** copy `index.ts` to `~/.pi/agent/extensions/`.

### 2. Connect with `/login`

Start Pi and run:

```
/login
```

Choose **"UvA / HvA proxy"**, pick a base URL (UvA / HvA / custom), and paste
your API key. The extension discovers every model and saves your base URL + key
to `~/.pi/agent/openai-responses-uva.json`, so the next launch reconnects with
nothing re-entered. `/uva-login` runs the same flow.

> Prefer env vars? Set `UVA_API_KEY` (and optionally `UVA_BASE_URL`) instead of
> `/login` — both work.

### 3. Pick a model

```
/models          # select any discovered model
```

Reasoning models default to **thinking ON** — `-sol` at **high**, the rest at
**medium**. Or from the CLI:

```bash
pi --provider uva --model gpt-5.6-sol --thinking high -p "hello"
```

## Configuration

`/login` is the easy path; everything is also configurable via environment
variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `UVA_API_KEY` | – | API key, if you prefer env over `/login`. |
| `UVA_BASE_URL` | `https://llmproxy.uva.nl/v1` | Proxy base URL (must end at the `/v1` root). |
| `UVA_PROVIDER_ID` | `uva` | Provider id shown in `/models` and `--provider`. |
| `UVA_CREDENTIALS_FILE` | `~/.pi/agent/openai-responses-uva.json` | Override the saved-credentials path. |
| `UVA_NO_AUTO_THINKING` | – | Set to disable the sol=high / rest=medium defaults. |
| `UVA_MODEL_OVERRIDES_FILE` | – | Path to a JSON file overriding per-model capabilities (below). |

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
2. Reissues the request itself and synthesizes Pi's content events
   (`text` / `thinking` / `toolCall`), reconciling the incremental SSE events
   with the terminal `response.output[]` by item id so a collapsed tool call is
   never lost. Tool-call ids and signatures are preserved for multi-turn replay.

Two dispatch paths keep it reliable:

- **Non-reasoning turns stream** (`stream:true`) — bytes flow, so the nginx
  gateway read-timeout keeps resetting and output is token-by-token.
- **Reasoning turns use background + poll** (`background:true` +
  `GET /responses/{id}`) — the model can buffer its whole reasoning phase with
  zero interim bytes without ever tripping a 504, because each request is short.
  A streaming turn that still hits a gateway 5xx before any output falls back to
  this path automatically.

Params incompatible with non-OpenAI backends (`prompt_cache_key` on
Bedrock/Vertex) are stripped per-model.

### Trade-off

Reasoning replies are **not** token-by-token — they appear at once on completion
(the proxy only delivers background results as a single terminal payload).
Non-reasoning turns stream normally.

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
