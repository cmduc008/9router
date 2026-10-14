import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn().mockResolvedValue(undefined),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
  saveUsage: vi.fn().mockResolvedValue(undefined),
}));

import { pipeWithDisconnect, createStreamController } from "../../open-sse/utils/streamHandler.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { buildStreamErrorBytes } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PING = 'event: ping\ndata: {"type":"ping"}\n\n';
const heartbeat = { intervalMs: 20, bytes: encoder.encode(PING) };
const terminal = (message) => buildStreamErrorBytes(504, message, FORMATS.CLAUDE);

function fixture() {
  let upstream;
  const cancel = vi.fn();
  const onError = vi.fn();
  const ctrl = createStreamController({ provider: "synthetic", model: "fixture", onError, log: { errorLine: vi.fn() } });
  const body = new ReadableStream({ start(c) { upstream = c; }, cancel });
  return { body, upstream, cancel, ctrl, onError };
}

// Observe settled reads without hanging when the regression leaves reader.read pending.
async function observe(read) {
  let result;
  let error;
  read.then(value => { result = value; }, value => { error = value; });
  await vi.advanceTimersByTimeAsync(0);
  return { result, error };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function handler(f, overrides = {}) {
  return handleStreamingResponse({
    providerResponse: new Response(f.body, { headers: { "content-type": "text/event-stream" } }),
    provider: "synthetic", model: "fixture", sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.CLAUDE,
    body: { messages: [] }, stream: true, requestStartTime: Date.now(), streamController: f.ctrl,
    ...overrides,
  });
}

describe("Claude streaming handler integration", () => {
  it("starts downstream pings only after receiving a validated upstream response", async () => {
    const f = fixture();
    const result = await handler(f);
    expect(result.success).toBe(true);
    const reader = result.response.body.getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(15000);
    const { result: chunk } = await observe(pending);
    await reader.cancel();
    expect(decoder.decode(chunk?.value)).toBe(PING);
  });

  it("rejects an HTTP 200 HTML upstream as 502 without starting pings or success callbacks", async () => {
    const f = fixture();
    const onRequestSuccess = vi.fn();
    const result = await handler(f, {
      providerResponse: new Response("<html><title>Synthetic upstream unavailable</title></html>", {
        status: 200, headers: { "content-type": "text/html" },
      }),
      onRequestSuccess, log: { errorLine: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a rejected upstream HTTP status instead of constructing a pinging 200", async () => {
    const f = fixture();
    const onRequestSuccess = vi.fn();
    const result = await handler(f, {
      providerResponse: new Response('{"type":"error","error":{"type":"authentication_error","message":"synthetic auth rejected"}}', {
        status: 401, headers: { "content-type": "application/json" },
      }),
      onRequestSuccess,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(401);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Claude production stream lifecycle", () => {
  it("delivers a valid ping during a pending transformed read without upstream bytes", async () => {
    const f = fixture();
    const out = pipeWithDisconnect({ body: f.body }, new TransformStream(), f.ctrl, terminal, 100, heartbeat);
    const reader = out.getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(20);
    const { result } = await observe(pending);
    await reader.cancel();
    expect(result?.done).toBe(false);
    expect(decoder.decode(result?.value)).toBe(PING);
  });

  it("keeps pings independent of the raw upstream stall deadline and emits an error", async () => {
    const f = fixture();
    const out = pipeWithDisconnect({ body: f.body }, new TransformStream(), f.ctrl, terminal, 100, heartbeat);
    const text = [];
    const consume = (async () => {
      for await (const chunk of out) text.push(decoder.decode(chunk));
    })();
    await vi.advanceTimersByTimeAsync(100);
    const { result } = await observe(consume.then(() => "closed"));
    expect(result).toBe("closed");
    expect(text.join("")).toContain(PING);
    expect(text.join("")).toContain('event: error\n');
    expect(text.join("")).toContain('"message":"stream stall timeout"');
    expect(text.join("")).not.toContain("message_stop");
    expect(f.onError).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not insert a ping into a partially emitted SSE frame", async () => {
    const f = fixture();
    const out = pipeWithDisconnect({ body: f.body }, new TransformStream(), f.ctrl, terminal, 100, heartbeat);
    const reader = out.getReader();
    f.upstream.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":'));
    expect(decoder.decode((await reader.read()).value)).toContain('data: {"type":');
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(40);
    expect((await observe(pending)).result).toBeUndefined();
    f.upstream.enqueue(encoder.encode('"content_block_delta"}\n\n'));
    expect(decoder.decode((await pending).value)).toBe('"content_block_delta"}\n\n');
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(20);
    expect(decoder.decode((await next).value)).toBe(PING);
    await reader.cancel();
  });

  it("does not queue repeated pings behind a slow client", async () => {
    const f = fixture();
    const out = pipeWithDisconnect({ body: f.body }, new TransformStream(), f.ctrl, terminal, 1000, heartbeat);
    await vi.advanceTimersByTimeAsync(200);
    const reader = out.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(PING);
    const pending = reader.read();
    expect((await observe(pending)).result).toBeUndefined();
    await reader.cancel();
  });

  it("resets the watchdog for raw bytes even when the transform emits nothing", async () => {
    const f = fixture();
    const out = pipeWithDisconnect({ body: f.body }, new TransformStream({ transform() {} }), f.ctrl, terminal, 100, heartbeat);
    const consume = (async () => { for await (const _ of out) { /* drain pings */ } })();
    await vi.advanceTimersByTimeAsync(80);
    f.upstream.enqueue(encoder.encode("synthetic buffered upstream bytes"));
    await vi.advanceTimersByTimeAsync(80);
    expect(f.onError).not.toHaveBeenCalled();
    f.upstream.close();
    await consume;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up after EOF without emitting an extra ping or error", async () => {
    const f = fixture();
    const out = pipeWithDisconnect({ body: f.body }, new TransformStream(), f.ctrl, terminal, 100, heartbeat);
    const content = encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    f.upstream.enqueue(content);
    f.upstream.close();
    const chunks = [];
    for await (const chunk of out) chunks.push(decoder.decode(chunk));
    await vi.advanceTimersByTimeAsync(200);
    expect(chunks.join("")).toBe(decoder.decode(content));
    expect(f.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the upstream and clears timers while a read is pending", async () => {
    const f = fixture();
    const out = pipeWithDisconnect({ body: f.body }, new TransformStream(), f.ctrl, terminal, 100, heartbeat);
    const reader = out.getReader();
    const pending = reader.read();
    await reader.cancel("synthetic client cancelled");
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits one Claude error for upstream failure and never emits a success terminal", async () => {
    const f = fixture();
    const out = pipeWithDisconnect({ body: f.body }, new TransformStream(), f.ctrl, terminal, 100, heartbeat);
    f.upstream.error(new Error("synthetic read failure"));
    const chunks = [];
    for await (const chunk of out) chunks.push(decoder.decode(chunk));
    const text = chunks.join("");
    expect(text.match(/event: error/g)).toHaveLength(1);
    expect(text).not.toContain("message_stop");
    expect(f.onError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
