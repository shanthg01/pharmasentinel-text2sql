// Shared rows-as-table rendering for both the Chat tab and the Cohort
// Builder. Deliberately not a "page.tsx" export — Next.js route files
// should only really export the page component (plus route-segment
// config), so this shared bit lives in its own module instead.

const MAX_DISPLAYED_ROWS = 50;

export function ResultTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) {
    return <p className="chat-empty">Query ran successfully but returned no rows.</p>;
  }

  const columns = Object.keys(rows[0]);
  const displayRows = rows.slice(0, MAX_DISPLAYED_ROWS);
  const remaining = rows.length - displayRows.length;

  return (
    <div className="chat-table-wrap">
      <table className="chat-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => (
                <td key={column}>{formatCell(row[column])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {remaining > 0 && (
        <p className="chat-table-note">
          {remaining} more row{remaining === 1 ? "" : "s"} not shown.
        </p>
      )}
    </div>
  );
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
