import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { closeDatabase } from "../db/client.js";
import { projectRootPath } from "../config.js";
import { applyDirectorySeed } from "./apply.js";
import { seedSummary, validateDirectorySeed } from "./model.js";

function parseArguments(argv: string[]) {
  let file = path.join(projectRootPath, "packages/auth-server/seeds/directory.seed.example.json");
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--file") {
      const next = argv[index + 1];
      if (!next) throw new Error("--file requires a path");
      file = path.resolve(projectRootPath, next);
      index += 1;
    }
    else if (argument === "--help") {
      console.log("Usage: npm run directory:seed -- --file path/to/seed.json [--apply]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { file, apply };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const raw = JSON.parse(await fs.readFile(options.file, "utf8")) as unknown;
  const seed = validateDirectorySeed(raw);
  console.log(JSON.stringify({ mode: options.apply ? "apply" : "dry-run", file: options.file, ...seedSummary(seed) }, null, 2));
  if (!options.apply) {
    console.log("Validation passed. Re-run with --apply to update PostgreSQL transactionally.");
    return;
  }
  await applyDirectorySeed(seed);
  console.log("Directory seed applied successfully.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => closeDatabase());
