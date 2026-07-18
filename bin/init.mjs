#!/usr/bin/env node

import { initializeEnvironment } from "../src/environment/generator.mjs";

function parse(argv) {
  const options = { directory: "." };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      if (options.directory !== ".") throw new Error("Only one project directory may be provided");
      options.directory = token;
      continue;
    }
    const key = token.slice(2);
    if (key === "dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    index += 1;
    if (key === "agents") options.agents = value.split(",");
    else if (key === "name") options.name = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  return options;
}

initializeEnvironment(parse(process.argv.slice(2))).then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
