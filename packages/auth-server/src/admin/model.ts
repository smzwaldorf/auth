import { z } from "zod";
import { t } from "./i18n.js";

export const userInput = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  status: z.enum(["active", "disabled"]),
  roles: z.array(z.enum(["admin", "teacher", "parent"])).min(1).max(3).transform(v => [...new Set(v)]),
  sites: z.array(z.object({ origin: z.string().max(2048), action: z.enum(["keep", "active", "revoked"]) })).max(100).default([]),
  catalogVersion: z.string().optional(),
  version: z.string().optional(),
});
export type UserInput = z.infer<typeof userInput>;
export class AdminError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 = 400) { super(message); }
}
export function protectSelf(actorId: string, targetId: string, input: UserInput) {
  if (actorId === targetId && (input.status !== "active" || !input.roles.includes("admin"))) {
    throw new AdminError(t("You cannot disable your own account or remove your admin role."), 403);
  }
}
