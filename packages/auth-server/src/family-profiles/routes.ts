import type { personProfileService } from "./person-service.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import {
  ProfileError,
  familyProfileService,
  type ProfileActor,
} from "./service.js";
export function familyProfileRoutes(
  service:
    | ReturnType<typeof familyProfileService>
    | ReturnType<typeof personProfileService>,
  authenticate: (request: Request) => Promise<ProfileActor>,
  collection: "families" | "people" = "families",
) {
  const app = new Hono<{ Variables: { actor: ProfileActor } }>();
  app.use("*", bodyLimit({ maxSize: 16384 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    // Only bearer credentials are accepted; cookies never authorize this API.
    c.set("actor", await authenticate(c.req.raw));
    await next();
  });
  const uuid = (v: string) => z.uuid().parse(v);
  app.get("/", async (c) => c.json(await service.home(c.get("actor"))));
  app.get(`/${collection}/:id`, async (c) =>
    c.json(await service.profile(c.get("actor"), uuid(c.req.param("id")))),
  );
  app.post(`/${collection}/:id/requests`, async (c) => {
    const x = z
      .object({ id: z.uuid() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await service.create(c.get("actor"), uuid(c.req.param("id")), x.id),
      201,
    );
  });
  app.post("/requests/:id/save", async (c) =>
    c.json(
      await service.save(
        c.get("actor"),
        uuid(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.post("/requests/:id/:action", async (c) => {
    const action = z
      .enum(["submit", "approve", "reject", "return", "withdraw"])
      .parse(c.req.param("action"));
    return c.json(
      await service.action(
        c.get("actor"),
        uuid(c.req.param("id")),
        action,
        await c.req.json(),
      ),
    );
  });
  app.onError((error, c) => {
    if (error instanceof ProfileError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({ error: "資料格式不正確，請檢查欄位。" }, 400);
    // Don't leak PII/query arguments in database error messages.
    return c.json({ error: "資料審核服務暫時無法使用，請稍後再試。" }, 503);
  });
  return app;
}
