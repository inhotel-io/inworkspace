import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const mailServer = process.env.CONSOLE_MAIL_SERVER ?? "http://localhost:18080";
const consoleApi = process.env.CONSOLE_API ?? "http://localhost:3100";

/**
 * In production the console service writes its settings into index.html (src/lib/uiBundle.ts).
 * The development server fills them itself. API calls stay on its own origin and are proxied,
 * as are the mail server's sign-in paths. The page gets no content security policy, because
 * Vite injects inline scripts.
 */
function developmentSettings(): Plugin {
  return {
    name: "inworkspace-console-development-settings",
    apply: "serve",
    transformIndexHtml(html) {
      return html
        .replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
        .replace("__CONSOLE_API_URL__", "")
        .replace("__CONSOLE_OAUTH_CLIENT_ID__", process.env.CONSOLE_OAUTH_CLIENT_ID ?? "inworkspace-console")
        .replace("__CONSOLE_TIME_ZONE__", "");
    },
  };
}

export default defineConfig({
  root: "ui",
  // Relative asset URLs: the server places the app under a prefix and rewrites <base href>.
  base: "./",
  plugins: [react(), tailwindcss(), developmentSettings()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // The manifest names the entry and its stylesheets; the console service generates its loader from it.
  build: { outDir: path.resolve(import.meta.dirname, "ui-dist"), emptyOutDir: true, manifest: true },
  server: {
    port: 5173,
    proxy: {
      "/api/v1": consoleApi,
      "/api/auth": mailServer,
      "/auth": mailServer,
      "/login": mailServer,
    },
  },
});
