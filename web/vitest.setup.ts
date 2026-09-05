// Global test setup. Ensures unit tests never depend on a real .env.local —
// individual tests still mock out the DB/Anthropic clients directly, but
// this keeps module-load-time env reads (e.g. `new Anthropic()`,
// `new Pool()`) from throwing when no real credentials are configured.

process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";
process.env.ANTHROPIC_MODEL ||= "claude-sonnet-5";
process.env.PGHOST ||= "localhost";
process.env.PGPORT ||= "5432";
process.env.PGDATABASE ||= "pharmasentinel_test";
process.env.PGUSER ||= "test_user";
process.env.PGPASSWORD ||= "test_password";
