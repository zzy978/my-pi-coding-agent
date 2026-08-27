#!/usr/bin/env node

import { APP_NAME, isSupportedNodeVersion, minimumNodeVersionText } from "./config.js";
import { CliUsageError, parseCliArgs } from "./cli-args.js";

if (!isSupportedNodeVersion()) {
  console.error(`${APP_NAME} requires Node.js >= ${minimumNodeVersionText()}; current version is ${process.versions.node}.`);
  process.exitCode = 1;
} else {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const { run } = await import("./main.js");
    process.exitCode = await run(options);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`${error.message}\nRun ${APP_NAME} --help for usage.`);
    } else {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    }
    process.exitCode = 1;
  }
}
