# Changelog

This changelog starts at the first public release.

## 0.1.0

The first public release of Neuro Studio, the desktop app for the Ohm Lab
Neuro N6 AI development board.

### Added

- Installers for Windows (`Neuro-Studio-Setup.exe`, plus a portable
  `Neuro-Studio-Portable.exe`), macOS (`Neuro-Studio.dmg`, one image for
  Apple Silicon and Intel) and Linux (`neuro-studio_amd64.deb`, which also
  installs the board's udev rule, and `Neuro-Studio-x86_64.AppImage`).
- The app tells you when a newer release is out and opens its page. It
  downloads nothing itself.
- Live camera over USB, WiFi (the network the board hosts) and Ethernet,
  with snapshots and MJPEG recording. A recording keeps every frame the board
  sends, even when the window shows fewer.
- WiFi from the board's own network: with the board on USB first, the connect
  help shows the network's name and password, the password hidden until asked
  for, with a Copy button, and the app connects to the address the board
  announces.
- Inference overlays: detection boxes, instance masks, keypoints and
  skeletons, and class labels.
- Sensor panels: ToF depth grid, FLIR Lepton thermal view with colour maps and
  temperature probes, magnetometer and IMU plots, and a Terminal that prints
  each numbered line from the board once and starts afresh when the board
  restarts.
- Tuning: ISP controls, manual exposure, and sliders for any parameter a
  sketch exposes, with "copy as code".
- Vision, classifiers and events: QR codes, barcodes, colour blobs and
  AprilTags with pose, the image and audio classifiers, and events the board
  records.
- Microphone playback on the computer.
- Bootloader tool: flashes a firmware `.bin` over USB, verified by CRC.
- WiFi setup: stores the network a board joins or hosts, WPA2 or WPA3 only,
  and its link key, over USB. A hosted network can keep the board's own
  password. Boards with a link key stream only to a host that knows it.
- Several boards: a window per board, each picked by USB port.
- `--network-only`, which never loads libusb, for computers where USB
  devices must not be touched.
- The status bar shows the app's version.
- The wire protocol between the app and the board, in `docs/protocol.md`.

### Notes

- The Windows installers are not code-signed and the macOS app is ad-hoc
  signed, so SmartScreen and Gatekeeper warn on first launch. The README's
  First launch section shows how to open it. Windows code signing is being
  set up for a later release.
- On Windows, boards whose firmware still uses the legacy USB identity
  (`CAFE:4013`) need the WinUSB driver, installed once with Zadig.
