import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn().mockResolvedValue(),
  saveRequestUsage: vi.fn().mockResolvedValue(),
}));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";

const frame = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const completed = { type: "response.completed", response: { status: "completed" } };

async function runStream(input, split = false) {
  const onStreamComplete = vi.fn();
  const bytes = new TextEncoder().encode(input);
  const upstream = new ReadableStream({
    start(controller) {
      if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      else if (bytes.length) controller.enqueue(bytes);
      controller.close();
    },
  });
  const output = upstream.pipeThrough(createSSEStream({
    targetFormat: FORMATS.OPENAI_RESPONSES,
    sourceFormat: FORMATS.CLAUDE,
    provider: "codex",
    model: "test-model",
    onStreamComplete,
  }));
  const text = await new Response(output).text();
  const events = text.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  return { text, events, onStreamComplete };
}

function expectFailure(result) {
  expect(result.events.filter((event) => event.type === "error")).toHaveLength(1);
  expect(result.events.some((event) => event.type === "message_stop")).toBe(false);
  expect(result.events.some((event) => event.delta?.stop_reason)).toBe(false);
  expect(result.onStreamComplete).not.toHaveBeenCalled();
}

describe("Codex Responses to Claude stream failure semantics", () => {
  it("rejects an empty upstream HTTP 200 body", async () => {
    expectFailure(await runStream(""));
  });

  it("rejects malformed upstream payload rather than completing empty", async () => {
    expectFailure(await runStream("data: not-json\n\n"));
  });

  it("does not turn partial output followed by EOF into successful completion", async () => {
    const result = await runStream(frame({ type: "response.output_text.delta", delta: "partial" }));
    expect(result.text).toContain("partial");
    expectFailure(result);
  });

  it.each(["response.failed", "response.incomplete", "error"])("surfaces %s as a protocol error, not assistant text", async (type) => {
    const result = await runStream(frame({
      type,
      error: { message: "Synthetic upstream failure" },
      response: { status: type === "response.incomplete" ? "incomplete" : "failed" },
    }));
    expectFailure(result);
    expect(result.text).not.toContain("[Error]");
  });

  it("never reports success when a failure is followed by completion or duplicate failure", async () => {
    expectFailure(await runStream(frame({ type: "response.failed", response: { error: { message: "failure" } } }) + frame(completed)));
  });

  it("preserves successful fragmented UTF-8 streams", async () => {
    const result = await runStream(frame({ type: "response.output_text.delta", delta: "Xin chào 👋" }) + frame(completed), true);
    expect(result.events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(result.events.filter((event) => event.type === "message_stop")).toHaveLength(1);
    expect(result.events.filter((event) => event.delta?.text).map((event) => event.delta.text).join("")).toBe("Xin chào 👋");
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("processes a successful terminal event without a final newline", async () => {
    const input = frame({ type: "response.output_text.delta", delta: "hello" }) + `data: ${JSON.stringify(completed)}`;
    const result = await runStream(input);
    expect(result.events.some((event) => event.type === "error")).toBe(false);
    expect(result.events.filter((event) => event.type === "message_stop")).toHaveLength(1);
  });

  it("rejects a failed terminal event without a final newline", async () => {
    expectFailure(await runStream(`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "failure" } } })}`));
  });

  it("delivers completed-only snapshots through the real SSE pipeline", async () => {
    const result = await runStream(frame({
      type: "response.completed",
      response: {
        status: "completed",
        output: [{ id: "msg_test", type: "message", content: [{ type: "output_text", text: "Snapshot answer" }] }],
      },
    }));
    expect(result.events.filter((event) => event.delta?.text).map((event) => event.delta.text).join("")).toBe("Snapshot answer");
    expect(result.events.filter((event) => event.type === "message_stop")).toHaveLength(1);
  });
});
