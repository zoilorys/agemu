# Contributing

## Set up the project

Install Node.js 24 or later and pnpm. Then run:

```sh
pnpm install
pnpm test
```

## Submit a change

Keep each pull request focused. Add tests that reproduce changed behavior, and run `pnpm test` before opening the pull request. Avoid tests that only copy the registry or implementation. The root Vitest configuration includes only `test/**/*.test.ts`; nested review worktree copies do not contribute results.

Native integration tests require Xcode and an available iOS Simulator:

```sh
AGEMU_NATIVE_SIMULATOR_UDID=<udid> pnpm test:integration:native
```

This builds the CLI and runs all native integration files serially against the selected Simulator. They share the fixture app and must not compete with another XCTest automation runner. The suites preserve evidence under `.agemu/`, terminate the fixture and shut down a selected Simulator only when they booted it, and use a throwaway Simulator for erase/delete checks. They do not erase the selected device. Run one file after a focused change with:

```sh
pnpm build
AGEMU_NATIVE=1 AGEMU_NATIVE_SIMULATOR_UDID=<udid> pnpm exec vitest run test/integration/ui-inspection.test.ts
```

Process fixtures verify shared idb/XCTest result and failure contracts; they do not prove live backend parity. A live idb check also needs a compatible installed companion. The current ARM64-only official companion package cannot run on the Intel verification host, so live idb is explicitly unavailable there.

Before release, run `pnpm build`, `pnpm test`, the serial native suites and `pnpm pack --pack-destination <directory>`. Inspect the archive for `dist/cli/main.js`, runner sources/project, README and LICENSE; temporary `.agemu/` evidence and task/review directories must not ship. `ws` is a production dependency for Metro console transport and must remain listed in the packed manifest.
