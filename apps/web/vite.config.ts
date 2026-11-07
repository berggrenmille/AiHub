import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const daemonPort = Number(process.env.AIHUB_PORT ?? 7420);
// The daemon allows this port's origin to make state-changing requests (apps/daemon/src/config.ts).
const webPort = Number(process.env.AIHUB_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      // changeOrigin rewrites Host to the daemon's address so its Host check passes.
      "/api": {
        target: `http://127.0.0.1:${daemonPort}`,
        changeOrigin: true,
        configure: (proxy) => {
          // When the daemon stops mid-response, drop the browser's side too. Otherwise the proxy keeps
          // the event stream open and EventSource never notices the restart.
          proxy.on("proxyRes", (proxyRes, _request, response) => {
            proxyRes.on("close", () => {
              if (!response.writableEnded) response.destroy();
            });
          });
        },
      },
    },
  },
});
