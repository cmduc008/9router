import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn().mockResolvedValue(),
  saveRequestDetail: vi.fn().mockResolvedValue(),
  saveRequestUsage: vi.fn().mockResolvedValue(),
}));

import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const frame = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello Claude" }] };

async function run(events) {
  const raw = events.map(frame).join("");
  return handleForcedSSEToJson({
    providerResponse: new Response(raw, { headers: { "content-type": "text/event-stream" } }),
    sourceFormat: FORMATS.CLAUDE,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    provider: "codex",
    model: "test-model",
    body: { messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    onRequestSuccess: vi.fn(),
    clientRawRequest: { endpoint: "/v1/messages" },
  });
}

const done = (output = []) => ({
  type: "response.completed",
  response: { id: "resp_test", status: "completed", output, usage: { input_tokens: 10, output_tokens: 3 } },
});

describe("Codex forced streaming to Claude JSON retry", () => {
  it("returns an Anthropic Message, not an OpenAI chat.completion", async () => {
    const result = await run([{ type: "response.output_item.done", output_index: 0, item: message }, done([message])]);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toEqual([{ type: "text", text: "Hello Claude" }]);
    expect(json.stop_reason).toBe("end_turn");
    expect(json.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
    expect(json).not.toHaveProperty("choices");
  });

  it("retains completed-only output", async () => {
    const result = await run([done([message])]);
    expect((await result.response.json()).content).toEqual([{ type: "text", text: "Hello Claude" }]);
  });

  it("does not mark a failed stream successful when completion follows it", async () => {
    const result = await run([{ type: "response.failed", response: { status: "failed" } }, done([message])]);
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("returns Claude tool_use input and stop_reason", async () => {
    const tool = { type: "function_call", id: "fc_test", call_id: "call_test", name: "Read", arguments: '{"file_path":"/tmp/example"}' };
    const result = await run([{ type: "response.output_item.done", output_index: 0, item: tool }, done([tool])]);
    const json = await result.response.json();
    expect(json.content).toEqual([{ type: "tool_use", id: "call_test", name: "Read", input: { file_path: "/tmp/example" } }]);
    expect(json.stop_reason).toBe("tool_use");
  });

  it.each(["response.failed", "response.incomplete", "error"])("returns HTTP 502 for %s", async (type) => {
    const result = await run([{ type, response: { status: "failed", error: { message: "synthetic error" } } }]);
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("rejects empty or unterminated streams", async () => {
    for (const events of [[], [{ type: "response.output_item.done", output_index: 0, item: message }]]) {
      const result = await run(events);
      expect(result.success).toBe(false);
      expect(result.response.status).toBe(502);
    }
  });
});
