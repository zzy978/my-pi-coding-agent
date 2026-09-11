import { fileURLToPath } from "node:url";

// Tests and their subprocesses must never read the user's real .env.
process.env.PICODE_ENV_FILE = fileURLToPath(new URL("../../.env.example", import.meta.url));
for (const name of Object.keys(process.env)) {
  if (name.startsWith("PICODE_MODEL_") || name.startsWith("PICODE_SYNTHESIS_")) delete process.env[name];
}
