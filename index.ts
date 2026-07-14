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
 *   2. Reissues that request NON-STREAMING (`stream:false`) — which this proxy
 *      returns complete and correct — and synthesizes Pi's content events from
 *      `response.output[]`.
 *
 * Trade-off: UvA replies are non-streaming (the answer appears at once instead
 * of token-by-token) on tool turns. Plain turns (no tools) still stream.
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
  const reasoning = ov.reasoning ?? caps.reasoning;
  const vision = ov.vision ?? caps.vision;
  return {
    id,
    name: ov.name || `${id} (UvA)`,
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

/** Emit Pi content events from a non-streaming Responses `output[]`. */
function emitFromOutput(out: any, output: any, data: any): void {
  const items = Array.isArray(data?.output) ? data.output : [];
  for (const item of items) {
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

/** The replacement streamSimple for UvA models. */
function uvaStreamSimple(model: any, context: any, options: any): any {
  const builtin = getApiProvider(BASE_API);

  // No tools in this request => the proxy streams fine. Delegate to the built-in
  // handler for real token-by-token streaming. (context.tools is exactly what
  // Pi's buildParams checks to decide whether to send tool definitions.)
  const hasTools = Array.isArray(context?.tools) && context.tools.length > 0;
  if (hasTools === false && builtin) {
    return builtin.streamSimple({ ...model, api: BASE_API }, context, options);
  }

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

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ ...params, stream: false }),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      try {
        await options?.onResponse?.({ status: res.status, headers: {} }, model);
      } catch {
        /* ignore */
      }
      const bodyText = await res.text();
      let data: any;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new Error(`openai-responses-uva: non-JSON response (HTTP ${res.status}): ${bodyText.slice(0, 300)}`);
      }
      if (!res.ok || data?.error) {
        const detail = data?.error ? JSON.stringify(data.error) : JSON.stringify(data).slice(0, 400);
        throw new Error(`openai-responses-uva: HTTP ${res.status}: ${detail}`);
      }

      out.push({ type: "start", partial: output });
      emitFromOutput(out, output, data);
      applyUsage(output, data, model);
      output.stopReason = mapStopReason(data?.status);
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
