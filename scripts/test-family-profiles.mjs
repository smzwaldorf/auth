// Run the companion Auth integration suite against a dedicated disposable database.
import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import pg from "pg";
import { spawn } from "node:child_process";
const env = parse(await readFile(".env", "utf8"));
const url = new URL(env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname))
  throw Error("Loopback database required");
const pool = new pg.Pool({ connectionString: url.href });
try {
  if (
    !(
      await pool.query("select 1 from pg_database where datname=$1", [
        "smz_family_profiles_test",
      ])
    ).rowCount
  )
    await pool.query("create database smz_family_profiles_test");
} finally {
  await pool.end();
}
url.pathname = "/smz_family_profiles_test";
const child = spawn(
  process.execPath,
  [
    "../../node_modules/vitest/vitest.mjs",
    "run",
    "tests/integration/family-profiles.test.ts",
    "--no-file-parallelism",
  ],
  {
    cwd: "packages/auth-server",
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: url.href,
      NODE_ENV: "test",
      RUN_FAMILY_PROFILE_TESTS: "true",
    },
  },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
