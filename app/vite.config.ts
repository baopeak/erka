import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Tauri expects a fixed dev port and serves the built `dist/` in production.
export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1427, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
