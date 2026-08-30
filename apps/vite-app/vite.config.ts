import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, projectRoot, "");
  return {
    plugins: [react()],
    define: {
      __SMZ_AUTH_ISSUER__: JSON.stringify(environment.AUTH_ISSUER ?? "http://localhost:3000/api/auth"),
      __SMZ_TAILSCALE_HOST__: JSON.stringify(environment.TAILSCALE_HOST ?? ""),
      __SMZ_TAILSCALE_IP__: JSON.stringify(environment.TAILSCALE_IP ?? ""),
      __SMZ_TAILSCALE_APP_A_PORT__: JSON.stringify(environment.TAILSCALE_APP_A_PORT ?? "8445"),
      __SMZ_TAILSCALE_APP_B_PORT__: JSON.stringify(environment.TAILSCALE_APP_B_PORT ?? "8444"),
    },
    server: { host: "0.0.0.0", allowedHosts: environment.TAILSCALE_HOST ? [environment.TAILSCALE_HOST] : [] },
    preview: { host: "0.0.0.0", allowedHosts: environment.TAILSCALE_HOST ? [environment.TAILSCALE_HOST] : [] },
  };
});
