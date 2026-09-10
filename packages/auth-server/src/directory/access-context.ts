import { db } from "../db/client.js";
import { createDirectory } from "./service.js";
export { assembleAccessContext, type AccessContext } from "./service.js";
export const { hasLiveAppAccess, getAccessContext } = createDirectory(db);
