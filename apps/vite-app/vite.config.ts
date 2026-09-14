import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL("../../", import.meta.url)), "APP_A_");
  const origin = new URL(process.env.APP_A_ORIGIN || env.APP_A_ORIGIN || "http://localhost:5173");
  const port = Number(origin.port || 5173);
  return { server: { port, strictPort: true }, preview: { port, strictPort: true } };
});
