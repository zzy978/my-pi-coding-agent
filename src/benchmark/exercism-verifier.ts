/** Standalone verifier copied into each benchmark repository; no dependency on Agent. */
export const verifierSource = String.raw`const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = __dirname;
const manifestText = fs.readFileSync(path.join(root, 'benchmark.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const slug = process.argv[2];
const exercise = manifest.exercises.find(item => item.slug === slug);
function integrity() {
  if (fs.readFileSync(path.join(root, 'benchmark.json'), 'utf8') !== manifestText) throw new Error('benchmark.json changed during verification');
  for (const [name, expected] of Object.entries(manifest.immutable)) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
    if (digest !== expected) throw new Error('Immutable benchmark file changed: ' + name);
  }
}
let temporary;
try {
  if (!exercise || !/^[a-z]+(?:-[a-z]+)*$/.test(slug)) throw new Error('Unknown exercise: ' + slug);
  integrity();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'exercism-verifier-'));
  const reportPath = path.join(temporary, 'results.json');
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', path.join(root, 'node_modules/jest/bin/jest.js'),
    '--config', path.join(root, 'jest.config.cjs'), '--runInBand', '--runTestsByPath', path.join(root, 'exercises', slug, slug + '.spec.js'),
    '--json', '--outputFile', reportPath], { cwd: root, encoding: 'utf8', timeout: 100000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  integrity();
  const complete = report.numTotalTests === exercise.tests && report.numPendingTests === 0 && report.numTodoTests === 0 && report.numRuntimeErrorTestSuites === 0;
  console.log('BENCHMARK_RESULT ' + JSON.stringify({ slug, total: report.numTotalTests, passed: report.numPassedTests,
    failed: report.numFailedTests, pending: report.numPendingTests, complete }));
  process.exitCode = result.status === 0 && report.success === true && complete && report.numPassedTests === exercise.tests ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
}
`;
