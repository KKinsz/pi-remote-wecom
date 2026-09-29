# Contributing

Bug reports, documentation fixes, and focused pull requests are welcome. English and Chinese are both welcome.

## Local development

Use Node.js ≥22.19 and run from the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
```

`check` runs TypeScript checks, regression tests, and package-content checks. `test:package` builds a temporary npm archive, installs its production dependencies, and loads its extension with a real offline Pi host. Both use fake credentials and isolated runtime directories; they do not call a model or start the system service. Package installation needs network access.

For manual testing, use a dedicated bot and run `pi install "$PWD"`, `/reload`, then `/remote setup`. Never reuse a bot that is connected to another client.

## Changes and reports

- Keep each change focused and explain the user-visible behavior and validation.
- Add regression coverage for behavior changes, especially message ownership, binding, retries, and task interruption. Documentation-only edits do not need new tests.
- Keep the English and Chinese READMEs consistent. Record user-facing changes under `Unreleased` in `CHANGELOG.md`.
- For terminal bugs, include the terminal, OS, Node.js, Pi, and package versions, plus minimal reproduction steps. Distinguish automated results from real-device observations.
- Never attach credentials, binding codes, personal sessions, private paths, or unredacted logs. See [SECURITY.md](SECURITY.md) for sensitive reports.

## Layout

- `extensions/`: Pi commands, lifecycle hooks, session routing, and naming integration.
- `daemon/`: local service, WeCom transport, terminal adapters, and session engine.
- `bin/`: service CLI and session launcher.
- `vendor/tab-title/`: vendored naming implementation; preserve its license and record changes.
- `tests/`: offline regression and transport integration tests.
- `scripts/`: maintained validation tools, not local scratch files.

Retain the MIT license and source notices when redistributing derived code. See [NOTICE.md](NOTICE.md).
