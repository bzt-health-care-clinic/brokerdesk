import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "work/**",
    "next-env.d.ts",
  ]),
  {
    files: ["components/ui/**/*.{ts,tsx}", "hooks/use-mobile.ts"],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["lib/reconciliation.ts"],
    rules: {
      // `use` is a local resolved-value accessor, not a React Hook.
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    files: ["app/page.tsx", "components/ingestion-panel.tsx"],
    rules: {
      // These mount-only effects hydrate browser preferences from localStorage.
      "react-hooks/set-state-in-effect": "off",
      // Page-level repository callbacks are deliberately captured by debounced
      // effects; adding their changing function identities would retrigger them.
      "react-hooks/exhaustive-deps": "off",
    },
  },
]);

export default eslintConfig;
