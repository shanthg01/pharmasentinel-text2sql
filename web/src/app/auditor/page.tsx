export default function SqlAuditorTab() {
  return (
    <div>
      <h2>SQL + Schema Auditor</h2>
      <p>
        Inspect the generated SQL, its AST-validator verdict, and a visual
        schema DAG (via reactflow) of the sem.* views a query touched — not
        yet implemented.
      </p>
    </div>
  );
}
