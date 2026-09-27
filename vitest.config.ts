import { defineConfig } from "vitest/config";
import path from "path";

/**
 * TOEGEVOEGD 19-9-2026 -- ontbrak volledig. `route-via-knooppunten.test.ts` is het eerste
 * testbestand dat (via een import in het geteste bestand zelf) een `@/`-alias-pad raakt;
 * vitest kende deze alias niet (geen eigen config, geen vite-tsconfig-paths-plugin) terwijl
 * Next.js/tsc 'm via tsconfig.json's "paths" wél altijd al kende. Spiegelt exact diezelfde
 * mapping (`"@/*": ["./*"]`) i.p.v. een aparte, mogelijk afwijkende definitie te verzinnen.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
