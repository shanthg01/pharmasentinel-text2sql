"use client";

import { useId, useState, type FormEvent } from "react";
import { postChat, newSessionId, type ChatApiResponse } from "./apiClient";
import { ResultTable } from "./ResultTable";

type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: ChatApiResponse }
  | { role: "assistant"; content: { kind: "error"; message: string } };

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

    try {
      const response = await postChat(question, sessionId);
      setMessages((prev) => [...prev, { role: "assistant", content: response }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: { kind: "error", message } },
      ]);
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
        {loading && (
          <div className="chat-bubble chat-bubble--assistant chat-bubble--loading">
            <div className="chat-bubble-label">Assistant</div>
            <div>Thinking…</div>
          </div>
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

  if (content.kind === "reject" || content.kind === "clarify") {
    return (
      <div
        className="chat-bubble chat-bubble--assistant chat-bubble--guardrail"
        data-kind={content.kind}
      >
        <div className="chat-bubble-label">
          {content.kind === "reject" ? "Request declined" : "Clarification needed"}
        </div>
        <div>{content.message ?? content.question}</div>
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
        <div>{content.message ?? "I couldn't find a way to answer that from the available data."}</div>
      </div>
    );
  }

  // "tier3" / "tier4" (or any future success kind carrying sql/rows).
  return (
    <div className="chat-bubble chat-bubble--assistant" data-kind={content.kind}>
      <div className="chat-bubble-label">Assistant &middot; {content.kind}</div>
      {content.message && <p>{content.message}</p>}
      {content.sql && (
        <pre className="chat-sql">
          <code>{content.sql}</code>
        </pre>
      )}
      {content.rows && <ResultTable rows={content.rows} />}
    </div>
  );
}

