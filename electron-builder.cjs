// Packaging for Windows, macOS and Linux. Signing turns on when its credentials are in the
// environment (docs/RELEASING.md). Without them Windows builds are unsigned and macOS builds
// are ad-hoc signed.

const path = require("node:path");

const env = process.env;

/** A Developer ID certificate, from CSC_LINK or named in the keychain by CSC_NAME. */
const macDeveloperId = Boolean(env.CSC_LINK || env.CSC_NAME);

/** Azure Artifact Signing (formerly Trusted Signing), when the account's details are set. */
const azureSignOptions =
  env.AZURE_SIGN_ENDPOINT &&
  env.AZURE_SIGN_ACCOUNT &&
  env.AZURE_SIGN_PROFILE &&
  env.AZURE_SIGN_PUBLISHER
    ? {
        endpoint: env.AZURE_SIGN_ENDPOINT,
        codeSigningAccountName: env.AZURE_SIGN_ACCOUNT,
        certificateProfileName: env.AZURE_SIGN_PROFILE,
        publisherName: env.AZURE_SIGN_PUBLISHER,
      }
    : null;

// Fixed file names keep each download's releases/latest/download link the same across releases.
/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.ohmlab.neurostudio",
  productName: "Neuro Studio",
  copyright: "Copyright (C) 2026 Ohm Lab Ltd",
  asar: true,
  // Native modules load from disk, not from inside the archive.
  asarUnpack: ["**/node_modules/usb/**", "**/node_modules/@serialport/**"],
  directories: { output: "release", buildResources: "buildResources" },
  files: ["dist/**/*", "electron/**/*", "package.json"],
  // usb and serialport ship prebuilt binaries for every platform.
  npmRebuild: false,
  // The app checks for updates itself; no electron-updater metadata.
  publish: null,
  extraResources: [
    { from: "LICENSE", to: "LICENSE" },
    { from: "THIRD-PARTY-NOTICES.md", to: "THIRD-PARTY-NOTICES.md" },
  ],

  win: {
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ],
    icon: "buildResources/icon.ico",
    azureSignOptions,
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    artifactName: "Neuro-Studio-Setup.${ext}",
  },
  portable: { artifactName: "Neuro-Studio-Portable.${ext}" },

  mac: {
    // One download for Apple Silicon and Intel Macs.
    target: [{ target: "dmg", arch: ["universal"] }],
    category: "public.app-category.developer-tools",
    icon: "buildResources/icon.icns",
    // Apple Silicon runs nothing unsigned, so a build without a Developer ID is signed ad hoc.
    // Notarization needs the hardened runtime; an ad-hoc build leaves it off, since its
    // library validation needs a Team ID that an ad-hoc signature does not have.
    ...(macDeveloperId ? { hardenedRuntime: true } : { identity: "-", hardenedRuntime: false }),
    extendInfo: {
      NSLocalNetworkUsageDescription:
        "Neuro Studio connects to Neuro N6 boards over WiFi and Ethernet.",
      // Electron's template declares these two BLE keys with its own wording; the app uses neither.
      NSBluetoothAlwaysUsageDescription: "Neuro Studio does not use BLE.",
      NSBluetoothPeripheralUsageDescription: "Neuro Studio does not use BLE.",
    },
  },
  dmg: { artifactName: "Neuro-Studio.${ext}" },

  linux: {
    target: [
      { target: "deb", arch: ["x64"] },
      { target: "AppImage", arch: ["x64"] },
    ],
    category: "Development",
    icon: "buildResources/icon.png",
    executableName: "neuro-studio",
    synopsis: "Desktop app for the Ohm Lab Neuro N6 AI development board",
    maintainer: "Ohm Lab <team@ohmlab.co.uk>",
    // AppImage users install the rule from here by hand, as the README says.
    extraResources: [{ from: "packaging/linux/60-neuro-n6.rules", to: "60-neuro-n6.rules" }],
  },
  deb: {
    artifactName: "neuro-studio_amd64.${ext}",
    // electron-builder's defaults, plus ALSA: Electron loads it at start, so a minimal system
    // without it installed the package and then could not open the app. Ubuntu 24.04 calls it
    // libasound2t64; older releases and Debian 12 call it libasound2.
    depends: [
      "libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0",
      "libuuid1",
      "libsecret-1-0",
      "libasound2t64 | libasound2",
    ],
    // The board's udev rule belongs to the package, so removing the package removes it.
    fpm: [
      `${path.join(__dirname, "packaging", "linux", "60-neuro-n6.rules")}=/lib/udev/rules.d/60-neuro-n6.rules`,
    ],
  },
  appImage: { artifactName: "Neuro-Studio-x86_64.${ext}" },
  // The static AppImage runtime: the default one needs libfuse2, which Ubuntu 22.04 and later
  // do not install, so the AppImage would not open there.
  toolsets: { appimage: "1.0.3" },
};
