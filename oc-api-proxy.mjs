// oc-api-proxy.mjs — OpenCode free models as OpenAI/Anthropic APIs.
//
// Why this exists: since ~2026-09-17 the OpenCode Zen free tier rejects every
// client except the genuine opencode binary (TLS-fingerprint gate). Header
// spoofing no longer works. This proxy drives the real binary's local
// `opencode serve` API, so upstream calls are made by the genuine client.
//
// Works with both opencode v1 and v2 server APIs; the generation is detected
// at startup. v2 turn: POST /api/session → /api/session/:id/prompt →
// /api/experimental/session/:id/wait → GET /api/session/:id/message.
// v1 turn: POST /session → POST /session/:id/message (already synchronous).
//
// Usage:
//   node oc-api-proxy.mjs                 # auto-spawns `opencode serve`
//   OC_SERVER=http://127.0.0.1:13284 \    # or use an already-running server
//   OC_PASSWORD=pass node oc-api-proxy.mjs
//
// Env:
//   PROXY_PORT   port for this proxy          (default 6447)
//   OC_BIN       path to opencode binary      (default ~/.opencode/bin/opencode)
//   OC_WORKDIR   working dir for the agent    (default ./oc-workspace)
//   OC_SERVER    reuse an existing opencode serve instance
//   OC_USERNAME  basic-auth user for OC_SERVER (default "opencode")
//   OC_PASSWORD  basic-auth password for OC_SERVER
//   OC_TIMEOUT   per-request timeout in sec   (default 600)
//
// Session behavior:
//   - Send header `x-oc-session: <name>` (or OpenAI `user` field, or
//     Anthropic metadata.user_id) to get a persistent multi-turn conversation.
//   - Without a key, every request is a fresh self-contained session whose
//     full message history is replayed as a transcript.
//
// Limitation: client-supplied `tools` schemas are not forwarded; the opencode
// agent runs its own built-in tools (read/edit/bash) server-side and folds
// results into the reply text.

import express from "express";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY_PORT = Number(process.env.PROXY_PORT || 6447);
const OC_SERVER = process.env.OC_SERVER;
const OC_USERNAME = process.env.OC_USERNAME || "opencode";
const OC_PASSWORD = process.env.OC_PASSWORD;
const OC_BIN = process.env.OC_BIN || findBinary();
const OC_WORKDIR = process.env.OC_WORKDIR || path.join(HERE, "oc-workspace");
const REQUEST_TIMEOUT = Number(process.env.OC_TIMEOUT || 600) * 1000;

function findBinary() {
  const candidates = [
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "opencode";
}

// ── API keys (same scheme as server.mjs) ────────────────────────────
const keysFile = process.env.KEYS_FILE || path.join(HERE, "api-keys.json");
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) if (tok === key) return name;
  return null;
}

// ── opencode serve backend ──────────────────────────────────────────
let ocBase = null;
let ocAuth = null;
let apiVersion = null; // "v1" | "v2", detected at startup

// Probe which server API generation this opencode is serving. v2 answers
// /api/info with a version; v1 has no /api/* routes but returns its provider
// list at /provider. (Unknown paths may answer 200 with HTML, so each probe
// must validate the JSON shape, not just the status code.)
async function detectApi() {
  for (let i = 0; i < 60; i++) {
    try {
      const v2 = await ocReq("GET", "/api/info");
      if (v2.status === 200 && v2.json?.version) {
        apiVersion = "v2";
        console.log(`[OC] opencode v2 API detected (v${v2.json.version})`);
        return;
      }
      const v1 = await ocReq("GET", "/provider");
      if (v1.status === 200 && v1.json?.all) {
        apiVersion = "v1";
        console.log("[OC] opencode v1 API detected");
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("opencode serve did not become healthy");
}

function ocReq(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(ocBase + pathname);
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: {
          ...(ocAuth ? { Authorization: ocAuth } : {}),
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("opencode request timed out")); });
    if (data) req.write(data);
    req.end();
  });
}

async function startBackend() {
  if (OC_SERVER) {
    ocBase = OC_SERVER.replace(/\/$/, "");
    ocAuth = OC_PASSWORD
      ? "Basic " + Buffer.from(`${OC_USERNAME}:${OC_PASSWORD}`).toString("base64")
      : null;
    await detectApi();
    return;
  }
  if (OC_BIN === "opencode" && !fs.existsSync("/usr/bin/opencode")) {
    try {
      const { execSync } = await import("child_process");
      execSync("command -v opencode", { stdio: "ignore" });
    } catch {
      throw new Error("opencode binary not found — set OC_BIN or install opencode");
    }
  }
  fs.mkdirSync(OC_WORKDIR, { recursive: true });
  const password = "oc-" + crypto.randomBytes(12).toString("hex");
  const child = spawn(OC_BIN, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    cwd: OC_WORKDIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("exit", (code) => console.log("[OC] opencode serve exited with code", code));
  process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("opencode serve did not start within 45s")), 45000);
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/listening on https?:\/\/[^:]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`opencode serve exited early (code ${c})`)); });
  });
  ocBase = `http://127.0.0.1:${port}`;
  ocAuth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  console.log(`[OC] opencode serve backend on ${ocBase}`);
  await detectApi();
}

// ── models ──────────────────────────────────────────────────────────
let modelCache = null;
async function getModels() {
  if (modelCache) return modelCache;
  if (apiVersion === "v2") {
    const r = await ocReq("GET", "/api/model");
    const all = r.status === 200 ? r.json?.data : null;
    if (!Array.isArray(all)) throw new Error("failed to list opencode models");
    modelCache = [
      ...new Set(
        all
          .filter((m) => m.providerID === "opencode" && m.enabled !== false)
          .map((m) => m.modelID || m.id)
      ),
    ];
  } else {
    const r = await ocReq("GET", "/provider");
    if (r.status !== 200 || !r.json?.all) throw new Error("failed to list opencode providers");
    const oc = r.json.all.find((p) => p.id === "opencode");
    modelCache = oc ? Object.keys(oc.models || {}) : [];
  }
  if (!modelCache.length) throw new Error("no opencode models found");
  return modelCache;
}

// ── translation: chat formats → opencode prompt ─────────────────────
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c.type === "text") return c.text ?? "";
        if (c.type === "tool_result")
          return typeof c.content === "string"
            ? c.content
            : Array.isArray(c.content)
              ? c.content.map((x) => x.text || "").join("\n")
              : "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function messagesToPrompt(messages) {
  let system = "";
  const turns = [];
  for (const m of messages || []) {
    if (m.role === "system") system += (system ? "\n\n" : "") + extractText(m.content);
    else turns.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${extractText(m.content)}`);
  }
  const lastUserText = [...turns].reverse().find((t) => t.startsWith("User:"))?.slice(6) ?? "";
  return { system, transcript: turns.join("\n\n"), lastUserText };
}

function anthropicToPrompt(body) {
  const system = typeof body.system === "string" ? body.system : extractText(body.system);
  const { transcript, lastUserText } = messagesToPrompt(body.messages);
  return { system, transcript, lastUserText };
}

// ── sessions ────────────────────────────────────────────────────────
const sessions = new Map(); // key -> { sessionID, modelId, turns, chain }
function sessionEntry(key) {
  if (!sessions.has(key)) sessions.set(key, { sessionID: null, modelId: null, turns: 0, chain: Promise.resolve() });
  return sessions.get(key);
}

function upstreamError(r) {
  const msg =
    r.json?.data?.message ||
    r.json?.error?.message ||
    r.json?.message ||
    `opencode server returned ${r.status}`;
  const err = new Error(msg);
  err.status = r.status === 429 ? 429 : r.status === 400 ? 400 : r.status === 401 ? 401 : 502;
  return err;
}

// Model reference differs between API generations:
// v2 `{ providerID, id }` (set on the session), v1 `{ modelID, providerID }` (per message).
const modelRef = (modelId) =>
  apiVersion === "v2"
    ? { providerID: "opencode", id: modelId }
    : { modelID: modelId, providerID: "opencode" };

async function createSession(modelId) {
  if (apiVersion === "v2") {
    const r = await ocReq("POST", "/api/session", { model: modelRef(modelId) });
    if (r.status !== 200 || !r.json?.data?.id) throw upstreamError(r);
    return r.json.data.id;
  }
  const r = await ocReq("POST", "/session", {});
  if (r.status !== 200 || !r.json?.id) throw upstreamError(r);
  return r.json.id;
}

async function switchSessionModel(sessionID, modelId) {
  if (apiVersion !== "v2") return; // v1 takes the model on every message
  const r = await ocReq("POST", `/api/session/${sessionID}/model`, { model: modelRef(modelId) });
  if (r.status !== 200 && r.status !== 204) throw upstreamError(r);
}

function deleteSession(sessionID) {
  const path = apiVersion === "v2" ? `/api/session/${sessionID}` : `/session/${sessionID}`;
  ocReq("DELETE", path).catch(() => {});
}

// One synchronous-looking turn on the v2 API: admit the prompt, wait for the
// agent loop to go idle, then read the newest assistant message back.
async function runTurn(sessionID, { system, modelId, text }) {
  if (apiVersion === "v2") {
    // v2 prompts have no `system` field — fold it into the prompt text
    const t = system ? `${system}\n\n${text}` : text;
    const p = await ocReq("POST", `/api/session/${sessionID}/prompt`, { text: t });
    if (p.status !== 200) throw upstreamError(p);
    const w = await ocReq("POST", `/api/experimental/session/${sessionID}/wait`);
    if (w.status !== 204 && w.status !== 200) throw upstreamError(w);
    const r = await ocReq("GET", `/api/session/${sessionID}/message?order=desc&limit=5`);
    const messages = r.status === 200 && Array.isArray(r.json?.data) ? r.json.data : null;
    if (!messages) throw upstreamError(r);
    const idle = messages.find((m) => m.type === "idle");
    if (idle?.outcome === "failed") {
      const err = new Error(idle.error?.message || "opencode agent run failed");
      err.status = idle.error?.status === 429 ? 429 : 502;
      throw err;
    }
    const assistant = messages.find((m) => m.type === "assistant");
    if (!assistant) throw new Error("empty response from opencode");
    return extractMessageV2(assistant);
  }
  // v1: a single synchronous message call
  const r = await ocReq("POST", `/session/${sessionID}/message`, {
    ...(system ? { system } : {}),
    model: modelRef(modelId),
    parts: [{ type: "text", text }],
  });
  if (r.status !== 200) throw upstreamError(r);
  return extractMessageV1(r.json);
}

async function ask({ key, system, modelId, transcript, lastUserText }) {
  if (!key) {
    // stateless: fresh session, replay the whole transcript for context
    const sessionID = await createSession(modelId);
    try {
      return await runTurn(sessionID, { system, modelId, text: transcript || lastUserText });
    } finally {
      deleteSession(sessionID);
    }
  }
  // stateful: pin one opencode session per key; first turn replays the
  // transcript, later turns send only the newest user message
  const entry = sessionEntry(key);
  const run = entry.chain.then(async () => {
    if (!entry.sessionID) {
      entry.sessionID = await createSession(modelId);
      entry.modelId = modelId;
      entry.turns = 0;
    } else if (entry.modelId !== modelId) {
      await switchSessionModel(entry.sessionID, modelId);
      entry.modelId = modelId;
    }
    const text = entry.turns === 0 ? (transcript || lastUserText) : lastUserText;
    entry.turns++;
    return runTurn(entry.sessionID, { system, modelId, text });
  });
  entry.chain = run.catch(() => {});
  return run;
}

// ── translation: opencode message → chat formats ────────────────────
function extractMessageV2(message) {
  let text = "";
  let reasoning = "";
  for (const p of message?.content || []) {
    if (p.type === "text") text += p.text ?? "";
    else if (p.type === "reasoning") reasoning += p.text ?? "";
  }
  const tokens = message?.tokens || {};
  return {
    text,
    reasoning,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    finish: message?.finish,
  };
}

function extractMessageV1(message) {
  let text = "";
  let reasoning = "";
  for (const p of message?.parts || []) {
    if (p.type === "text") text += p.text ?? "";
    else if (p.type === "reasoning") reasoning += p.text ?? "";
  }
  const tokens = message?.info?.tokens || {};
  return {
    text,
    reasoning,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    finish: message?.info?.finish,
  };
}

function mapFinish(finish) {
  return finish === "length" ? "length" : "stop";
}

const rid = (prefix) => prefix + crypto.randomBytes(12).toString("hex");

function openaiResponse(modelId, r) {
  return {
    id: rid("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: r.text,
          ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
        },
        finish_reason: mapFinish(r.finish),
      },
    ],
    usage: {
      prompt_tokens: r.inputTokens,
      completion_tokens: r.outputTokens,
      total_tokens: r.inputTokens + r.outputTokens,
    },
  };
}

function openaiStream(res, modelId, r) {
  const id = rid("chatcmpl-");
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })}\n\n`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(chunk({ role: "assistant" }));
  if (r.reasoning) res.write(chunk({ reasoning_content: r.reasoning }));
  if (r.text) res.write(chunk({ content: r.text }));
  res.write(chunk({}, mapFinish(r.finish)));
  res.write("data: [DONE]\n\n");
  res.end();
}

function anthropicResponse(modelId, r) {
  return {
    id: rid("msg_"),
    type: "message",
    role: "assistant",
    model: modelId,
    content: [{ type: "text", text: r.text }],
    stop_reason: r.finish === "length" ? "max_tokens" : "end_turn",
    usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
  };
}

function anthropicStream(res, modelId, r) {
  const id = rid("msg_");
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  send("message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", content: [], model: modelId,
      stop_reason: null, usage: { input_tokens: r.inputTokens, output_tokens: 0 },
    },
  });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  if (r.text) send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: r.text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: r.finish === "length" ? "max_tokens" : "end_turn" },
    usage: { output_tokens: r.outputTokens },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

// ── HTTP API ────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/v1/models", async (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: { message: "Invalid API key" } });
  try {
    const models = await getModels();
    res.json({
      object: "list",
      data: models.map((id) => ({ id, object: "model", created: 1779000000, owned_by: "opencode" })),
    });
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: "upstream_error" } });
  }
});

app.post("/v1/chat/completions", async (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: { message: "Invalid API key" } });
  try {
    const { model, messages, stream, user: userId } = req.body || {};
    const modelId = String(model || "").replace(/^opencode\//, "");
    const models = await getModels();
    if (!models.includes(modelId)) {
      return res.status(400).json({
        error: { message: `Unknown model: ${modelId}. Available: ${models.join(", ")}` },
      });
    }
    const { system, transcript, lastUserText } = messagesToPrompt(messages);
    if (!lastUserText) return res.status(400).json({ error: { message: "No user message in request" } });
    const key = req.headers["x-oc-session"] || userId || null;
    const extracted = await ask({ key, system, modelId, transcript, lastUserText });
    if (!extracted.text && !extracted.reasoning) throw new Error("empty response from opencode");
    if (stream) return openaiStream(res, modelId, extracted);
    return res.json(openaiResponse(modelId, extracted));
  } catch (e) {
    return res.status(e.status || 502).json({ error: { message: e.message, type: "upstream_error" } });
  }
});

app.post("/v1/messages", async (req, res) => {
  if (!auth(req)) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  try {
    const { model, stream, metadata } = req.body || {};
    const modelId = String(model || "").replace(/^opencode\//, "");
    const models = await getModels();
    if (!models.includes(modelId)) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: `Unknown model: ${modelId}. Available: ${models.join(", ")}` },
      });
    }
    const { system, transcript, lastUserText } = anthropicToPrompt(req.body);
    if (!lastUserText) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "No user message in request" },
      });
    }
    const key = req.headers["x-oc-session"] || metadata?.user_id || null;
    const extracted = await ask({ key, system, modelId, transcript, lastUserText });
    if (!extracted.text && !extracted.reasoning) throw new Error("empty response from opencode");
    if (stream) return anthropicStream(res, modelId, extracted);
    return res.json(anthropicResponse(modelId, extracted));
  } catch (e) {
    return res.status(e.status || 502).json({
      type: "error",
      error: { type: e.status === 429 ? "rate_limit_error" : "upstream_error", message: e.message },
    });
  }
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", opencode: ocBase, api: apiVersion, models: modelCache ? modelCache.length : 0 })
);

// ── start ───────────────────────────────────────────────────────────
app.listen(PROXY_PORT, "0.0.0.0", async () => {
  console.log(`oc-api-proxy on http://0.0.0.0:${PROXY_PORT}`);
  console.log("  OpenAI:    POST /v1/chat/completions");
  console.log("  Anthropic: POST /v1/messages");
  console.log("  Models:    GET  /v1/models");
  try {
    await startBackend();
    const models = await getModels();
    console.log("  Models:", models.join(", "));
  } catch (e) {
    console.error("  Failed to start opencode backend:", e.message);
    process.exit(1);
  }
  for (const [name, key] of Object.entries(apiKeys)) console.log(`  ${name.padEnd(15)} ${key}`);
});
