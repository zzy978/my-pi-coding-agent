import { prepareExercism } from "./exercism-prepare.js";

const args = process.argv.slice(2);
const destination = args[0];
if (args.length !== 1 || !destination || destination.startsWith("-")) {
  console.error("用法：npm run benchmark:exercism -- <尚不存在的独立题库目录>");
  process.exitCode = 2;
} else {
  try { await prepareExercism(destination); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("准备未完成。若已创建目录，将保留供排查且不会覆盖；修复原因后请使用新目录重试。");
    process.exitCode = 1;
  }
}
