import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parseRuntimeConfig, runtimeUrls } from "./runtime-config.js";
export const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(projectRootPath, ".env") });
export const config = parseRuntimeConfig(process.env);
export const { authOrigin, directoryAudience, trustedClientIds } = runtimeUrls(config);
export const authPort = Number(new URL(config.AUTH_ISSUER).port || 3000);
