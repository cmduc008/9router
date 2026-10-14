import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { initState, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function translate(events, sourceFormat = FORMATS.OPENAI) {
  const state = initState(sourceFormat);
  return events.flatMap((event) => translateResponse(FORMATS.OPENAI_RESPONSES, sourceFormat, event, state));
}

function text(chunks) {
  return chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join("");
}

function message(id, value) {
  return { id, type: "message", role: "assistant", content: [{ type: "output_text", text: value }] };
}

function tools(chunks) {
  const calls = new Map();
  for (const chunk of chunks) {
    for (const delta of chunk.choices?.[0]?.delta?.tool_calls || []) {
      const call = calls.get(delta.index) || { index: delta.index, arguments: "" };
      if (delta.id) call.id = delta.id;
      if (delta.function?.name) call.name = delta.function.name;
      call.arguments += delta.function?.arguments || "";
      calls.set(delta.index, call);
    }
  }
  return [...calls.values()];
}

function tool(id, callId, name, args) {
  return { id, call_id: callId, type: "function_call", name, arguments: args };
}

function completed(output, type = "response.completed") {
  return { type, response: { output, usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } } } };
}

describe("Codex terminal snapshots through the real response translator", () => {
  it("emits completed-only text before exactly one finish chunk with usage", () => {
    const chunks = translate([completed([message("msg_answer", "Terminal answer")]), null]);
    expect(text(chunks)).toBe("Terminal answer");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(chunks.filter((chunk) => chunk.choices[0].finish_reason)).toHaveLength(1);
    expect(chunks.at(-1).usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } });
  });

  it("emits output_text.done-only text without requiring completed output", () => {
    const chunks = translate([
      { type: "response.output_text.done", item_id: "msg_answer", output_index: 0, content_index: 0, text: "Done answer" },
      completed([]),
    ]);
    expect(text(chunks)).toBe("Done answer");
  });

  it("emits output_text.done-only text without repeating it in completed", () => {
    const chunks = translate([
      { type: "response.output_text.done", item_id: "msg_answer", output_index: 0, content_index: 0, text: "Done answer" },
      completed([message("msg_answer", "Done answer")]),
    ]);
    expect(text(chunks)).toBe("Done answer");
  });

  it("appends only missing text suffixes and keeps separate message parts", () => {
    const chunks = translate([
      { type: "response.output_text.delta", item_id: "msg_answer", output_index: 0, content_index: 0, delta: "Hello" },
      { type: "response.output_text.done", item_id: "msg_answer", output_index: 0, content_index: 0, text: "Hello world" },
      { type: "response.output_text.done", item_id: "msg_answer", output_index: 0, content_index: 1, text: "!" },
      completed([
        { ...message("msg_answer", "Hello world"), content: [{ type: "output_text", text: "Hello world" }, { type: "output_text", text: "!" }] },
        message("msg_second", " Next"),
      ]),
    ]);
    expect(text(chunks)).toBe("Hello world! Next");
  });

  it("does not replay streamed text from done or completed snapshots", () => {
    const chunks = translate([
      { type: "response.output_text.delta", item_id: "msg_answer", output_index: 0, content_index: 0, delta: "Streamed" },
      { type: "response.output_text.done", item_id: "msg_answer", output_index: 0, content_index: 0, text: "Streamed" },
      completed([message("msg_answer", "Streamed")]),
      completed([message("msg_answer", "Streamed")]),
    ]);
    expect(text(chunks)).toBe("Streamed");
    expect(chunks.filter((chunk) => chunk.choices[0].finish_reason)).toHaveLength(1);
  });

  it("preserves completed-only parallel tool ids, names and arguments", () => {
    const chunks = translate([completed([
      tool("fc_weather", "call_weather", "weather", '{"city":"Paris"}'),
      tool("fc_search", "call_search", "search", '{"q":"map"}'),
    ])]);
    expect(tools(chunks)).toEqual([
      { index: 0, id: "call_weather", name: "weather", arguments: '{"city":"Paris"}' },
      { index: 1, id: "call_search", name: "search", arguments: '{"q":"map"}' },
    ]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("does not duplicate interleaved streamed tool arguments in terminal snapshots", () => {
    const weather = tool("fc_weather", "call_weather", "weather", '{"city":"Paris"}');
    const search = tool("fc_search", "call_search", "search", '{"q":"map"}');
    const chunks = translate([
      { type: "response.output_item.added", output_index: 0, item: { ...weather, arguments: "" } },
      { type: "response.output_item.added", output_index: 1, item: { ...search, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: weather.id, delta: '{"city":' },
      { type: "response.function_call_arguments.delta", item_id: search.id, delta: search.arguments },
      { type: "response.function_call_arguments.delta", item_id: weather.id, delta: '"Paris"}' },
      { type: "response.output_item.done", output_index: 1, item: search },
      { type: "response.output_item.done", output_index: 0, item: weather },
      completed([weather, search]),
    ]);
    expect(tools(chunks)).toEqual([
      { index: 0, id: weather.call_id, name: weather.name, arguments: weather.arguments },
      { index: 1, id: search.call_id, name: search.name, arguments: search.arguments },
    ]);
  });

  it("allocates distinct done-only calls and does not replay their completed snapshots", () => {
    const weather = tool("fc_weather", "call_weather", "weather", '{"city":"Paris"}');
    const search = tool("fc_search", "call_search", "search", '{"q":"map"}');
    const chunks = translate([
      { type: "response.output_item.done", output_index: 0, item: weather },
      { type: "response.output_item.done", output_index: 1, item: search },
      completed([weather, search]),
    ]);
    expect(tools(chunks)).toEqual([
      { index: 0, id: weather.call_id, name: weather.name, arguments: weather.arguments },
      { index: 1, id: search.call_id, name: search.name, arguments: search.arguments },
    ]);
  });

  it("appends missing tool argument suffixes instead of replaying a full snapshot", () => {
    const call = tool("fc_search", "call_search", "search", '{"q":"map"}');
    const chunks = translate([
      { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: call.id, delta: '{"q":' },
      { type: "response.output_item.done", output_index: 0, item: call },
      completed([call]),
    ]);
    expect(tools(chunks)).toEqual([{ index: 0, id: call.call_id, name: call.name, arguments: call.arguments }]);
  });

  it("preserves custom tool terminal input without repeating streamed fragments", () => {
    const call = { id: "ctc_exec", call_id: "call_exec", type: "custom_tool_call", name: "exec", input: "print(1)" };
    const chunks = translate([
      { type: "response.output_item.added", output_index: 0, item: { ...call, input: "" } },
      { type: "response.custom_tool_call_input.delta", item_id: call.id, delta: "print(" },
      { type: "response.output_item.done", output_index: 0, item: call },
      completed([call]),
    ]);
    expect(tools(chunks)).toEqual([{ index: 0, id: call.call_id, name: "exec", arguments: "print(1)" }]);
  });

  it("handles wrapped response.done snapshots with text and custom tools", () => {
    const chunks = translate([{ event: "response.done", data: completed([
      message("msg_answer", "Run this"),
      { id: "ctc_exec", call_id: "call_exec", type: "custom_tool_call", name: "exec", input: "print(1)" },
    ], "response.done") }]);
    expect(text(chunks)).toBe("Run this");
    expect(tools(chunks)).toEqual([{ index: 0, id: "call_exec", name: "exec", arguments: "print(1)" }]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("uses output indices when argument deltas omit item ids", () => {
    const weather = tool("fc_weather", "call_weather", "weather", '{"city":"Paris"}');
    const search = tool("fc_search", "call_search", "search", '{"q":"map"}');
    const chunks = translate([
      { type: "response.output_item.added", output_index: 1, item: { ...weather, arguments: "" } },
      { type: "response.output_item.added", output_index: 2, item: { ...search, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: weather.arguments },
      { type: "response.function_call_arguments.delta", output_index: 2, delta: search.arguments },
      completed([message("msg_answer", "Checking"), weather, search]),
    ]);
    expect(tools(chunks)).toEqual([
      { index: 0, id: weather.call_id, name: weather.name, arguments: weather.arguments },
      { index: 1, id: search.call_id, name: search.name, arguments: search.arguments },
    ]);
  });

  it("keeps legacy identifier-less tool done arguments on the most recent call", () => {
    const call = tool("fc_search", "call_search", "search", '{"q":"map"}');
    const chunks = translate([
      { type: "response.output_item.added", item: { ...call, arguments: "" } },
      { type: "response.output_item.done", item: { type: "function_call", arguments: call.arguments } },
      completed([call]),
    ]);
    expect(tools(chunks)).toEqual([{ index: 0, id: call.call_id, name: call.name, arguments: call.arguments }]);
  });

  it("ignores malformed terminal output entries instead of throwing", () => {
    const chunks = translate([completed([
      null,
      { type: "message", content: {} },
      { type: "message", content: [null] },
      message("msg_answer", "Valid"),
    ])]);
    expect(text(chunks)).toBe("Valid");
  });

  it("deduplicates legacy text deltas without item ids against terminal output", () => {
    const chunks = translate([
      { type: "response.output_text.delta", delta: "Legacy answer" },
      completed([message("msg_answer", "Legacy answer")]),
    ]);
    expect(text(chunks)).toBe("Legacy answer");
  });

  it("does not replay item-id-only text when done only has an output index", () => {
    const chunks = translate([
      { type: "response.output_text.delta", item_id: "msg_answer", delta: "Hello" },
      { type: "response.output_text.done", output_index: 0, text: "Hello" },
      completed([]),
    ]);
    expect(text(chunks)).toBe("Hello");
  });

  it("does not invent a phantom tool from output-index-only done after an id-only start", () => {
    const call = tool("fc_search", "call_search", "search", '{"q":"map"}');
    const chunks = translate([
      { type: "response.output_item.added", item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", arguments: call.arguments } },
      completed([]),
    ]);
    expect(tools(chunks)).toEqual([{ index: 0, id: call.call_id, name: call.name, arguments: call.arguments }]);
  });

  it("does not guess which parallel text item an index-only snapshot belongs to", () => {
    const chunks = translate([
      { type: "response.output_text.delta", item_id: "msg_first", delta: "First" },
      { type: "response.output_text.delta", item_id: "msg_second", delta: "Second" },
      { type: "response.output_text.done", output_index: 0, text: "First extended" },
      { type: "response.output_text.done", output_index: 1, text: "Second extended" },
      completed([]),
    ]);
    expect(text(chunks)).toBe("FirstSecond");
  });

  it("does not append ambiguous uncorrelated done arguments to a parallel tool", () => {
    const first = tool("fc_first", "call_first", "first", '{"a":1}');
    const second = tool("fc_second", "call_second", "second", '{"b":2}');
    const chunks = translate([
      { type: "response.output_item.added", item: { ...first, arguments: "" } },
      { type: "response.output_item.added", item: { ...second, arguments: "" } },
      { type: "response.output_item.done", item: { type: "function_call", arguments: first.arguments } },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", arguments: first.arguments } },
      completed([first, second]),
    ]);
    expect(tools(chunks)).toEqual([
      { index: 0, id: first.call_id, name: first.name, arguments: first.arguments },
      { index: 1, id: second.call_id, name: second.name, arguments: second.arguments },
    ]);
  });

  it("does not concatenate conflicting text or argument snapshots to streamed output", () => {
    const call = tool("fc_search", "call_search", "search", '{"q":"different"}');
    const chunks = translate([
      { type: "response.output_text.delta", item_id: "msg_answer", output_index: 0, delta: "Streamed" },
      { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: call.id, delta: '{"q":"original"}' },
      completed([message("msg_answer", "Conflicting"), call]),
    ]);
    expect(text(chunks)).toBe("Streamed");
    expect(tools(chunks)).toEqual([{ index: 0, id: call.call_id, name: call.name, arguments: '{"q":"original"}' }]);
  });

  it("pivots completed-only text and parallel tools to Claude before message_stop", () => {
    const chunks = translate([completed([
      message("msg_answer", "Checking"),
      tool("fc_weather", "call_weather", "weather", '{"city":"Paris"}'),
      tool("fc_search", "call_search", "search", '{"q":"map"}'),
    ])], FORMATS.CLAUDE);
    expect(chunks.filter((chunk) => chunk.delta?.type === "text_delta").map((chunk) => chunk.delta.text).join("")).toBe("Checking");
    expect(chunks.filter((chunk) => chunk.content_block?.type === "tool_use").map((chunk) => chunk.content_block.id)).toEqual(["call_weather", "call_search"]);
    expect(chunks.filter((chunk) => chunk.delta?.type === "input_json_delta").map((chunk) => JSON.parse(chunk.delta.partial_json))).toEqual([{ city: "Paris" }, { q: "map" }]);
    expect(chunks.find((chunk) => chunk.type === "message_delta")).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 4 } });
    expect(chunks.at(-1).type).toBe("message_stop");
    expect(chunks.filter((chunk) => chunk.type === "message_stop")).toHaveLength(1);
  });
});
