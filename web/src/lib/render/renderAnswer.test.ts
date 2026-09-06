import { beforeEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { stream: streamMock },
  })),
}));

const { streamAnswer } = await import("./renderAnswer");

/** Wraps a list of raw Anthropic stream events as the async-iterable shape
 * `client.messages.stream()` returns (`MessageStream` implements
 * `AsyncIterable<MessageStreamEvent>`) -- matches what `renderAnswer.ts`'s
 * `for await (const event of stream)` actually consumes. */
function fakeStream(events: Array<Record<string, unknown>>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function textDeltaEvent(text: string) {
  return { type: "content_block_delta", delta: { type: "text_delta", text } };
}

async function drain(generator: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of generator) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("streamAnswer", () => {
  beforeEach(() => {
    streamMock.mockReset();
  });

  it("yields text chunks from content_block_delta/text_delta events, in order", async () => {
    streamMock.mockReturnValue(
      fakeStream([textDeltaEvent("There "), textDeltaEvent("were 70 reports.")]),
    );

    const chunks = await drain(
      streamAnswer(
        "How many reports for dupilumab?",
        "tier3",
        "SELECT count(*) FROM sem.faers_case_summary",
        [{ count: 70 }],
      ),
    );

    expect(chunks.join("")).toBe("There were 70 reports.");
  });

  it("ignores non-text-delta stream events (message_start, input_json_delta, ...)", async () => {
    streamMock.mockReturnValue(
      fakeStream([
        { type: "message_start" },
        textDeltaEvent("Answer."),
        { type: "content_block_delta", delta: { type: "input_json_delta" } },
        { type: "message_stop" },
      ]),
    );

    const chunks = await drain(streamAnswer("Q", "tier3", "SELECT 1", []));
    expect(chunks.join("")).toBe("Answer.");
  });

  it("caps the rows embedded in the prompt and notes the true row count when truncating", async () => {
    streamMock.mockReturnValue(fakeStream([]));
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }));

    await drain(streamAnswer("Q", "tier3", "SELECT * FROM x", rows));

    expect(streamMock).toHaveBeenCalledTimes(1);
    const call = streamMock.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain("first 20 of 50 total rows");
    // Only the first 20 rows (index 0-19) should be embedded verbatim.
    expect(userContent).not.toContain('"id": 20');
  });

  it("does not truncate or add a truncation note for a small result set", async () => {
    streamMock.mockReturnValue(fakeStream([]));
    const rows = [{ id: 1 }, { id: 2 }];

    await drain(streamAnswer("Q", "tier3", "SELECT * FROM x", rows));

    const call = streamMock.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain("All 2 row(s)");
    expect(userContent).not.toContain("total rows");
  });

  it("includes the FAERS seriousness-is-a-proxy caveat when rows carry seriousness columns", async () => {
    streamMock.mockReturnValue(fakeStream([]));

    await drain(
      streamAnswer("Q", "tier3", "SELECT * FROM sem.faers_case_summary", [
        { safetyreportid: "1", serious: true, seriousnessdeath: false },
      ]),
    );

    const call = streamMock.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    // The caveat necessarily mentions "Grade" itself (to instruct the model
    // never to use it) -- what matters is that it frames these columns as
    // "FDA seriousness criteria" and explicitly forbids the "Grade" framing,
    // not that the word "Grade" is absent from the prompt entirely.
    expect(userContent).toContain("FDA seriousness criteria");
    expect(userContent).toContain('NEVER as an AE "Grade"');
  });

  it("omits the seriousness caveat when rows carry no seriousness columns", async () => {
    streamMock.mockReturnValue(fakeStream([]));

    await drain(streamAnswer("Q", "tier3", "SELECT drug FROM x", [{ drug: "aspirin" }]));

    const call = streamMock.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).not.toContain("FDA seriousness criteria");
  });

  it("calls messages.stream with the configured model and the question/sql in the prompt", async () => {
    streamMock.mockReturnValue(fakeStream([]));

    await drain(
      streamAnswer("How many reports for dupilumab?", "tier4", "SELECT 1 FROM faers.report", []),
    );

    const call = streamMock.mock.calls[0][0];
    expect(call.model).toBeTruthy();
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain("How many reports for dupilumab?");
    expect(userContent).toContain("SELECT 1 FROM faers.report");
    expect(userContent).toContain("tier4");
  });
});
