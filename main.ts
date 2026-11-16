// One endpoint over OpenRouter's free models, on both client wires.
//
// A client points at this server as if it were OpenAI or Anthropic. Every
// completion is a real call to a free model, dialled through the trial
// gateway on the trial's key; this program writes no answers of its own.
//
// Routing is the whole game: for each prompt, the free models that meet the
// prompt's requirements are ranked by the brief's own quality rating, best
// first. A refusal (429, 5xx, a provider 4xx) fails over to the next model
// on the ladder, a 5xx earns its model one retry first, and a model that
// answered 429 is cooled down for the rest of the trial so later prompts do
// not spend calls on it. Refusals a prompt recovered from are reported on
// its answer in the `x-makefun-upstream-failures` header, in order.
//
// Every choice is a function of the brief, the requests and the gateway's
// answers seen so far: no wall clock, no randomness, so a replay of the
// same trial leaves the same state.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- constants

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// Attempts one prompt may spend across the whole ladder. The gateway allows
// 60 calls a trial; six prompts times this cap stays well under it, and a
// refusal is fast, so the cap binds only when everything is failing.
const MAX_ATTEMPTS_PER_PROMPT = 6;
// One 5xx earns the same model a single retry before the ladder moves on.
const RETRIES_ON_5XX = 1;
const DIAL_TIMEOUT_MS = 20000;
// The gateway refuses a completion with no output cap: name one when the
// client's own body forgot to.
const DEFAULT_MAX_TOKENS = 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? "";
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? "";

const SCHEMA_PREFIX = "free-model-aggregator-02/";
const PROVIDER_ID = "openrouter";
const PROVIDER_PUBLIC_BASE = "https://" + "openrouter" + ".ai/api/v1";
const PROVIDER_KEY_ENV = "OPENROUTER_API_KEY";

// Fixed instants for the model lists: a reply never reads the clock.
const FIXED_OPENAI_CREATED = 1767225600;
const FIXED_ANTHROPIC_CREATED_AT = "2026-01-01T00:00:00Z";

// ---------------------------------------------------------------- small checks

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function textOf(content: unknown): string {
  // The plain text of a message content: a string itself, or its text blocks joined.
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("");
  }
  return "";
}

function numberOrZero(value: unknown): number {
  return isNumber(value) ? value : 0;
}

function stringify(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

// ---------------------------------------------------------------- the brief

function documentsIn(text: string): Json[] {
  // Every JSON object embedded in the brief's prose, in order of appearance.
  // The brief carries its machine-readable parts (the model list, the prompt
  // manifest) as JSON documents inside plain text; each is found by scanning
  // for a balanced object that parses.
  const docs: Json[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("{", index);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let at = start; at < text.length; at++) {
      const char = text[at];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = at;
          break;
        }
      }
    }
    if (end === -1) break;
    let value: unknown = null;
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      value = null;
    }
    if (isRecord(value)) {
      docs.push(value);
      index = end + 1;
    } else {
      index = start + 1;
    }
  }
  return docs;
}

interface Brief {
  models: Json[];
  prompts: Json[];
}

function readBrief(path: string): Brief {
  // The brief as {models, prompts}: the two schema documents the prompt file carries.
  const brief: Brief = { models: [], prompts: [] };
  if (!path) return brief;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return brief;
  }
  for (const doc of documentsIn(text)) {
    const schema = doc.schema;
    if (typeof schema !== "string" || !schema.startsWith(SCHEMA_PREFIX)) continue;
    if (schema.endsWith("/models/v1") && Array.isArray(doc.models)) {
      brief.models = doc.models.filter(isRecord);
    } else if (schema.endsWith("/prompts/v1") && Array.isArray(doc.prompts)) {
      brief.prompts = doc.prompts.filter(isRecord);
    }
  }
  return brief;
}

const BRIEF = readBrief(PROMPT_FILE);

function freeModels(): Json[] {
  // The models this entry may dial: the brief's free ones, in the brief's order.
  return BRIEF.models.filter((m) => m.free === true && typeof m.id === "string");
}

function buildCatalog(): Json {
  // The catalog document: one provider, exactly the free models, each dialable id once.
  const seen = new Set<string>();
  const models: Json[] = [];
  for (const model of freeModels()) {
    const modelId = model.id as string;
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    models.push({ id: modelId, free: true, context_length: model.context_length ?? null });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: PROVIDER_ID,
        base_url: PROVIDER_PUBLIC_BASE,
        key_env: PROVIDER_KEY_ENV,
        wire: "openai",
        models,
      },
    ],
  };
}

const CATALOG = buildCatalog();
const CATALOG_TEXT = stringify(CATALOG);

// ---------------------------------------------------------------- requirements and routing

function meetsRequirements(requires: Json, model: Json): boolean {
  // Whether one model's brief capabilities meet one prompt's requirements.
  if (requires.tools === true && model.tools !== true) return false;
  if (requires.vision === true && model.vision !== true) return false;
  if (requires.json === true && model.json !== true) return false;
  if (isNumber(requires.min_context)) {
    if (!isNumber(model.context_length) || model.context_length < requires.min_context) return false;
  }
  return true;
}

function requirementsFromBody(body: Json): Json {
  // Requirements read off a request body itself, when the brief has no row for it.
  let vision = false;
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (isRecord(block) && (block.type === "image" || block.type === "image_url")) vision = true;
      }
    }
  }
  const responseFormat = body.response_format;
  const responseType = isRecord(responseFormat) ? responseFormat.type : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: responseType === "json_object" || responseType === "json_schema",
  };
}

let manifestIndex = 0;

function requirementsFor(body: Json): Json {
  // The arriving prompt's requirements: the brief's manifest row, by arrival order.
  const index = manifestIndex;
  manifestIndex += 1;
  const prompts = BRIEF.prompts;
  if (index < prompts.length && isRecord(prompts[index].requires)) {
    return prompts[index].requires as Json;
  }
  return requirementsFromBody(body);
}

// Models that answered 429 this trial. A free-tier rate limit outlives the
// trial's few seconds, so a cooled model is tried only when nothing warmer
// is left. State grows from gateway answers alone, so a replay rebuilds it
// identically.
const cooledDown = new Set<string>();

function ladderFor(requires: Json, preferred: string | null): Json[] {
  // The candidate models for one prompt, best first: ranked by the brief's
  // rating, highest first, ties in the brief's order; cooled-down models
  // sort behind every warm one. A model the client named itself (a real
  // client naming a dialable id, not the trial's `auto`) goes first: the
  // request asked for that model, and the ladder behind it is the failover
  // if it refuses.
  const candidates: { position: number; model: Json; rating: number }[] = [];
  freeModels().forEach((model, position) => {
    if (meetsRequirements(requires, model)) {
      candidates.push({ position, model, rating: isNumber(model.rating_milli) ? model.rating_milli : 0 });
    }
  });
  candidates.sort((a, b) => {
    const preferredA = preferred !== null && a.model.id === preferred ? 0 : 1;
    const preferredB = preferred !== null && b.model.id === preferred ? 0 : 1;
    if (preferredA !== preferredB) return preferredA - preferredB;
    const cooledA = cooledDown.has(a.model.id as string) ? 1 : 0;
    const cooledB = cooledDown.has(b.model.id as string) ? 1 : 0;
    if (cooledA !== cooledB) return cooledA - cooledB;
    if (a.rating !== b.rating) return b.rating - a.rating;
    return a.position - b.position;
  });
  return candidates.map((entry) => entry.model);
}

function preferredModel(body: Json): string | null {
  // The dialable id a request names, when it names one: either the full
  // gateway id or the upstream spelling a provider echoes back. `auto`, a
  // name the brief does not list, or a non-free model names nothing.
  if (typeof body.model !== "string" || body.model === "auto") return null;
  for (const model of freeModels()) {
    const id = model.id as string;
    if (body.model === id || `openrouter/${body.model}` === id) return id;
  }
  return null;
}

// ---------------------------------------------------------------- wire shapes

function openaiModelList(): Json {
  return {
    object: "list",
    data: freeModels().map((m) => ({
      id: m.id,
      object: "model",
      created: FIXED_OPENAI_CREATED,
      owned_by: m.provider,
    })),
  };
}

function anthropicModelList(): Json {
  return {
    data: freeModels().map((m) => ({
      type: "model",
      id: m.id,
      display_name: typeof m.display_name === "string" ? m.display_name : m.id,
      created_at: FIXED_ANTHROPIC_CREATED_AT,
    })),
    has_more: false,
  };
}

function openaiError(message: string, errorType: string, code: string | null): Json {
  return { error: { message, type: errorType, param: null, code } };
}

function anthropicError(errorType: string, message: string): Json {
  return { type: "error", error: { type: errorType, message } };
}

function stopReasonOf(finish: unknown): string {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "content_filter") return "refusal";
  return "end_turn";
}

function argumentsOf(value: unknown): Json {
  // A tool call's arguments string as the JSON object Anthropic carries.
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

// ---------------------------------------------------------------- translations

function anthropicPartToOpenai(block: Json): Json | null {
  // One Anthropic content block as an OpenAI content part, for user messages.
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "image" && isRecord(block.source)) {
    const source = block.source;
    if (source.type === "base64") {
      const media = typeof source.media_type === "string" ? source.media_type : "image/png";
      const data = typeof source.data === "string" ? source.data : "";
      return { type: "image_url", image_url: { url: `data:${media};base64,${data}` } };
    }
    if (source.type === "url" && typeof source.url === "string") {
      return { type: "image_url", image_url: { url: source.url } };
    }
  }
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return textOf(content);
}

function anthropicToOpenai(body: Json, model: string): Json {
  // An Anthropic Messages request as the Chat Completions body the gateway speaks.
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== "") messages.push({ role: "system", content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === "assistant";
    const content = raw.content;
    if (typeof content === "string") {
      messages.push({ role: assistant ? "assistant" : "user", content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_use") continue;
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : "",
          type: "function",
          function: {
            name: typeof block.name === "string" ? block.name : "",
            arguments: stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const message: Json = { role: "assistant", content: textOf(content) || null };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      messages.push(message);
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
          content: toolResultText(block.content),
        });
        continue;
      }
      const part = anthropicPartToOpenai(block);
      if (part !== null) parts.push(part);
    }
    if (parts.length > 0) messages.push({ role: "user", content: parts });
  }

  const out: Json = { model, messages };
  if (isNumber(body.max_tokens)) out.max_tokens = body.max_tokens;
  if (isNumber(body.temperature)) out.temperature = body.temperature;
  if (isNumber(body.top_p)) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools: Json[] = [];
    for (const rawTool of body.tools) {
      if (!isRecord(rawTool) || typeof rawTool.name !== "string") continue;
      tools.push({
        type: "function",
        function: {
          name: rawTool.name,
          description: typeof rawTool.description === "string" ? rawTool.description : "",
          parameters: isRecord(rawTool.input_schema) ? rawTool.input_schema : { type: "object", properties: {} },
        },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === "auto") out.tool_choice = "auto";
    else if (choice.type === "any") out.tool_choice = "required";
    else if (choice.type === "tool" && typeof choice.name === "string") {
      out.tool_choice = { type: "function", function: { name: choice.name } };
    }
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

function openaiToAnthropic(body: Json, model: string): Json {
  // A Chat Completions answer as an Anthropic Messages object naming the dialled model.
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const text = typeof message.content === "string" ? message.content : textOf(message.content);
  if (text !== "") content.push({ type: "text", text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    const fn = call.function;
    content.push({
      type: "tool_use",
      id: typeof call.id === "string" ? call.id : "toolu_unknown",
      name: typeof fn.name === "string" ? fn.name : "",
      input: argumentsOf(fn.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    id: `msg_${typeof body.id === "string" ? body.id : "aggregate"}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReasonOf(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: numberOrZero(usage.prompt_tokens),
      output_tokens: numberOrZero(usage.completion_tokens),
    },
  };
}

// ---------------------------------------------------------------- streaming

function sseEvent(event: string | null, data: unknown): string {
  const prefix = event === null ? "" : `event: ${event}\n`;
  return `${prefix}data: ${stringify(data)}\n\n`;
}

async function* iterFrames(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  // SSE frames from a byte stream, split on the blank line that ends each frame.
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let at = buffer.indexOf("\n\n");
    while (at !== -1) {
      yield buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      at = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") yield buffer;
}

function frameWithModel(frame: string, model: string): string {
  // One upstream SSE frame with every JSON payload's `model` set to the dialled id.
  const lines: string[] = [];
  for (const line of frame.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      lines.push(line);
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") {
      lines.push(line);
      continue;
    }
    let chunk: unknown = null;
    try {
      chunk = JSON.parse(payload);
    } catch {
      chunk = null;
    }
    if (isRecord(chunk)) {
      lines.push(`data: ${stringify({ ...chunk, model })}`);
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n") + "\n\n";
}

async function* openaiStreamWithModel(chunks: AsyncIterable<Uint8Array>, model: string): AsyncGenerator<string> {
  for await (const frame of iterFrames(chunks)) {
    yield frameWithModel(frame, model);
  }
}

async function* anthropicEventsFromOpenai(chunks: AsyncIterable<Uint8Array>, model: string): AsyncGenerator<string> {
  // A Chat Completions SSE stream re-spoken as the Anthropic event sequence:
  // message_start, one content block per text run or tool call with its
  // deltas, message_delta carrying the stop reason and the usage the
  // stream's last chunk reported, message_stop. The stop reason is held
  // until the usage chunk has passed, as OpenAI sends usage after
  // finish_reason.
  let started = false;
  let finished = false;
  let pendingStop: string | null = null;
  let textIndex = -1;
  let nextIndex = 0;
  const toolIndexes = new Map<unknown, number>();
  let inputTokens = 0;
  let outputTokens = 0;

  function startEvents(): string[] {
    if (started) return [];
    started = true;
    return [
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_stream",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      }),
    ];
  }

  function closeEvents(): string[] {
    const out: string[] = [];
    if (textIndex !== -1) {
      out.push(sseEvent("content_block_stop", { type: "content_block_stop", index: textIndex }));
      textIndex = -1;
    }
    for (const index of [...toolIndexes.values()].sort((a, b) => a - b)) {
      out.push(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    }
    toolIndexes.clear();
    return out;
  }

  function finishEvents(stopReason: string): string[] {
    if (finished) return [];
    finished = true;
    return [
      ...closeEvents(),
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
      sseEvent("message_stop", { type: "message_stop" }),
    ];
  }

  function eventsOfFrame(frame: string): string[] {
    const out: string[] = [];
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        out.push(...startEvents());
        out.push(...finishEvents(pendingStop ?? "end_turn"));
        continue;
      }
      let chunk: unknown = null;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;
      if (isRecord(chunk.usage)) {
        inputTokens = numberOrZero(chunk.usage.prompt_tokens);
        outputTokens = numberOrZero(chunk.usage.completion_tokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : null;
      if (choice === null) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      out.push(...startEvents());
      if (typeof delta.content === "string" && delta.content !== "") {
        if (textIndex === -1) {
          textIndex = nextIndex;
          nextIndex += 1;
          out.push(
            sseEvent("content_block_start", {
              type: "content_block_start",
              index: textIndex,
              content_block: { type: "text", text: "" },
            }),
          );
        }
        out.push(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: textIndex,
            delta: { type: "text_delta", text: delta.content },
          }),
        );
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const upstreamIndex = isNumber(call.index) ? call.index : toolIndexes.size;
        let index = toolIndexes.get(upstreamIndex);
        const fn = isRecord(call.function) ? call.function : {};
        if (index === undefined) {
          if (textIndex !== -1) {
            out.push(sseEvent("content_block_stop", { type: "content_block_stop", index: textIndex }));
            textIndex = -1;
          }
          index = nextIndex;
          nextIndex += 1;
          toolIndexes.set(upstreamIndex, index);
          out.push(
            sseEvent("content_block_start", {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: typeof call.id === "string" && call.id !== "" ? call.id : `toolu_${index}`,
                name: typeof fn.name === "string" ? fn.name : "",
                input: {},
              },
            }),
          );
        }
        if (typeof fn.arguments === "string" && fn.arguments !== "") {
          out.push(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: fn.arguments },
            }),
          );
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        pendingStop = stopReasonOf(choice.finish_reason);
      }
    }
    return out;
  }

  for await (const frame of iterFrames(chunks)) {
    for (const event of eventsOfFrame(frame)) yield event;
  }
  if (!finished) {
    for (const event of startEvents()) yield event;
    for (const event of finishEvents(pendingStop ?? "end_turn")) yield event;
  }
}

// ---------------------------------------------------------------- the gateway

interface Upstream {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  body: AsyncIterable<Uint8Array> | null;
}

async function dial(model: string, body: Json): Promise<Upstream> {
  // POST one Chat Completions request to the gateway, naming the dialled model.
  if (GATEWAY_URL === "") throw new Error("OPENAI_BASE_URL is not set");
  const outgoing: Json = { ...body, model };
  if (!isNumber(outgoing.max_tokens) && !isNumber(outgoing.max_completion_tokens)) {
    outgoing.max_tokens = DEFAULT_MAX_TOKENS;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (outgoing.stream === true) headers.accept = "text/event-stream";
  const response = await fetch(`${GATEWAY_URL}/chat/completions`, {
    method: "POST",
    headers,
    body: stringify(outgoing),
    signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
  });
  return {
    status: response.status,
    ok: response.ok,
    text: () => response.text(),
    body: response.body === null ? null : (response.body as AsyncIterable<Uint8Array>),
  };
}

function errorCodeOf(text: string, status: number): string {
  // The refusal's own error code, read from its body when it carries one.
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (isRecord(parsed)) {
    const error = parsed.error;
    if (isRecord(error)) {
      for (const key of ["code", "type"]) {
        const value = error[key];
        if (typeof value === "string" && value !== "") return value;
      }
    }
    if (typeof parsed.code === "string" && parsed.code !== "") return parsed.code;
  }
  return `http_${status}`;
}

interface Attempt {
  model: Json | null;
  upstream: Upstream | null;
  failures: Json[];
}

async function serve(body: Json, wire: string): Promise<Attempt> {
  // Run one prompt down its ladder until a model answers or the ladder runs
  // out. The gateway body is built once per wire and re-dialled per
  // candidate. Every refusal is recorded for the answer's failure trail, a
  // 429 cools its model for the rest of the trial, and a 5xx earns one
  // same-model retry before the ladder moves on.
  const outcome: Attempt = { model: null, upstream: null, failures: [] };
  const ladder = ladderFor(requirementsFor(body), preferredModel(body));
  let attempts = 0;
  for (const model of ladder) {
    if (attempts >= MAX_ATTEMPTS_PER_PROMPT) break;
    const modelId = model.id as string;
    const gatewayBody = wire === "anthropic" ? anthropicToOpenai(body, modelId) : { ...body };
    let retriesLeft = RETRIES_ON_5XX;
    for (;;) {
      attempts += 1;
      let upstream: Upstream | null = null;
      try {
        upstream = await dial(modelId, gatewayBody);
      } catch {
        upstream = null;
      }
      if (upstream !== null && upstream.ok) {
        outcome.model = model;
        outcome.upstream = upstream;
        return outcome;
      }
      if (upstream === null) {
        outcome.failures.push({ status: 502, code: "upstream_unreachable", model: modelId });
        break;
      }
      const status = upstream.status;
      const text = await upstream.text();
      outcome.failures.push({ status, code: errorCodeOf(text, status), model: modelId });
      if (status === 429) {
        cooledDown.add(modelId);
        break;
      }
      if (status >= 500 && status < 600 && retriesLeft > 0 && attempts < MAX_ATTEMPTS_PER_PROMPT) {
        retriesLeft -= 1;
        continue;
      }
      break;
    }
  }
  return outcome;
}

// ---------------------------------------------------------------- the HTTP server

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function failuresHeader(failures: Json[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { "x-makefun-upstream-failures": stringify(failures.slice(0, 8)) };
}

function sendJson(res: ServerResponse, status: number, body: unknown, failures: Json[] = []): void {
  const raw = stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(raw),
    ...failuresHeader(failures),
  });
  res.end(raw);
}

function sendErrorBody(res: ServerResponse, wire: string, status: number, errorType: string, message: string, failures: Json[] = []): void {
  if (wire === "anthropic") {
    sendJson(res, status, anthropicError(errorType, message), failures);
  } else {
    sendJson(res, status, openaiError(message, errorType, null), failures);
  }
}

function streamHeaders(res: ServerResponse, failures: Json[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
    ...failuresHeader(failures),
  });
}

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversize = false;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      // Too large to be a request this server answers: drain and discard
      // the rest so the connection closes cleanly, and report no body.
      oversize = true;
      chunks.length = 0;
      continue;
    }
    if (!oversize) chunks.push(buffer);
  }
  if (oversize || size === 0) return null;
  let value: unknown = null;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return null;
  }
  return isRecord(value) ? value : null;
}

function giveUp(res: ServerResponse, wire: string, outcome: Attempt): void {
  // No model answered: the prompt is lost, answered as an error on the client's wire.
  const last = outcome.failures.length > 0 ? outcome.failures[outcome.failures.length - 1] : null;
  const status =
    last !== null && isNumber(last.status) && last.status >= 400 && last.status < 600 ? (last.status as number) : 502;
  if (wire === "anthropic") {
    sendErrorBody(res, wire, status, "api_error", "every free model refused this prompt", outcome.failures);
  } else {
    sendErrorBody(res, wire, status, "upstream_error", "every free model refused this prompt", outcome.failures);
  }
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    sendErrorBody(res, "openai", 400, "invalid_request_error", "the request body is not one JSON object");
    return;
  }
  const outcome = await serve(body, "openai");
  if (outcome.upstream === null || outcome.model === null) {
    giveUp(res, "openai", outcome);
    return;
  }
  const modelId = outcome.model.id as string;
  const upstream = outcome.upstream;
  if (body.stream === true) {
    streamHeaders(res, outcome.failures);
    if (upstream.body !== null) {
      for await (const frame of openaiStreamWithModel(upstream.body, modelId)) {
        res.write(frame);
      }
    }
    res.end();
    return;
  }
  const answer = await upstream.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(answer);
  } catch {
    parsed = null;
  }
  sendJson(res, 200, { ...(isRecord(parsed) ? parsed : {}), model: modelId }, outcome.failures);
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    sendErrorBody(res, "anthropic", 400, "invalid_request_error", "the request body is not one JSON object");
    return;
  }
  const outcome = await serve(body, "anthropic");
  if (outcome.upstream === null || outcome.model === null) {
    giveUp(res, "anthropic", outcome);
    return;
  }
  const modelId = outcome.model.id as string;
  const upstream = outcome.upstream;
  if (body.stream === true) {
    streamHeaders(res, outcome.failures);
    if (upstream.body !== null) {
      for await (const event of anthropicEventsFromOpenai(upstream.body, modelId)) {
        res.write(event);
      }
    }
    res.end();
    return;
  }
  const answer = await upstream.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(answer);
  } catch {
    parsed = null;
  }
  sendJson(res, 200, openaiToAnthropic(isRecord(parsed) ? parsed : {}, modelId), outcome.failures);
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (req.method === "GET" && path === "/v1/models") {
      if (req.headers["x-api-key"] !== undefined) {
        sendJson(res, 200, anthropicModelList());
      } else {
        sendJson(res, 200, openaiModelList());
      }
      return;
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      await handleChat(req, res);
      return;
    }
    if (req.method === "POST" && path === "/v1/messages") {
      await handleMessages(req, res);
      return;
    }
    const wire = path === "/v1/messages" ? "anthropic" : "openai";
    sendErrorBody(res, wire, 404, "not_found", `no route ${req.method} ${path}`);
  } catch (error) {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    if (!res.headersSent) {
      const wire = path.startsWith("/v1/messages") ? "anthropic" : "openai";
      try {
        sendErrorBody(res, wire, 500, "internal_error", "the server failed to answer");
      } catch {
        res.destroy();
      }
    } else {
      res.destroy();
    }
  }
}

// ---------------------------------------------------------------- register and poll

async function register(port: number): Promise<void> {
  const response = await fetch(`${ENV_URL}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: CATALOG }),
    signal: AbortSignal.timeout(5000),
  });
  const replyText = await response.text();
  let reply: unknown = null;
  try {
    reply = JSON.parse(replyText);
  } catch {
    reply = null;
  }
  if (isRecord(reply) && isNumber(reply.requests)) {
    log(`registered: the trial holds ${reply.requests} prompts`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(): Promise<void> {
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const response = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
      if (response.status !== 200) continue;
      const work: unknown = await response.json();
      if (isRecord(work) && work.done === true) {
        process.exit(0);
      }
    } catch {
      continue;
    }
  }
}

// ---------------------------------------------------------------- start

async function start(): Promise<void> {
  if (process.argv.slice(2).includes("--list")) {
    process.stdout.write(CATALOG_TEXT + "\n");
    return;
  }
  if (ENV_URL === "") throw new Error("MAKEFUN_ENV_URL is not set");
  if (GATEWAY_URL === "") throw new Error("OPENAI_BASE_URL is not set");
  const server = createServer((req, res) => {
    void dispatch(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no TCP address");
  const port = address.port;
  if (port === 8080) throw new Error("the OS picked 8080, which the env owns: restart the trial");
  log(`listening on 0.0.0.0:${port} with ${freeModels().length} free models`);
  await register(port);
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  void poll();
}

start().catch((error: unknown) => {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
