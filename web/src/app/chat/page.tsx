"use client";

import { useId, useState, type FormEvent } from "react";
import {
  postChatStream,
  newSessionId,
  type ChatStreamMetadata,
} from "./apiClient";
import { ResultTable } from "./ResultTable";

// The assistant side of a message is built up progressively as
// `postChatStream` yields updates: it starts as `{ kind: "pending" }` (no
// metadata yet), becomes `ChatStreamMetadata & { text }` once the first
// update (the metadata line) arrives, with `text` growing on every
// subsequent chunk -- see apiClient.ts's STREAMING WIRE FORMAT comment.
type AssistantContent =
  | { kind: "error"; message: string }
  | { kind: "pending" }
  | (ChatStreamMetadata & { text: string });

type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: AssistantContent };

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(() => newSessionId());
  const inputId = useId();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = input.trim();
    if (!question || loading) {
      return;
    }

    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setInput("");
    setLoading(true);

    // Index of the assistant placeholder this request will progressively
    // update in place as streamed chunks arrive. `setMessages` functional
    // updaters run synchronously (in call order) even though the resulting
    // re-render may be batched, so capturing the index here is safe.
    let assistantIndex = -1;
    setMessages((prev) => {
      assistantIndex = prev.length;
      return [...prev, { role: "assistant", content: { kind: "pending" } }];
    });

    try {
      for await (const update of postChatStream(question, sessionId)) {
        setMessages((prev) => {
          const next = [...prev];
          next[assistantIndex] = {
            role: "assistant",
            content: { ...update.metadata, text: update.textSoFar },
          };
          return next;
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setMessages((prev) => {
        const next = [...prev];
        next[assistantIndex] = {
          role: "assistant",
          content: { kind: "error", message },
        };
        return next;
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="chat-page">
      <h2>Chat</h2>
      <p>
        Ask a question in plain English about FAERS adverse events or
        ClinicalTrials.gov trials. Every question passes through governance
        guardrails before any SQL runs.
      </p>

      <div className="chat-messages" role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 ? (
          <p className="chat-empty">No messages yet — ask a question below to get started.</p>
        ) : (
          messages.map((message, index) => <ChatMessageBubble key={index} message={message} />)
        )}
      </div>

      <form className="chat-form" onSubmit={handleSubmit}>
        <label htmlFor={inputId} className="chat-form-label">
          Your question
        </label>
        <div className="chat-form-row">
          <input
            id={inputId}
            className="chat-input"
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="e.g. How many serious cases were reported for metformin in 2023?"
            disabled={loading}
          />
          <button
            className="chat-send"
            type="submit"
            disabled={loading || input.trim().length === 0}
          >
            {loading ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ChatMessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="chat-bubble chat-bubble--user">
        <div className="chat-bubble-label">You</div>
        <div>{message.content}</div>
      </div>
    );
  }

  const content = message.content;

  if (content.kind === "error") {
    return (
      <div className="chat-bubble chat-bubble--assistant chat-bubble--error" role="alert">
        <div className="chat-bubble-label">Error</div>
        <div>{content.message}</div>
      </div>
    );
  }

  if (content.kind === "pending") {
    return (
      <div className="chat-bubble chat-bubble--assistant chat-bubble--loading">
        <div className="chat-bubble-label">Assistant</div>
        <div>Thinking…</div>
      </div>
    );
  }

  if (content.kind === "reject" || content.kind === "clarify") {
    return (
      <div
        className="chat-bubble chat-bubble--assistant chat-bubble--guardrail"
        data-kind={content.kind}
      >
        <div className="chat-bubble-label">
          {content.kind === "reject" ? "Request declined" : "Clarification needed"}
        </div>
        <div>{content.text || content.question}</div>
      </div>
    );
  }

  if (content.kind === "no_answer") {
    return (
      <div
        className="chat-bubble chat-bubble--assistant chat-bubble--guardrail"
        data-kind="no_answer"
      >
        <div className="chat-bubble-label">No answer available</div>
        <div>{content.text || "I couldn't find a way to answer that from the available data."}</div>
      </div>
    );
  }

  // "tier3" / "tier4" (or any future success kind carrying sql/rows). `text`
  // is the natural-language answer, growing token-by-token as it streams in
  // -- rendered as a plain, ever-updating text block (simplest correct
  // behavior first); the SQL/rows are already fully present in `metadata`
  // from the first update, so those render immediately via the existing
  // `<pre>`/`ResultTable` treatment.
  return (
    <div className="chat-bubble chat-bubble--assistant" data-kind={content.kind}>
      <div className="chat-bubble-label">Assistant &middot; {content.kind}</div>
      {content.text && <p>{content.text}</p>}
      {content.sql && (
        <pre className="chat-sql">
          <code>{content.sql}</code>
        </pre>
      )}
      {content.rows && <ResultTable rows={content.rows} />}
    </div>
  );
}
