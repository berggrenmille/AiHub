import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const daemonPort = Number(process.env.AIHUB_PORT ?? 7420);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // changeOrigin rewrites Host to the daemon's address so its Host check passes.
      "/api": { target: `http://127.0.0.1:${daemonPort}`, changeOrigin: true },
    },
  },
});
