import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Mock the vscode module for all files (test files + globalSetup)
      // so that `import type { ... } from "vscode"` type-only imports
      // don't cause resolution errors.
      vscode: path.resolve(__dirname, "test/__mocks__/vscode.ts"),
    },
  },
  test: {
    globalSetup: ["./test/setup/globalSetup.ts"],
  },
});
