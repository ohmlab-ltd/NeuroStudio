# Contributing

## Development setup

```bash
npm ci
npm run dev
```

Node.js 22.12 or later. `npm run dev` starts Vite and Electron with hot
reload. The native modules, `usb` and `serialport`, ship prebuilt binaries,
so no compiler is needed.

Environment variables: `NEURO_STUDIO_NETWORK_ONLY=1` never loads libusb and
starts on WiFi SoftAP, `NEURO_STUDIO_WIFI_HOST` and `NEURO_STUDIO_WIFI_PORT`
set the SoftAP address, and `NEURO_STUDIO_NO_UPDATE_CHECK=1` turns off the
update check, which runs only in packaged builds. The update check reads the
repository from `package.json`.

## Tests

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
```

The unit tests drive the transport session against a fake node-usb and local
TCP servers, so they need no board. Two suites run only when pointed at real
data, as the README describes: `NEURO_STUDIO_CAPTURES` replays board captures,
and `NEURO_STUDIO_LIVE` runs against a board on the network. CI runs lint, the
format check, the build and the tests on Windows, macOS and Linux for every
push to `main` and every pull request.

## Rules

- The wire protocol is a public contract ([docs/protocol.md](docs/protocol.md)).
  A change to what the app sends or reads updates that document in the same
  pull request.
- Tests never list real USB devices: listing sends requests to every device on
  the bus. Use the fake node-usb in `test/usb-transport.test.ts`, or a network
  transport.
- A bug fix comes with a test that fails without it.
- Comments and documentation are short, factual, in the present tense and in
  ASCII.

## Releases

Set `version` in `package.json`, rename the `## Unreleased` section of
`CHANGELOG.md` to `## X.Y.Z`, then push a `vX.Y.Z` tag. The release workflow
builds the installers for Windows, macOS and Linux, installs and runs each one,
and attaches them to the tag's release with that section as the release notes.
[docs/RELEASING.md](docs/RELEASING.md) has the details, and how to set up
signing.
