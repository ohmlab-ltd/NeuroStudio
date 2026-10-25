import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

/// Content-Security-Policy for the renderer.
function cspDirectives(dev: boolean): Record<string, string[]> {
  return {
    "default-src": ["'self'"],
    // The dev server adds React Refresh's inline preamble.
    "script-src": dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "blob:", "data:"],
    "font-src": ["'self'"],
    // The dev server's hot reload talks over a websocket.
    "connect-src": dev ? ["'self'", "ws:"] : ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
  };
}

function contentSecurityPolicy(): Plugin {
  let policy = "";
  return {
    name: "neuro-studio:csp",
    configResolved(config) {
      policy = Object.entries(cspDirectives(config.command === "serve"))
        .map(([name, sources]) => `${name} ${sources.join(" ")}`)
        .join("; ");
    },
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: policy },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(version) },
});
