import { writeFile } from "node:fs/promises";
const origin = new URL(process.env.AUTH_ISSUER).origin;
await writeFile("apps/vite-app/dist/_headers", `/logout/local\n  Content-Security-Policy: frame-ancestors ${origin}\n  Cache-Control: no-store\n`);
