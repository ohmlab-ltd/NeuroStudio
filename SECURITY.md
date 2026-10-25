# Security policy

## Reporting a vulnerability

Email security@ohmlab.co.uk with a description, the affected versions and steps to
reproduce. Do not open a public issue.

## Scope

Neuro Studio and the installers attached to its releases.

## Neuro N6 boards

Report security issues to security@ohmlab.co.uk. The Neuro N6 boards' security
policy and support period are published at https://neuron6.com/security.

## Limits

- The video stream and the commands sent to a board are not encrypted, over
  USB or the network. Anyone on the same network can watch a board that
  streams over WiFi or Ethernet.
- A link key (`WiFi.setLinkKey()`) makes a board stream only to a host that
  answers its challenge with HMAC-SHA256 over the key. It authenticates the
  host; it does not encrypt the stream.
- Over USB, a board that hosts a WiFi network sends that network's name and
  password, so the app can show them. The app accepts them only over USB,
  keeps them in memory, shows the password only when asked and never logs or
  saves them.
- Listing USB devices sends requests to every device on the bus.
  `--network-only` never loads libusb.
- The bootloader tool writes firmware to the board's flash. An image written
  over the FSBL can leave the board recoverable only with BOOT1 and SWD; the
  tool asks for confirmation first.
- The app connects only to the boards it is pointed at. Its only internet
  request is the update check: once per launch it reads the latest release's
  version from GitHub's API and offers to open the release page. It
  downloads no installer. `NEURO_STUDIO_NO_UPDATE_CHECK=1` turns the check
  off.
- The renderer runs sandboxed, with context isolation and a
  Content-Security-Policy. It reaches the board only through the preload
  bridge.
- Until signing is set up (docs/RELEASING.md), the Windows installers are not
  code-signed and the macOS app is ad-hoc signed and not notarized, so
  SmartScreen and Gatekeeper warn on first launch.
