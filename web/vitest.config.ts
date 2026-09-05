import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

// __dirname is undefined in ESM — derive it from import.meta.url instead.
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Matches Next's own compiler (React 19 automatic JSX runtime — no
  // `import React from "react"` needed in .tsx files). Without this,
  // esbuild's default classic transform throws "React is not defined" for
  // the chat/cohort component tests.
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // ".test.tsx" added alongside ".test.ts" for the chat/cohort component
    // tests (React Testing Library) — those files set their own
    // `// @vitest-environment jsdom` docblock, so the default `environment`
    // above stays "node" for every other (non-DOM) test in the project.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
  },
});
