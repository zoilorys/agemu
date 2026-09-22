# Contributing

## Set up the project

Install Node.js 24 or later and pnpm. Then run:

```sh
pnpm install
pnpm test
```

## Submit a change

Keep each pull request focused. Add tests for changed behavior, and run `pnpm test` before opening the pull request.

Native integration tests require Xcode and an available iOS Simulator:

```sh
AGEMU_NATIVE_SIMULATOR_UDID=<udid> pnpm test:integration:native
```
