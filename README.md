# openai-responses-uva

A [Pi](https://pi.dev) coding-agent **provider extension** for the University of
Amsterdam / Amsterdam University of Applied Sciences LiteLLM proxies
(`https://llmproxy.uva.nl/v1`, `https://llmproxy.hva.nl/v1`).

Get every UvA/HvA model working in Pi in under a minute — no editing Pi's config
files. Load the extension, run `/login`, pick your proxy, paste your API key, and
it auto-discovers all available models so you can select one straight from
`/models`. Your base URL and key are saved, so the next launch just reconnects.
Reasoning models come pre-tuned (thinking on, `sol` at high, the rest at medium),
and tool-heavy agent turns that would otherwise silently come back empty on this
proxy just work. That's the whole setup — everything below is optional detail.

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

## What it fixes

The proxy speaks the OpenAI **Responses API** (`/v1/responses`), and reasoning
models require `reasoning.effort` — which the proxy only accepts there, not on
`/v1/chat/completions`. But on the Responses API this proxy has two rough edges:

- **Empty tool turns.** When tool definitions are present (i.e. every agent
  turn) it collapses the SSE stream to a single terminal `response.completed`
  event and drops the incremental deltas, so Pi's built-in parser builds an
  **empty** reply with no error. This extension reconciles the terminal
  `response.output[]` so nothing is lost.
- **Gateway 504 on long reasoning.** Reasoning turns buffer server-side with no
  interim bytes, so streaming them can trip an nginx 504. Those turns are
  reissued via `background:true` + polling, where each request is short and the
  timeout can't fire.

A plain `openai-responses` provider in `models.json` hits both. This extension
is the fix — and adds `/login`, model auto-discovery, and the thinking defaults.

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
