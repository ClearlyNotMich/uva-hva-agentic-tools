# Pi extension (uva-hva-ai-coding)

> Part of [uva-hva-ai-coding](../README.md). This is the **Pi** guide; for other
> tools see [Claude Code](../docs/claude-code.md), [VS Code](../docs/vscode.md),
> or [OpenCode](../docs/opencode.md).

A [Pi](https://pi.dev) coding-agent **provider extension** for the University of
Amsterdam / Amsterdam University of Applied Sciences LiteLLM proxies
(`https://llmproxy.uva.nl/v1`, `https://llmproxy.hva.nl/v1`).

Get every UvA/HvA model working in Pi in under a minute, without editing Pi's config
files. Load the extension, run `/login`, pick your proxy, paste your API key, and
it auto-discovers all available models so you can select one straight from
`/models`. Your base URL and key are saved, so the next launch just reconnects.
Reasoning models come pre-tuned (thinking on, `sol` at high, the rest at medium),
and tool-heavy agent turns that would otherwise silently come back empty on this
proxy just work. That's the whole setup; everything below is optional detail.

## Install

You need Pi installed and a UvA/HvA proxy API key.

### 1. Load the extension

Pick one:

- **Load it always:** clone the repo and add the `pi/` folder to
  `~/.pi/agent/settings.json`:
  ```jsonc
  {
    "packages": [
      "/path/to/uva-hva-ai-coding/pi"
    ]
  }
  ```
- **Try it once:** `pi -e /path/to/uva-hva-ai-coding/pi`
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
> `/login`. Both work.

### 3. Pick a model

```
/models          # select any discovered model
```

Reasoning models default to **thinking ON**: `-sol` at **high**, the rest at
**medium**. Or from the CLI:

```bash
pi --provider uva --model gpt-5.6-sol --thinking high -p "hello"
```

## Configuration

`/login` is the easy path; everything is also configurable via environment
variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `UVA_API_KEY` | - | API key, if you prefer env over `/login`. |
| `UVA_BASE_URL` | `https://llmproxy.uva.nl/v1` | Proxy base URL (must end at the `/v1` root). |
| `UVA_PROVIDER_ID` | `uva` | Provider id shown in `/models` and `--provider`. |
| `UVA_CREDENTIALS_FILE` | `~/.pi/agent/openai-responses-uva.json` | Override the saved-credentials path. |
| `UVA_NO_AUTO_THINKING` | - | Set to disable the sol=high / rest=medium defaults. |
| `UVA_MODEL_OVERRIDES_FILE` | - | Path to a JSON file overriding per-model capabilities (below). |

### Per-model overrides

Capabilities come from the proxy metadata (with a name-table fallback). To pin a
value yourself there are two ways.

**Interactive menu (easiest):** run `/configure-models`. Pick a model, then set
its context window and max output (type the number), toggle reasoning on/off,
and choose the default thinking level applied when that model is selected. Two
options at the end, **Save & apply changes** and **Discard & exit**. Saved
overrides are written to `~/.pi/agent/openai-responses-uva.models.json` and
applied live (and on every future launch).

**By hand:** point `UVA_MODEL_OVERRIDES_FILE` at a JSON file (this overrides the
default path above):

```json
{
  "gpt-5.6-sol":    { "contextWindow": 1100000, "maxTokens": 128000, "defaultThinkingLevel": "high" },
  "some-new-model": { "reasoning": false, "input": ["text", "image"], "contextWindow": 200000, "maxTokens": 32000 }
}
```

Each key is a model id; each value may set any of `reasoning`,
`defaultThinkingLevel` (`off`/`low`/`medium`/`high`), `input`, `contextWindow`,
`maxTokens`, `vision`, `name`, `cost`, `thinkingLevelMap`.

## What it fixes

The proxy speaks the OpenAI **Responses API** (`/v1/responses`), and reasoning
models require `reasoning.effort`, which the proxy only accepts there, not on
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
is the fix, and adds `/login`, model auto-discovery, and the thinking defaults.

## How it works

For each turn the custom stream handler:

1. Lets Pi's **pristine built-in `openai-responses` handler** build the exact
   request params (full message + tool conversion, reasoning, caching) via an
   `onPayload` hook that captures the params and throws **before** the network
   call, so nothing extra is billed.
2. Reissues the request itself and synthesizes Pi's content events
   (`text` / `thinking` / `toolCall`), reconciling the incremental SSE events
   with the terminal `response.output[]` by item id so a collapsed tool call is
   never lost. Tool-call ids and signatures are preserved for multi-turn replay.

Two dispatch paths keep it reliable:

- **Non-reasoning turns stream** (`stream:true`): bytes flow, so the nginx
  gateway read-timeout keeps resetting and output is token-by-token.
- **Reasoning turns use background + poll** (`background:true` +
  `GET /responses/{id}`): the model can buffer its whole reasoning phase with
  zero interim bytes without ever tripping a 504, because each request is short.
  A streaming turn that still hits a gateway 5xx before any output falls back to
  this path automatically.

Params incompatible with non-OpenAI backends (`prompt_cache_key` on
Bedrock/Vertex) are stripped per-model.

### Robust to model changes

The UvA/HvA line-up changes often, so nothing about specific models is
hard-coded. On connect the extension reads the proxy's own
`/model_group/info` and derives each model's context window, max output,
reasoning/vision support, cost, and backend directly from it, then decides the
endpoint from the backend (`azure`/`bedrock` speak the Responses API;
open-weight `openai`/vLLM models use chat-completions). If that metadata
endpoint is ever unavailable it falls back to `/v1/models` plus a researched
name table, and if a model is still mis-routed, a Responses turn that 404s is
**self-healed** at runtime (retried on chat-completions and remembered). So even
if every current model is replaced with new ones, discovery, capabilities, and
routing keep working with no code change.

### Trade-off

Reasoning replies are **not** token-by-token; they appear at once on completion
(the proxy only delivers background results as a single terminal payload).
Non-reasoning turns stream normally.

## Reasoning models

Reasoning is enabled per model from the proxy metadata (`supports_reasoning` or a
`reasoning_effort` parameter), with the name table as a fallback, but only on the
Responses route (chat-completions rejects `reasoning_effort` alongside tools).
Reasoning models default to thinking ON: any `-sol` model at **high**, the rest
at **medium** (disable with `UVA_NO_AUTO_THINKING=1`). Override any model's
capabilities per-id via `UVA_MODEL_OVERRIDES_FILE`.

## Compatibility

- Pi coding-agent with the `@earendil-works/pi-ai` runtime (verified on 0.80.x).
- Imports only the extension-facing `@earendil-works/pi-ai` surface, so it keeps
  working across Pi updates (it does not patch `node_modules`).

## Recommended extensions

Pi becomes far more capable with a few extensions. These are the ones I run
alongside this provider, grouped by what they do, with install commands below.

### Context, memory & compaction

| Extension | What it does |
| --- | --- |
| [pi-lean-ctx](https://leanctx.com) | Routes `bash`/`read`/`grep`/`find`/`ls` through lean-ctx for big token savings, plus an embedded MCP bridge. |
| [context-mode](https://github.com/mksglu/context-mode) | Offloads large tool/command output into a sandbox so it never floods your context window. |
| [pi-smart-compact](https://github.com/alpertarhan/pi-smart-compact) | Verification-oriented smart compaction: deterministic extraction, synthesis, and metrics. |
| [gentle-engram](https://github.com/Gentleman-Programming/engram) | Persistent memory shared across sessions, compactions, and MCP agents. |

### Planning, workflows & subagents

| Extension | What it does |
| --- | --- |
| [@juicesharp/rpiv-pi](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-pi) | Skill-based dev workflow: discover → research → design → plan → implement → validate → review. |
| [pi-code-planner](https://github.com/m62624/pi-code-planner) | Structured planning, TDD, and Git worktrees for local coding agents. |
| [@gotgenes/pi-subagents](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents) | In-process sub-agent core with a typed API and lifecycle events. |
| [@quintinshaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) | Fan a task across hundreds of subagents with real model routing and cost accounting. |
| [@juicesharp/rpiv-workflow](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-workflow) | Chain skills into typed multi-stage workflows with audited state. |
| [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | A live todo overlay for the model that survives `/reload` and compaction. |

### Providers & models

| Extension | What it does |
| --- | --- |
| [pi-multi-account](https://github.com/Sarrius/pi-multi-account) | Automatic multi-account failover & rotation across Anthropic, OpenAI, Qwen, Ollama. |
| [glm-vision](https://www.npmjs.com/package/glm-vision) | Gives non-vision GLM models (z.ai) image understanding via GLM-4.6V. |

### Tools & UX

| Extension | What it does |
| --- | --- |
| [@juicesharp/rpiv-web-tools](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-web-tools) | Web search + fetch for the model with pluggable providers (Brave, Tavily, Exa, …). |
| [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | Connect any MCP (Model Context Protocol) server to Pi. |
| [@amaster.ai/pi-computer-use](https://github.com/TGYD-helige/pi) | Desktop automation via `computer_use_*` tools. |
| [pi-image-paste](https://github.com/tuanhung303/pi-image-paste) | Turns pasted image paths into first-class image attachments. |
| [@trevonistrevon/pi-loop](https://github.com/trvon/pi-loop) | Cron/event re-wake loops and background process monitoring. |
| [@juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | Lets the model ask you a structured, typed questionnaire instead of guessing. |
| [@juicesharp/rpiv-advisor](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) | A second opinion the model can request from a stronger reviewer model. |
| [@juicesharp/rpiv-args](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-args) | `$1` / `$ARGUMENTS` placeholders and shell substitution in skills. |
| [@juicesharp/rpiv-i18n](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-i18n) | Localization foundation for the `rpiv-*` skills (`/languages`, `--locale`). |

### Code quality

| Extension | What it does |
| --- | --- |
| [pi-simplify](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify) | Reviews recently changed code for clarity, consistency, and maintainability. |
| [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) | Optimizes RTK command rewriting and tool-output compaction. |

### Install them

Pi auto-installs anything listed in the `packages` array of
`~/.pi/agent/settings.json` on the next launch, with no manual `npm install`.

**All at once:** merge this into your `packages` array (keep any entries you
already have), then restart Pi:

```jsonc
{
  "packages": [
    "npm:pi-lean-ctx",
    "npm:context-mode",
    "npm:pi-smart-compact",
    "npm:gentle-engram",
    "npm:@juicesharp/rpiv-pi",
    "npm:pi-code-planner",
    "npm:@gotgenes/pi-subagents",
    "npm:@quintinshaw/pi-dynamic-workflows",
    "npm:@juicesharp/rpiv-workflow",
    "npm:@juicesharp/rpiv-todo",
    "npm:pi-multi-account",
    "npm:glm-vision",
    "npm:@juicesharp/rpiv-web-tools",
    "npm:pi-mcp-adapter",
    "npm:@amaster.ai/pi-computer-use",
    "npm:pi-image-paste",
    "npm:@trevonistrevon/pi-loop",
    "npm:@juicesharp/rpiv-ask-user-question",
    "npm:@juicesharp/rpiv-advisor",
    "npm:@juicesharp/rpiv-args",
    "npm:@juicesharp/rpiv-i18n",
    "npm:pi-simplify",
    "npm:pi-rtk-optimizer"
  ]
}
```

**One by one:** add a single line to the same `packages` array and restart Pi.
Each entry is just `"npm:<name>"`, e.g.:

```jsonc
"packages": [
  "npm:pi-lean-ctx"
]
```

### Setup notes (extensions with a background DB or service)

Most of these are pure extensions that work the moment they're in `packages`. A
few run a background database or service and need one extra thing to work on a
single install:

- **Node ≥ 22.5.0, required by `context-mode`.** It stores its knowledge base in
  SQLite and relies on Node's built-in `node:sqlite` (older Node falls back to a
  native module that can crash). Check with `node -v`. Its `postinstall`
  auto-wires the Pi hooks and heals the native binding, so no manual setup is
  needed. Just verify afterward with `/context-mode:ctx-doctor` (or
  `npx context-mode doctor`). If an install ever complains about
  `better-sqlite3`, upgrading Node to 22.5+ is the fix.

- **`gentle-engram` needs the Engram backend.** The npm package is only the Pi
  bridge: persistence is handled by a separate `engram` binary that it launches
  as an MCP server. Install Engram from
  [Gentleman-Programming/engram](https://github.com/Gentleman-Programming/engram)
  and make sure `engram` is on your `PATH` (or set `ENGRAM_BIN`); otherwise the
  memory tools load but nothing is saved. Also keep only **one** engram entry in
  `packages`: `npm:gentle-engram`, not a second pinned copy like
  `npm:gentle-engram@0.1.8`.

- **`pi-lean-ctx` installs a shell allowlist.** It routes `bash`/`read`/`grep`/
  `find`/`ls` through lean-ctx (big token savings) and runs an embedded MCP
  bridge by default. It vendors its own binary (no separate install), but its
  security allowlist can block some shell commands (e.g. `node -e`, certain glob
  or command-substitution patterns). If a command is blocked, allow it with
  `lean-ctx allow <cmd>`, edit `~/.config/lean-ctx/config.toml`, or set
  `LEAN_CTX_ALLOWLIST_WARN_ONLY=1` to downgrade blocks to warnings.

> Some of these overlap in purpose (multiple planners/workflow engines, several
> compaction strategies, and both `context-mode` and `pi-lean-ctx` wrap tool
> output). Start with the context/memory group, then add planning and tools as
> you need them rather than enabling all 25 at once.

## License

MIT. See [LICENSE](./LICENSE).
