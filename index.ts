/**
 * openai-responses-uva — a Pi coding-agent provider extension
 * ============================================================
 *
 * Registers the UvA LiteLLM proxy (https://llmproxy.uva.nl/v1) as a Pi model
 * provider and works around a proxy bug that otherwise makes every agent turn
 * return "thinking then nothing".
 *
 * The bug
 * -------
 * The UvA proxy speaks the OpenAI **Responses API** (`/v1/responses`). When a
 * request contains NO tool definitions it streams normally. But when tool
 * definitions ARE present (i.e. every agent turn) it collapses the SSE stream
 * to a single terminal `response.completed` event carrying the whole result in
 * `response.output[]`, and emits none of the incremental events
 * (`response.output_item.added`, `response.output_text.delta`,
 * `response.function_call_arguments.delta`, ...).
 *
 * Pi's built-in Responses stream parser builds the assistant reply purely from
 * those incremental events; its terminal handler never harvests
 * `response.output[]`. So the assistant message ends up empty — no text, no
 * tool call, no error.
 *
 * The fix
 * -------
 * This extension registers the UvA provider under a private api id so this
 * handler runs. For each turn it:
 *   1. Lets Pi's pristine built-in `openai-responses` handler BUILD the exact
 *      request params (full message + tool conversion, reasoning, caching) via
 *      an `onPayload` hook that captures the params and throws BEFORE the
 *      network call — so nothing extra is billed.
 *   2. Reissues that request itself and synthesizes Pi's content events,
 *      reconciling the incremental SSE events with the terminal
 *      `response.output[]` so the collapsed tool call is never lost.
 *
 * Two dispatch paths keep it reliable:
 *   - Non-reasoning turns STREAM (`stream:true`). Bytes flow, so the nginx
 *     gateway read-timeout keeps resetting and the reply is token-by-token.
 *   - Reasoning turns (reasoning.effort low/medium/high) use BACKGROUND + POLL
 *     (`background:true` + `GET /responses/{id}`). The model can buffer its
 *     whole reasoning phase with zero interim bytes without ever tripping a
 *     504, because each HTTP request is short. A streaming turn that still hits
 *     a gateway 5xx before any output falls back to this path automatically.
 *
 * Trade-off: reasoning replies are not token-by-token (they appear at once on
 * completion); plain turns stream normally.
 *
 * Config (environment variables)
 * ------------------------------
 *   UVA_API_KEY      required. Your UvA proxy API key.
 *   UVA_BASE_URL     optional. Default: https://llmproxy.uva.nl/v1
 *   UVA_PROVIDER_ID  optional. Default: uva
 *
 * Only imports the aliased root "@earendil-works/pi-ai" (the extension-facing
 * compat surface), so it works under Pi's jiti extension loader.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiProvider, createAssistantMessageEventStream, calculateCost } from "@earendil-works/pi-ai";

const BASE_API = "openai-responses"; // pristine built-in handler we delegate to
const CUSTOM_API = "openai-responses-uva"; // our fixed handler is registered under this
const DEFAULT_BASE_URL = "https://llmproxy.uva.nl/v1";

const PROVIDER_ID = process.env.UVA_PROVIDER_ID || "uva";
const BASE_URL = (process.env.UVA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

// Models that are not chat/response models — never register these.
const DENY = /embedding|whisper|audio|tts|speech|dall|(^|[-_])image|document-ai|ocr|rerank|moderation|guard|stable-diffusion/i;

// Known-good fallback if /v1/models discovery fails.
const FALLBACK_MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"];

// ---------------------------------------------------------------------------
// Capability table (LiteLLM /v1/models returns only ids, no metadata).
//
// Values are researched per model family (context window / max output tokens /
// whether it is a reasoning model / whether it accepts image input). Sources:
// OpenAI & Anthropic API docs, OpenRouter, artificialanalysis.ai (2026).
//
// `reasoning` is deliberately enabled ONLY for the OpenAI reasoning families
// (gpt-5*, o-series, gpt-oss) because `reasoning.effort` is native to the
// OpenAI Responses API. Anthropic / Qwen / Mistral still work perfectly as
// non-thinking chat models through the proxy; enabling effort on them is not
// reliably translated and can error. Override per-id if your proxy differs
// (see UVA_MODEL_OVERRIDES_FILE below).
//
// First matching entry wins; order matters (specific → general).
// ---------------------------------------------------------------------------

type Caps = { ctx: number; out: number; reasoning: boolean; vision: boolean };

const CAPS: Array<{ re: RegExp; caps: Caps }> = [
  // OpenAI GPT-5.x
  { re: /^gpt-5\.6/i, caps: { ctx: 1_100_000, out: 128_000, reasoning: true, vision: true } },
  { re: /^gpt-5\.[45]/i, caps: { ctx: 1_050_000, out: 128_000, reasoning: true, vision: true } },
  { re: /^gpt-5\.1/i, caps: { ctx: 400_000, out: 128_000, reasoning: true, vision: true } },
  { re: /^gpt-5(-|$)/i, caps: { ctx: 400_000, out: 128_000, reasoning: true, vision: true } }, // gpt-5 / -mini / -nano
  // OpenAI o-series (o3-mini is text-only)
  { re: /^o[134](-|$)/i, caps: { ctx: 200_000, out: 100_000, reasoning: true, vision: false } },
  // OpenAI open-weight
  { re: /gpt-oss/i, caps: { ctx: 131_072, out: 32_768, reasoning: true, vision: false } },
  // OpenAI GPT-4.x (not reasoning)
  { re: /^gpt-4\.1/i, caps: { ctx: 1_047_576, out: 32_768, reasoning: false, vision: true } },
  { re: /^gpt-4o/i, caps: { ctx: 128_000, out: 16_384, reasoning: false, vision: true } },
  { re: /^gpt-4/i, caps: { ctx: 128_000, out: 16_384, reasoning: false, vision: true } },
  { re: /model-router/i, caps: { ctx: 256_000, out: 32_768, reasoning: false, vision: true } },
  // Anthropic Claude 4.x / 5.x (thinking left off for reliable proxy translation)
  { re: /claude-opus/i, caps: { ctx: 1_000_000, out: 64_000, reasoning: false, vision: true } },
  { re: /claude-sonnet-4\.6|claude-sonnet-[5-9]/i, caps: { ctx: 1_000_000, out: 64_000, reasoning: false, vision: true } },
  { re: /claude-sonnet/i, caps: { ctx: 200_000, out: 64_000, reasoning: false, vision: true } },
  { re: /claude-haiku/i, caps: { ctx: 200_000, out: 64_000, reasoning: false, vision: true } },
  { re: /claude/i, caps: { ctx: 200_000, out: 64_000, reasoning: false, vision: true } },
  // Qwen (VL = vision; Qwen3 text — thinking not exposed via responses effort)
  { re: /qwen.*vl|vl.*qwen/i, caps: { ctx: 128_000, out: 8_192, reasoning: false, vision: true } },
  { re: /qwen/i, caps: { ctx: 262_144, out: 32_768, reasoning: false, vision: false } },
  // Mistral (small 3.x is multimodal)
  { re: /mistral-small/i, caps: { ctx: 128_000, out: 32_768, reasoning: false, vision: true } },
  { re: /mistral/i, caps: { ctx: 128_000, out: 32_768, reasoning: false, vision: false } },
  // Google (if the proxy ever exposes it)
  { re: /gemini/i, caps: { ctx: 1_000_000, out: 65_536, reasoning: false, vision: true } },
];

// Safe map for reasoning models: low/medium/high are supported by every OpenAI
// reasoning family; minimal/xhigh/max are hidden because support varies.
const REASONING_THINKING_MAP = {
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
} as const;

// Which models actually support the OpenAI Responses API on this proxy. The
// rest (gpt-oss, Mistral, Qwen, ... — open-weight vLLM deployments) 404 on
// /v1/responses and must use /v1/chat/completions instead. OpenAI GPT-4/5,
// the o-series, Claude (Anthropic), and Azure model-router speak Responses.
const RESPONSES_CAPABLE = /^(gpt-4|gpt-5|o[134]([-_]|$)|claude|model-router)/i;

function apiForModel(id: string): string {
  return RESPONSES_CAPABLE.test(id) ? CUSTOM_API : "openai-completions";
}

function resolveCaps(id: string): Caps {
  for (const { re, caps } of CAPS) if (re.test(id)) return caps;
  // Unknown / future model: infer conservatively.
  const reasoning = /gpt-5|gpt-oss/i.test(id) || /^o[134](-|$)/i.test(id);
  const vision = /gpt-4|gpt-5|claude|gemini|vl|vision|nova/i.test(id);
  return { ctx: reasoning ? 400_000 : 128_000, out: reasoning ? 128_000 : 16_384, reasoning, vision };
}

function buildModelDef(id: string, overrides: Record<string, any>) {
  const caps = resolveCaps(id);
  const ov = overrides[id] || {};
  const api = ov.api || apiForModel(id);
  const isResponses = api === CUSTOM_API;
  // Reasoning (reasoning.effort) is only wired up on the Responses fix path.
  // Chat-completions models are registered as plain chat for reliability.
  const reasoning = ov.reasoning ?? (isResponses ? caps.reasoning : false);
  const vision = ov.vision ?? caps.vision;
  return {
    id,
    name: ov.name || `${id} (UvA)`,
    api,
    reasoning,
    input: (ov.input as string[]) || (vision ? ["text", "image"] : ["text"]),
    cost: ov.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ov.contextWindow ?? caps.ctx,
    maxTokens: ov.maxTokens ?? caps.out,
    ...(reasoning ? { thinkingLevelMap: ov.thinkingLevelMap || REASONING_THINKING_MAP } : {}),
  };
}

/** Optional per-id capability overrides from a JSON file (UVA_MODEL_OVERRIDES_FILE). */
function loadOverrides(): Record<string, any> {
  const file = process.env.UVA_MODEL_OVERRIDES_FILE;
  if (!file) return {};
  try {
    // Lazy require so the module has no hard fs dependency when unused.
    const { readFileSync } = require("node:fs");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.error(`[openai-responses-uva] failed to read UVA_MODEL_OVERRIDES_FILE (${String(err)})`);
    return {};
  }
}

async function discoverModelIds(apiKey: string | undefined): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${BASE_URL}/models -> HTTP ${res.status}`);
  const data: any = await res.json();
  const ids = (Array.isArray(data?.data) ? data.data : [])
    .map((m: any) => m?.id)
    .filter((id: any): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) throw new Error("no models returned by /v1/models");
  return ids;
}

// ---------------------------------------------------------------------------
// Stream fix
// ---------------------------------------------------------------------------

function encodeTextSignatureV1(id: string, phase?: string): string {
  return JSON.stringify(phase ? { v: 1, id, phase } : { v: 1, id });
}

function mapStopReason(status: string | undefined): string {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    default:
      return "stop";
  }
}

/** Capture the exact request params the built-in handler would send, without sending. */
function captureParams(builtin: any, model: any, context: any, options: any): Promise<any> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: any) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let probe: any;
    try {
      const clone = { ...model, api: BASE_API };
      probe = builtin.streamSimple(clone, context, {
        ...options,
        onPayload: (params: any) => {
          finish(params);
          throw new Error("__uva_capture_done__");
        },
      });
    } catch {
      finish(null);
      return;
    }
    (async () => {
      try {
        for await (const _ of probe) {
          /* drain; the probe ends via the thrown onPayload */
        }
      } catch {
        /* ignore */
      }
      finish(null); // in case onPayload never ran
    })();
  });
}

/** Emit Pi content events for a single Responses `output[]` item. */
function emitOneItem(out: any, output: any, item: any): void {
  if (item?.type === "reasoning") {
    const thinking =
      (item.summary && item.summary.map((s: any) => s?.text || "").join("\n\n")) ||
      (item.content && item.content.map((c: any) => c?.text || "").join("\n\n")) ||
      "";
    const block: any = { type: "thinking", thinking, thinkingSignature: JSON.stringify(item) };
    output.content.push(block);
    const i = output.content.length - 1;
    out.push({ type: "thinking_start", contentIndex: i, partial: output });
    if (thinking) out.push({ type: "thinking_delta", contentIndex: i, delta: thinking, partial: output });
    out.push({ type: "thinking_end", contentIndex: i, content: thinking, partial: output });
  } else if (item?.type === "message") {
    const parts = Array.isArray(item.content) ? item.content : [];
    const text = parts
      .map((c: any) => (c?.type === "output_text" ? c.text || "" : c?.type === "refusal" ? c.refusal || "" : ""))
      .join("");
    const block: any = { type: "text", text, textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined) };
    output.content.push(block);
    const i = output.content.length - 1;
    out.push({ type: "text_start", contentIndex: i, partial: output });
    if (text) out.push({ type: "text_delta", contentIndex: i, delta: text, partial: output });
    out.push({ type: "text_end", contentIndex: i, content: text, partial: output });
  } else if (item?.type === "function_call") {
    let args: any = {};
    try {
      args = JSON.parse(item.arguments || "{}");
    } catch {
      args = {};
    }
    const block: any = { type: "toolCall", id: `${item.call_id}|${item.id}`, name: item.name, arguments: args };
    output.content.push(block);
    const i = output.content.length - 1;
    out.push({ type: "toolcall_start", contentIndex: i, partial: output });
    out.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: output });
  }
  // other item types (e.g. bare encrypted reasoning) are ignored
}

/**
 * Reconcile the terminal `output[]` against what was already emitted
 * incrementally. Any item whose id was NOT seen in the incremental event
 * stream is emitted now. This covers:
 *   - full collapse (no incremental events)  -> emit everything
 *   - partial collapse (e.g. text streamed but the tool call only appears in
 *     the terminal payload, as Anthropic/Bedrock does) -> emit the missing item
 */
function reconcileTerminal(out: any, output: any, terminal: any, seenIds: Set<string>): void {
  const items = Array.isArray(terminal?.output) ? terminal.output : [];
  for (const item of items) {
    const id = item?.id;
    if (id && seenIds.has(id)) continue;
    emitOneItem(out, output, item);
  }
}

function applyUsage(output: any, data: any, model: any): void {
  const u = data?.usage;
  if (u) {
    const cached = u.input_tokens_details?.cached_tokens || 0;
    const cacheWrite = u.input_tokens_details?.cache_write_tokens || 0;
    output.usage.input = Math.max(0, (u.input_tokens || 0) - cached - cacheWrite);
    output.usage.output = u.output_tokens || 0;
    output.usage.cacheRead = cached;
    output.usage.cacheWrite = cacheWrite;
    output.usage.reasoning = u.output_tokens_details?.reasoning_tokens || 0;
    output.usage.totalTokens = u.total_tokens || output.usage.input + output.usage.output + cached + cacheWrite;
  }
  try {
    calculateCost(model, output.usage);
  } catch {
    /* cost is best-effort */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// OpenAI-native families (Azure backend) accept OpenAI-only request params like
// `prompt_cache_key`. Non-OpenAI backends behind the proxy (Anthropic/Bedrock,
// Gemini/Vertex, Mistral, Qwen, ...) reject them, e.g.
//   "prompt_cache_key: Extra inputs are not permitted"
// Keep the param only for OpenAI-native ids; strip it everywhere else (the only
// cost is losing prompt caching on backends that would have accepted it).
const OPENAI_NATIVE = /^(gpt-|o[134]([-_]|$)|gpt-oss|model-router)/i;

function sanitizeParamsForModel(modelId: string, params: any): any {
  if (OPENAI_NATIVE.test(modelId)) return params;
  const p = { ...params };
  delete p.prompt_cache_key;
  delete p.prompt_cache_retention;
  return p;
}

/**
 * Translate one Responses SSE event into Pi events + block state.
 * Handles the full incremental event set (good streaming case) and records the
 * terminal `response.completed` payload (whose `output[]` is harvested by the
 * caller when the proxy sent no incremental events — the tools-collapse case).
 */
function handleSseEvent(
  evt: any,
  out: any,
  output: any,
  slots: Map<number, any>,
  seenIds: Set<string>,
  setTerminal: (r: any) => void,
): void {
  const t = evt?.type;
  if (t === "response.output_item.added") {
    const item = evt.item;
    const oi = evt.output_index;
    if (item?.id) seenIds.add(item.id);
    if (item?.type === "reasoning") {
      const block: any = { type: "thinking", thinking: "" };
      output.content.push(block);
      const ci = output.content.length - 1;
      slots.set(oi, { type: "thinking", block, ci });
      out.push({ type: "thinking_start", contentIndex: ci, partial: output });
    } else if (item?.type === "message") {
      const block: any = { type: "text", text: "" };
      output.content.push(block);
      const ci = output.content.length - 1;
      slots.set(oi, { type: "text", block, ci });
      out.push({ type: "text_start", contentIndex: ci, partial: output });
    } else if (item?.type === "function_call") {
      const block: any = {
        type: "toolCall",
        id: `${item.call_id}|${item.id}`,
        name: item.name,
        arguments: {},
        partialJson: item.arguments || "",
      };
      output.content.push(block);
      const ci = output.content.length - 1;
      slots.set(oi, { type: "toolCall", block, ci });
      out.push({ type: "toolcall_start", contentIndex: ci, partial: output });
    }
  } else if (t === "response.output_text.delta") {
    const slot = slots.get(evt.output_index);
    if (slot?.type === "text") {
      slot.block.text += evt.delta || "";
      out.push({ type: "text_delta", contentIndex: slot.ci, delta: evt.delta || "", partial: output });
    }
  } else if (t === "response.reasoning_summary_text.delta") {
    const slot = slots.get(evt.output_index);
    if (slot?.type === "thinking") {
      slot.block.thinking += evt.delta || "";
      out.push({ type: "thinking_delta", contentIndex: slot.ci, delta: evt.delta || "", partial: output });
    }
  } else if (t === "response.function_call_arguments.delta") {
    const slot = slots.get(evt.output_index);
    if (slot?.type === "toolCall") {
      slot.block.partialJson = (slot.block.partialJson || "") + (evt.delta || "");
      out.push({ type: "toolcall_delta", contentIndex: slot.ci, delta: evt.delta || "", partial: output });
    }
  } else if (t === "response.output_item.done") {
    const item = evt.item;
    if (item?.id) seenIds.add(item.id);
    const slot = slots.get(evt.output_index);
    if (item?.type === "reasoning" && slot?.type === "thinking") {
      const summary =
        (item.summary && item.summary.map((s: any) => s?.text || "").join("\n\n")) ||
        (item.content && item.content.map((c: any) => c?.text || "").join("\n\n")) ||
        slot.block.thinking;
      slot.block.thinking = summary;
      slot.block.thinkingSignature = JSON.stringify(item);
      out.push({ type: "thinking_end", contentIndex: slot.ci, content: slot.block.thinking, partial: output });
      slots.delete(evt.output_index);
    } else if (item?.type === "message" && slot?.type === "text") {
      const text =
        (item.content &&
          item.content
            .map((c: any) => (c?.type === "output_text" ? c.text || "" : c?.type === "refusal" ? c.refusal || "" : ""))
            .join("")) ||
        slot.block.text;
      slot.block.text = text;
      slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
      out.push({ type: "text_end", contentIndex: slot.ci, content: text, partial: output });
      slots.delete(evt.output_index);
    } else if (item?.type === "function_call" && slot?.type === "toolCall") {
      let args: any = {};
      try {
        args = JSON.parse(item.arguments || slot.block.partialJson || "{}");
      } catch {
        args = {};
      }
      slot.block.arguments = args;
      delete slot.block.partialJson;
      out.push({ type: "toolcall_end", contentIndex: slot.ci, toolCall: slot.block, partial: output });
      slots.delete(evt.output_index);
    }
  } else if (t === "response.completed" || t === "response.incomplete") {
    setTerminal(evt.response);
  } else if (t === "response.failed") {
    const e = evt.response?.error;
    throw new Error(`openai-responses-uva: ${e?.code || "failed"}: ${e?.message || "no message"}`);
  } else if (t === "error") {
    throw new Error(`openai-responses-uva: stream error: ${evt.message || evt.code || "unknown"}`);
  }
}

/**
 * One streaming attempt. Streaming keeps the gateway connection alive (bytes
 * flow) so slow generations don't hit an nginx 504. `state.started` is set once
 * we begin emitting, so the caller only retries failures that happen before any
 * output was produced.
 */
async function attemptStream(
  url: string,
  apiKey: string,
  body: any,
  out: any,
  output: any,
  model: any,
  signal: any,
  onResponse: any,
  state: { started: boolean },
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  try {
    await onResponse?.({ status: res.status, headers: {} }, model);
  } catch {
    /* ignore */
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    const err: any = new Error(`openai-responses-uva: HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    err.status = res.status;
    throw err;
  }

  state.started = true;
  out.push({ type: "start", partial: output });

  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  const slots = new Map<number, any>();
  const seenIds = new Set<string>();
  let terminal: any = null;
  let buffer = "";

  const drainChunk = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt: any;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      handleSseEvent(evt, out, output, slots, seenIds, (r) => (terminal = r));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      drainChunk(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
    }
  }
  if (buffer.trim()) drainChunk(buffer);

  // Close any slots the proxy left open without an output_item.done.
  for (const slot of slots.values()) {
    if (slot.type === "text") {
      out.push({ type: "text_end", contentIndex: slot.ci, content: slot.block.text, partial: output });
    } else if (slot.type === "thinking") {
      out.push({ type: "thinking_end", contentIndex: slot.ci, content: slot.block.thinking, partial: output });
    } else if (slot.type === "toolCall") {
      try {
        slot.block.arguments = JSON.parse(slot.block.partialJson || "{}");
      } catch {
        /* keep {} */
      }
      delete slot.block.partialJson;
      out.push({ type: "toolcall_end", contentIndex: slot.ci, toolCall: slot.block, partial: output });
    }
  }
  slots.clear();

  // Emit any terminal output[] items that never arrived as incremental events
  // (full or partial collapse — e.g. Anthropic/Bedrock streams text but delivers
  // the tool call only in the terminal payload).
  if (terminal) {
    reconcileTerminal(out, output, terminal, seenIds);
    applyUsage(output, terminal, model);
    output.stopReason = mapStopReason(terminal.status);
  }
}

/**
 * Background + poll path. The POST returns immediately with a stored response
 * id (status `queued`/`in_progress`), then we poll `GET /responses/{id}` until
 * it finishes. Because every HTTP request is short, the nginx gateway
 * read-timeout can never fire — this is the reliable path for long reasoning
 * turns that otherwise buffer server-side and 504.
 *
 * Trade-off: no token-by-token streaming (the proxy delivers background results
 * only as a single terminal payload), so the reply appears at once on completion.
 */
async function runBackgroundPoll(
  url: string,
  apiKey: string,
  params: any,
  out: any,
  output: any,
  model: any,
  signal: any,
  onResponse: any,
  state: { started: boolean },
): Promise<void> {
  const authHeaders = { Authorization: `Bearer ${apiKey}` };
  const body = sanitizeParamsForModel(model.id, { ...params, background: true, store: true, stream: false });

  // Enqueue (retry a couple times on gateway 5xx — the POST returns fast, so
  // this rarely trips).
  let data: any = null;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error("openai-responses-uva: aborted");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    try {
      await onResponse?.({ status: res.status, headers: {} }, model);
    } catch {
      /* ignore */
    }
    const text = await res.text();
    if (res.ok) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`openai-responses-uva: non-JSON enqueue response: ${text.slice(0, 200)}`);
      }
      break;
    }
    const gateway = res.status >= 500 && res.status < 600;
    if (gateway && attempt < 2 && !signal?.aborted) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`openai-responses-uva: HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  const id = data?.id;
  if (!id) throw new Error("openai-responses-uva: background response missing id");

  state.started = true;
  out.push({ type: "start", partial: output });

  // Poll until a terminal status. Every GET is short, so no gateway timeout.
  const getUrl = `${url}/${encodeURIComponent(id)}`;
  const deadline = Date.now() + 15 * 60 * 1000; // 15 min hard cap
  let delay = 1500;
  let getFails = 0;
  let terminal: any = null;
  while (true) {
    if (signal?.aborted) throw new Error("openai-responses-uva: aborted");
    await sleep(delay);
    let g: any;
    try {
      g = await fetch(getUrl, { headers: authHeaders, ...(signal ? { signal } : {}) });
    } catch (e: any) {
      if (signal?.aborted) throw new Error("openai-responses-uva: aborted");
      if (++getFails > 5) throw e;
      continue;
    }
    if (!g.ok) {
      if (++getFails > 5) {
        const t = await g.text().catch(() => "");
        throw new Error(`openai-responses-uva: poll HTTP ${g.status}: ${t.slice(0, 160).replace(/\s+/g, " ")}`);
      }
      continue;
    }
    getFails = 0;
    let gd: any;
    try {
      gd = await g.json();
    } catch {
      continue;
    }
    const st = gd?.status;
    if (st === "completed" || st === "incomplete") {
      terminal = gd;
      break;
    }
    if (st === "failed" || st === "cancelled") {
      const e = gd?.error;
      throw new Error(`openai-responses-uva: background ${st}: ${e?.message || e?.code || "no message"}`);
    }
    if (Date.now() > deadline) throw new Error("openai-responses-uva: background poll timed out");
    delay = Math.min(delay + 500, 3000);
  }

  // Background responses carry no incremental events — emit the whole output[].
  reconcileTerminal(out, output, terminal, new Set());
  applyUsage(output, terminal, model);
  output.stopReason = mapStopReason(terminal.status);
}

/** The replacement streamSimple for UvA models. */
function uvaStreamSimple(model: any, context: any, options: any): any {
  const out = createAssistantMessageEventStream();
  (async () => {
    const output: any = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const builtin = getApiProvider(BASE_API);
      if (!builtin) throw new Error("openai-responses-uva: built-in openai-responses handler not available");

      const origOnPayload = options?.onPayload;
      let params = await captureParams(builtin, model, context, options);
      if (!params) throw new Error("openai-responses-uva: failed to capture request params");
      if (origOnPayload) {
        const next = await origOnPayload(params, model);
        if (next !== undefined) params = next;
      }

      const apiKey = options?.apiKey || process.env.UVA_API_KEY || process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("openai-responses-uva: no API key (set UVA_API_KEY)");
      const url = String(model.baseUrl || BASE_URL).replace(/\/+$/, "") + "/responses";

      const state = { started: false };
      const effort = params?.reasoning?.effort;
      // Reasoning turns buffer server-side (the proxy sends no interim bytes
      // while the model thinks) and can 504 mid-stream. Route them straight to
      // the background+poll path where every HTTP request is short, so the
      // gateway timeout cannot fire. Non-reasoning turns (effort "none"/absent)
      // stream normally for token-by-token output.
      const preferBackground = typeof effort === "string" && effort !== "none";

      if (preferBackground) {
        await runBackgroundPoll(url, apiKey, params, out, output, model, options?.signal, options?.onResponse, state);
      } else {
        const streamBody = sanitizeParamsForModel(model.id, { ...params, stream: true });
        try {
          await attemptStream(url, apiKey, streamBody, out, output, model, options?.signal, options?.onResponse, state);
        } catch (err: any) {
          const status: number | undefined = err?.status;
          const gateway = status === undefined || (status >= 500 && status < 600);
          // Gateway failure before any output = the proxy buffered with no bytes.
          // Fall back to background+poll (also defeats the 504) instead of
          // retrying the same doomed stream.
          if (!state.started && gateway && !options?.signal?.aborted) {
            await runBackgroundPoll(url, apiKey, params, out, output, model, options?.signal, options?.onResponse, state);
          } else {
            throw err;
          }
        }
      }

      if (output.content.some((b: any) => b.type === "toolCall") && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
      out.push({ type: "done", reason: output.stopReason, message: output });
      out.end();
    } catch (error) {
      for (const block of output.content) {
        delete block.partialJson;
        delete block.index;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      out.push({ type: "error", reason: output.stopReason, error: output });
      out.end();
    }
  })();
  return out;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
  const apiKey = process.env.UVA_API_KEY;

  let ids: string[];
  try {
    ids = await discoverModelIds(apiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[openai-responses-uva] model discovery failed (${msg}); using fallback list.`);
    ids = FALLBACK_MODEL_IDS;
  }

  const overrides = loadOverrides();
  const models = ids
    .filter((id) => !DENY.test(id))
    .map((id) => buildModelDef(id, overrides));

  pi.registerProvider(PROVIDER_ID, {
    name: "UvA (Responses fix)",
    baseUrl: BASE_URL,
    apiKey: "$UVA_API_KEY",
    api: CUSTOM_API,
    models,
    streamSimple: uvaStreamSimple as any,
  });
}
