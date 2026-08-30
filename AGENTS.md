# Repository Guidelines

## Project Structure & Architecture

Production TypeScript lives in `src/`. CLI entry points are `src/cli.ts` and `src/main.ts`; Pi integration is under `src/runtime/`; terminal code is in `src/tui/`. Security-sensitive boundaries span `src/policy/`, `src/workspace/`, and `src/verifier/`; `src/evaluation/` records and replays controlled runs. Tests live in `test/**/*.test.ts`; shared fixtures belong in `test/helpers/`. Example task specifications are in `examples/`. Do not edit or commit generated `dist/` and `coverage/` files.

## Build, Test, and Development Commands

Use Node.js 22.19.0 or newer and install locked dependencies with `npm ci`.

- `npm run dev -- <repo> --task "..."` runs the CLI directly through `tsx`.
- `npm run check` performs strict TypeScript checking without emitting files.
- `npm test` runs the complete Vitest suite once.
- `npm run test:coverage` writes V8 coverage reports to `coverage/`.
- `npm run lint` applies the type-aware ESLint rules.
- `npm run build` compiles publishable ESM output into `dist/`.
- `node dist/cli.js --doctor <repo>` validates Git, Node, repository, and model setup after a build.

Before submitting changes, run `npm run check`, `npm test`, `npm run lint`, and `npm run build`.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, double quotes, semicolons, and ESM imports. Use `camelCase` for variables and functions, `PascalCase` for types/classes, and kebab-case filenames such as `task-spec.ts`. Prefer explicit types at module boundaries and type-only imports where applicable. Keep promises handled; ESLint rejects floating or misused promises. Preserve strict compiler guarantees, including unchecked-index and exact-optional-property checks.

## Testing Guidelines

Use Vitest with descriptive `describe`/`it` blocks. Name files `<behavior>.test.ts` and place reusable Git setup in `test/helpers/`. Every bug fix needs a regression test. Changes to paths, commands, worktrees, verification, abort handling, or reports must test both allowed and rejected/failure behavior. No numeric coverage threshold is enforced; do not reduce meaningful coverage of changed logic.

## Security & Configuration

Treat worktrees, allowed-path globs, and command filtering as guardrails, not sandboxing. Keep generic shell access opt-in through `--unsafe-shell`, protect `.git`, `.env*`, and `node_modules`, and never add real credentials or model tokens. Use `PI_TUI_AGENT_DATA_DIR` for isolated test data when needed.

## Commits & Pull Requests

Follow the repository's Conventional Commit pattern (`feat: ...`, `fix: ...`). Keep commits focused. Pull requests should explain intent and risk, list verification commands, link relevant issues, and include terminal screenshots only when TUI output changes. Call out security-boundary or compatibility changes explicitly.
