"use client";

import { useCallback, useMemo, useState, type FormEvent } from "react";
import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";
import { SCHEMA_EDGES, SCHEMA_NODES } from "./schemaGraph";

// Mirrors the `/api/chat` response shapes documented in
// `web/src/app/api/chat/route.ts` — read, not modified, by this track.
interface ChatResponse {
  kind?: "reject" | "clarify" | "no_answer" | "tier3" | "tier4";
  category?: string;
  message?: string;
  question?: string;
  sql?: string;
  rows?: unknown[];
  error?: string;
}

interface InspectSqlResponse {
  tables?: string[];
  error?: string;
}

const NODE_WIDTH = 220;
const ONT_ROW_Y = 0;
const SEM_ROW_Y = 220;

function buildBaseNodes(): Node[] {
  const ontNodes = SCHEMA_NODES.filter((n) => n.tier === "ont");
  const semNodes = SCHEMA_NODES.filter((n) => n.tier === "sem");

  const toNode = (schemaNode: (typeof SCHEMA_NODES)[number], index: number, y: number): Node => ({
    id: schemaNode.id,
    position: { x: index * (NODE_WIDTH + 40), y },
    data: { label: schemaNode.label },
    style: {
      whiteSpace: "pre-line",
      fontSize: 11,
      border: "1px solid var(--ps-border)",
      background: "var(--ps-panel)",
      color: "var(--ps-fg)",
      borderRadius: 6,
      padding: 8,
      width: NODE_WIDTH,
    },
  });

  return [
    ...ontNodes.map((n, i) => toNode(n, i, ONT_ROW_Y)),
    ...semNodes.map((n, i) => toNode(n, i, SEM_ROW_Y)),
  ];
}

const BASE_NODES = buildBaseNodes();

const BASE_EDGES: Edge[] = SCHEMA_EDGES.map((edge, index) => ({
  id: `${index}-${edge.source}->${edge.target}`,
  source: edge.source,
  target: edge.target,
  label: edge.label,
  style: { stroke: "var(--ps-muted)" },
  labelStyle: { fill: "var(--ps-muted)", fontSize: 9 },
  labelBgStyle: { fill: "var(--ps-bg)" },
}));

function verdictLabel(result: ChatResponse | null): string | null {
  if (!result) return null;
  switch (result.kind) {
    case "tier3":
      return "Valid SQL — already passed astValidator.ts (Tier 3, sem.* allowlist) inside /api/chat.";
    case "tier4":
      return "Valid SQL — already passed astValidator.ts (Tier 4, raw-table allowlist) inside /api/chat.";
    case "no_answer":
      return "No SQL generated — pipeline returned no_answer.";
    case "clarify":
      return "No SQL generated — pipeline requested clarification.";
    case "reject":
      return `Rejected by guardrails${result.category ? ` (category: ${result.category})` : ""}.`;
    default:
      return result.error ? `Error: ${result.error}` : null;
  }
}

/**
 * Interactive SQL + Schema Auditor.
 *
 * Left panel: submit a question through the same `/api/chat` pipeline Chat
 * uses, see the SQL it produced (already gated by `astValidator.ts` inside
 * that route — this page never re-validates it, just reports the verdict
 * the pipeline already reached) and which tables it referenced (via the
 * new `/api/auditor/inspect-sql` route).
 *
 * Right panel: a static schema DAG of every ont / sem object (see
 * `schemaGraph.ts`), with nodes for the current query's referenced tables
 * highlighted.
 */
export default function SqlAuditorTab() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatResult, setChatResult] = useState<ChatResponse | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const highlightedIds = useMemo(
    () => new Set(tables.map((t) => t.toLowerCase())),
    [tables],
  );

  const nodes: Node[] = useMemo(
    () =>
      BASE_NODES.map((node) => {
        const highlighted = highlightedIds.has(node.id.toLowerCase());
        return {
          ...node,
          style: {
            ...node.style,
            border: highlighted ? "2px solid var(--ps-accent)" : node.style?.border,
            boxShadow: highlighted ? "0 0 0 2px var(--ps-accent)" : "none",
          },
        };
      }),
    [highlightedIds],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = question.trim();
      if (!trimmed) return;

      setLoading(true);
      setRequestError(null);
      setInspectError(null);
      setChatResult(null);
      setTables([]);

      try {
        const chatResponse = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed, sessionId: "auditor-session" }),
        });
        const chatJson = (await chatResponse.json()) as ChatResponse;
        setChatResult(chatJson);

        if (chatJson.sql) {
          try {
            const inspectResponse = await fetch("/api/auditor/inspect-sql", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sql: chatJson.sql }),
            });
            const inspectJson = (await inspectResponse.json()) as InspectSqlResponse;
            if (inspectJson.tables) {
              setTables(inspectJson.tables);
            } else if (inspectJson.error) {
              setInspectError(inspectJson.error);
            }
          } catch (err) {
            setInspectError((err as Error).message);
          }
        }
      } catch (err) {
        setRequestError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [question],
  );

  const verdict = verdictLabel(chatResult);

  return (
    <div className="auditor-root">
      <h2>SQL + Schema Auditor</h2>
      <p>
        Submit a question through the same pipeline as Chat (guardrails →
        Tier 3 → Tier 4), inspect the SQL it produced, and see which{" "}
        <code>ont.*</code>/<code>sem.*</code> objects it touched highlighted
        on the schema DAG.
      </p>

      <div className="auditor-panels">
        <section className="auditor-panel">
          <form className="auditor-form" onSubmit={handleSubmit}>
            <label htmlFor="auditor-question">Question</label>
            <textarea
              id="auditor-question"
              className="auditor-textarea"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={3}
              placeholder="e.g. How many serious adverse events were reported for imatinib in 2023?"
            />
            <button className="auditor-submit" type="submit" disabled={loading || !question.trim()}>
              {loading ? "Running…" : "Submit"}
            </button>
          </form>

          {requestError && <p className="auditor-error">{requestError}</p>}

          {chatResult && (
            <div className="auditor-result">
              {verdict && <p className="auditor-verdict">{verdict}</p>}
              {chatResult.message && <p className="auditor-message">{chatResult.message}</p>}
              {chatResult.sql && (
                <pre className="auditor-sql">{chatResult.sql}</pre>
              )}
              {inspectError && <p className="auditor-error">{inspectError}</p>}
              {tables.length > 0 && (
                <p className="auditor-tables">
                  Tables referenced: {tables.join(", ")}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="auditor-panel">
          <h3>Schema DAG</h3>
          <p className="auditor-graph-caption">
            Static ont.*/sem.* graph built from db/ddl/003_ontology.sql and
            db/ddl/004_semantic_views.sql. Nodes matching the query above are
            highlighted.
          </p>
          <div className="auditor-graph">
            <ReactFlow
              nodes={nodes}
              edges={BASE_EDGES}
              fitView
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </section>
      </div>
    </div>
  );
}
