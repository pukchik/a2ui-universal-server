import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/v1": "http://127.0.0.1:3100",
      "/auth": "http://127.0.0.1:3100",
      "/docs": "http://127.0.0.1:3100",
      "/openapi.json": "http://127.0.0.1:3100",
      "/health": "http://127.0.0.1:3100",
    },
  },
});
