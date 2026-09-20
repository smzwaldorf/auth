import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "./database.js";

const databases = new AsyncLocalStorage<Database>();

export function withRequestDatabase<T>(database: Database, run: () => T): T {
  return databases.run(database, run);
}

export const requestDatabase = new Proxy({} as Database, {
  get(_target, property) {
    const database = databases.getStore();
    if (!database) throw new Error("Database accessed outside an Auth request");
    const value = Reflect.get(database, property, database);
    return typeof value === "function" ? value.bind(database) : value;
  },
});
