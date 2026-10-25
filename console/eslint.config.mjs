import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Underscore-prefixed parameters exist only to give a callback its type.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The web app is not a Next.js app: it runs on the mail server's origin and navigates itself.
    files: ["ui/**"],
    rules: { "@next/next/no-location-assign-relative-destination": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The built web app.
    "ui-dist/**",
    // The web admin patch set: files for the web UI's own tree, linted there when it is built.
    "webadmin/**",
  ]),
]);

export default eslintConfig;
