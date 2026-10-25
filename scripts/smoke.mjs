// Installs the packaged app the way a customer would, runs it against a fake board on localhost,
// checks what it shows, and uninstalls it. The release workflow runs it on every platform.
//
//   node scripts/smoke.mjs              the unpacked app in release/
//   node scripts/smoke.mjs --install    the installer: NSIS, the .dmg or the .deb
//   node scripts/smoke.mjs --appimage   the AppImage (Linux)
//   --report <file>                     also writes the results as JSON
//
// The app runs with --network-only, so it never loads libusb or touches a USB device.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const argv = process.argv.slice(2);
const mode = argv.includes("--install")
  ? "install"
  : argv.includes("--appimage")
    ? "appimage"
    : "unpacked";
const reportPath = argv.includes("--report") ? argv[argv.indexOf("--report") + 1] : null;
// macOS: run the universal app's Intel half under Rosetta.
const intel = argv.includes("--x64");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  return Boolean(ok);
}
function note(name, detail) {
  results.push({ name, ok: null, detail: String(detail) });
  console.log(`note ${name}: ${detail}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value || Date.now() >= end) return value;
    await sleep(stepMs);
  }
}
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: "utf8", ...options });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
const tail = (text, lines = 15) => text.trim().split(/\r?\n/).slice(-lines).join("\n");

// The fake board: a 64x48 synthetic picture and one numbered Terminal line per frame, at 15 fps,
// in the vendor frame format of docs/protocol.md.

const JPEG = Buffer.from(
  [
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQ",
    "ERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU",
    "FBQUFBQUFBQUFBQUFBT/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA",
    "AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6",
    "Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG",
    "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA",
    "AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5",
    "OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE",
    "xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4F8FeCtZ+Iniaz8PeHrP+0NXvN/kW3mpF",
    "v2Izt8zsqjCqx5Pb1r1P/hiz4zf9Cb/5VLL/AOPUfsV/8nMeDf8At8/9Ip6/UqlObi7I+Cz3PcTleJjRoxi04p6p92ujXY/J",
    "nxr+zB8TPh34ZvPEPiHw1/Z+kWezz7n7fbS7N7qi/KkrMcsyjgd/SvLa/Ur9tT/k2fxl/wBuf/pbBX57eFfgF488a6Da61ou",
    "hfbdMud3lT/bII921ijfK0gIwykcjtXThqVbFNxpQcn2Sb/I9LJs3ljsLLEYtxjaXL2WyfVvXVnn1Ferf8MsfFD/AKFj/wAq",
    "Fr/8drz7xV4V1TwVr11outWv2LU7bb5sHmLJt3KHX5lJByrA8HvXRVwmJw8eatTlFd2mvzPoKeJoVny05qT8mmZVFFFch0Ht",
    "37Ff/JzHg3/t8/8ASKev1Kr8tf2K/wDk5jwb/wBvn/pFPX6lVy1fiPyLi/8A3+H+Bf8ApUjxH9tT/k2fxl/25/8ApbBXnP7L",
    "H/JB/DH/AG9f+lU1ejftqf8AJs/jL/tz/wDS2CvOf2WP+SD+GP8At6/9Kpq+44O/3yf+F/nEjBf8iZ/9ff8A2xHq1fC/xx8E",
    "618Rf2n9b8PeHrL+0NYvPI8i281It+yyjdvmdlUYVWPJ7etfdFfNfhD/AJSJWn/A/wD00NXrcf4meCyOriqaTlC8lfa6hNq+",
    "2mh9PwpSVbMlSltJW++UUeUf8MU/Gf8A6E3/AMqll/8AHq8r8beCda+HXie98PeIbL+z9Ys9nn23mpLs3orr8yMynKsp4Pf1",
    "r9oq/LH9tb/k5rxl/wBuX/pFBX8vcIcX4/iDHzwuKhBRUHL3VJO6lFdZPTU/Z83yihgKCq0m227a27N9Euwn7Ff/ACcx4N/7",
    "fP8A0inr9Sq/GLwV411n4d+JrPxD4evP7P1ez3+Rc+UkuzejI3yurKcqzDkd/WvU/wDhtP4zf9Dl/wCUuy/+M1+rzg5O6Pxf",
    "PcixOaYmNajKKSilq33b6J9z7c/bU/5Nn8Zf9uf/AKWwV5z+yx/yQfwx/wBvX/pVNXyb41/af+JnxE8M3nh7xD4l/tDSLzZ5",
    "9t9gtot+x1dfmSJWGGVTwe3pWd4V+PvjzwVoNroui679i0y23eVB9jgk27mLt8zRknLMTye9fR5DjqWV4iVWsm001p6p9Wux",
    "OHyHE0cveElKPNz827tblt23+R+jNfNfhD/lIlaf8D/9NDV4f/w1P8UP+hn/APKfa/8Axquas/i/4usPiKnjuDVvL8VJnbf/",
    "AGaE4zD5P+rKbP8AVnb933681vxfmVHP8orZfhU1Oakk5WS1jKOtm3u+x7mQ5fVyvHRxNZpxVtr33T6pdj9jK/LH9tb/AJOa",
    "8Zf9uX/pFBR/w2t8Z/8Aocv/ACl2X/xmvK/G3jbWviL4nvfEPiG9/tDWLzZ59z5SRb9iKi/KiqowqqOB29a/n7hDhDH8P4+e",
    "KxU4OLg4+65N3covrFaaH6dm+b0MfQVKkmmnfW3Zro33P//Z",
  ].join(""),
  "base64",
);
const BOOT_MARK = 7;

function tlv(type, value) {
  const head = Buffer.alloc(3);
  head[0] = type;
  head.writeUInt16LE(value.length, 1);
  return Buffer.concat([head, value]);
}

/** META_DEBUG_LOG 0x71: u32 first, u8 count, u8 length + text per line, u8 boot mark. */
function debugLog(first, line) {
  const head = Buffer.alloc(5);
  head.writeUInt32LE(first, 0);
  head[4] = 1;
  const text = Buffer.from(line, "utf8");
  return Buffer.concat([head, Buffer.from([text.length]), text, Buffer.from([BOOT_MARK])]);
}

function vendorFrame(id) {
  const meta = tlv(0x71, debugLog(id, `smoke line ${id}`));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x30564e44, 0);
  header.writeUInt32LE(id, 4);
  header.writeUInt32LE(meta.length, 8);
  header.writeUInt32LE(JPEG.length, 12);
  return Buffer.concat([header, meta, JPEG]);
}

function startBoard() {
  return new Promise((resolve) => {
    const sockets = new Set();
    let accepted = 0;
    const server = net.createServer((socket) => {
      accepted += 1;
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on("error", () => undefined);
      socket.resume();
      let id = 1;
      const timer = setInterval(() => socket.write(vendorFrame(id++)), 66);
      socket.on("close", () => {
        clearInterval(timer);
        sockets.delete(socket);
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        accepted: () => accepted,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      }),
    );
  });
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A minimal Chrome DevTools Protocol client.

async function cdpJson(port, route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  return response.json();
}

async function cdpConnect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.onmessage = (message) => {
    const data = JSON.parse(String(message.data));
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data.result ?? { error: data.error });
      pending.delete(data.id);
    } else if (data.method) {
      for (const listener of listeners.get(data.method) ?? []) listener(data.params);
    }
  };
  // A page that closes or crashes never answers: its requests settle as null.
  socket.onclose = () => {
    for (const settle of pending.values()) settle(null);
    pending.clear();
  };
  return {
    /** The reply's result, or null when no reply came within `timeoutMs`. */
    send(method, params = {}, timeoutMs = 10_000) {
      nextId += 1;
      const id = nextId;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(null);
        }, timeoutMs);
        pending.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch {
          pending.get(id)?.(null);
          pending.delete(id);
        }
      });
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    close: () => socket.close(),
  };
}

// What the window shows, read from the page.
const PAGE_STATE = `(() => {
  const text = document.body ? document.body.innerText : "";
  return {
    title: document.title,
    rendered: (document.querySelector("#root")?.childElementCount ?? 0) > 0,
    connected: /\\bConnected\\b/.test(text),
    resolution: text.includes("64\\u00d748"),
    terminal: /smoke line \\d+/.test(text),
    interLoaded: [...document.fonts].some((f) => f.family.includes("Inter") && f.status === "loaded"),
    bridge: typeof window.neuro === "object" && typeof window.neuro.openTcp === "function",
    nodeInRenderer: typeof require !== "undefined" || typeof process !== "undefined",
    version: document.querySelector(".statusbar-version")?.textContent ?? null,
  };
})()`;

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  else child.kill("SIGKILL");
}

/** Runs the app at `exe` against the fake board; true when every check passed. */
async function exercise(exe, extraArgs = [], label = "the app") {
  const board = await startBoard();
  const cdpPort = await freePort();
  // An AppImage is mounted with FUSE, as when a user opens it; APPIMAGE_EXTRACT_AND_RUN=1 in
  // the environment extracts it instead, for machines without FUSE.
  const env = { ...process.env, NEURO_STUDIO_NO_UPDATE_CHECK: "1" };
  const [command, ...prefix] = intel ? ["arch", "-x86_64", exe] : [exe];
  const child = spawn(
    command,
    [
      ...prefix,
      "--network-only",
      "--wifi-host=127.0.0.1",
      `--wifi-port=${board.port}`,
      `--remote-debugging-port=${cdpPort}`,
      ...extraArgs,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));
  child.on("error", (error) => (exited = { error: error.message }));

  const page = await until(
    async () => {
      if (exited) return true;
      try {
        return (await cdpJson(cdpPort, "/json/list")).find((target) => target.type === "page");
      } catch {
        return null;
      }
    },
    90_000,
    500,
  );
  if (!page || exited) {
    check(
      `${label} starts and opens its window`,
      false,
      `${JSON.stringify(exited)}\n${tail(output)}`,
    );
    stopProcess(child);
    board.close();
    return false;
  }
  check(`${label} starts and opens its window`, true);

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  const problems = [];
  cdp.on("Runtime.exceptionThrown", (e) =>
    problems.push(
      `exception: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`,
    ),
  );
  cdp.on("Runtime.consoleAPICalled", (e) => {
    if (e.type === "error" || e.type === "assert") {
      problems.push(`console.${e.type}: ${e.args.map((a) => a.value ?? a.description).join(" ")}`);
    }
  });
  cdp.on("Log.entryAdded", (e) => {
    if (e.entry.level === "error") problems.push(`${e.entry.source}: ${e.entry.text}`);
  });
  cdp.on("Console.messageAdded", (e) => {
    if (e.message.level === "error") problems.push(`console: ${e.message.text}`);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Console.enable");

  const read = async () =>
    (await cdp.send("Runtime.evaluate", { expression: PAGE_STATE, returnByValue: true }))?.result
      ?.value;
  const state =
    (await until(
      async () => {
        const s = await read();
        return s && s.connected && s.resolution && s.terminal ? s : null;
      },
      45_000,
      500,
    )) ?? (await read());

  check("the window is Neuro Studio's", state?.title === "Neuro Studio", state?.title);
  check("the interface renders", state?.rendered);
  check(
    "the renderer has the preload bridge and no Node.js",
    state?.bridge && !state?.nodeInRenderer,
  );
  check(
    "it connects to the board",
    state?.connected && board.accepted() > 0,
    `connections: ${board.accepted()}`,
  );
  check("it shows the stream's resolution, 64x48", state?.resolution);
  check("the Terminal prints the board's numbered lines", state?.terminal);
  check("the bundled Inter font loads", state?.interLoaded);
  check("the status bar shows this version", state?.version === `v${pkg.version}`, state?.version);
  await sleep(1000);
  check(
    "no console errors, exceptions or CSP violations",
    problems.length === 0,
    problems.join(" | "),
  );
  check(`${label} is still running`, !exited, JSON.stringify(exited));

  // Closing the last window quits, except on macOS, where apps stay open without windows.
  // The page may close before it can answer, so the reply is not waited for.
  void cdp.send("Runtime.evaluate", { expression: "window.close()" }, 2000);
  await sleep(500);
  cdp.close();
  const quit = await until(() => exited, 15_000);
  if (process.platform === "darwin") {
    if (!quit) child.kill("SIGTERM");
    check(`${label} quits`, await until(() => exited, 15_000), JSON.stringify(exited));
  } else {
    check(`${label} quits when its window closes`, quit, JSON.stringify(exited));
  }
  stopProcess(child);
  board.close();
  return true;
}

// Installing and uninstalling, per platform.

function windowsUninstallEntries() {
  const r = run("reg", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "/s",
    "/f",
    "Neuro Studio",
    "/d",
  ]);
  return r.out.split(/\r?\n/).filter((line) => /DisplayName\s+REG_SZ\s+Neuro Studio/.test(line));
}

async function installWindows() {
  const setup = path.join(release, "Neuro-Studio-Setup.exe");
  if (!check("the installer was built", fs.existsSync(setup), setup)) return null;
  if (
    !check(
      "no Neuro Studio is installed for this user already",
      windowsUninstallEntries().length === 0,
    )
  ) {
    return null;
  }
  const dir = path.join(os.tmpdir(), `neuro-studio-smoke-${process.pid}`, "Neuro Studio");
  const exe = path.join(dir, "Neuro Studio.exe");
  // NSIS takes the folder as the last argument, unquoted even with spaces.
  const r = spawnSync(setup, ["/S", `/D=${dir}`], { windowsVerbatimArguments: true });
  const installed = await until(() => fs.existsSync(exe), 60_000, 500);
  check("the installer installs silently", r.status === 0 && installed, `exit ${r.status}, ${exe}`);
  const startMenu = path.join(
    process.env.APPDATA ?? "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Neuro Studio.lnk",
  );
  check("it adds a Start menu shortcut", fs.existsSync(startMenu), startMenu);
  check("it is listed in Apps & features", windowsUninstallEntries().length === 1);
  return {
    exe: installed ? exe : null,
    async uninstall() {
      spawnSync(path.join(dir, "Uninstall Neuro Studio.exe"), ["/S"]);
      // The uninstaller copies itself to %TEMP% and returns at once. It deletes the files
      // first, then the shortcuts, and the Apps & features entry last.
      await until(
        () =>
          !fs.existsSync(exe) &&
          !fs.existsSync(startMenu) &&
          windowsUninstallEntries().length === 0,
        90_000,
        500,
      );
      check("the uninstaller removes the app", !fs.existsSync(exe));
      check("and its Start menu shortcut", !fs.existsSync(startMenu));
      check("and its Apps & features entry", windowsUninstallEntries().length === 0);
    },
  };
}

async function installMac() {
  const dmg = path.join(release, "Neuro-Studio.dmg");
  if (!check("the disk image was built", fs.existsSync(dmg), dmg)) return null;
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "ns-dmg-"));
  const attach = run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
  if (!check("the disk image mounts", attach.status === 0, tail(attach.out, 3))) return null;
  const inImage = path.join(mount, "Neuro Studio.app");
  check(
    "it holds the app and a link to Applications",
    fs.existsSync(inImage) && fs.existsSync(path.join(mount, "Applications")),
  );
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ns-app-"));
  const app = path.join(dest, "Neuro Studio.app");
  run("ditto", [inImage, app]);
  run("hdiutil", ["detach", mount]);
  const exe = path.join(app, "Contents", "MacOS", "Neuro Studio");

  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  check("its code signature is valid", verify.status === 0, tail(verify.out, 3));
  const details = run("codesign", ["-dv", app]).out;
  note(
    "signature",
    /Authority=Developer ID Application/.test(details)
      ? "Developer ID"
      : /Signature=adhoc/.test(details)
        ? "ad hoc"
        : tail(details, 4),
  );
  const archs = run("lipo", ["-archs", exe]).out;
  check(
    "it runs natively on Apple Silicon and Intel",
    /arm64/.test(archs) && /x86_64/.test(archs),
    archs,
  );
  const usbNode = path.join(
    app,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "usb",
    "prebuilds",
    "darwin-x64+arm64",
  );
  const usbBinary = fs.existsSync(usbNode)
    ? fs.readdirSync(usbNode).find((name) => name.endsWith(".node"))
    : null;
  const usbArchs = usbBinary
    ? run("lipo", ["-archs", path.join(usbNode, usbBinary)]).out
    : "missing";
  check(
    "the USB module is unpacked for both architectures",
    /arm64/.test(usbArchs) && /x86_64/.test(usbArchs),
    usbArchs,
  );
  const plist = path.join(app, "Contents", "Info.plist");
  const lan = run("plutil", ["-extract", "NSLocalNetworkUsageDescription", "raw", plist]);
  check("it explains its local network use", lan.status === 0 && lan.out.length > 0, lan.out);
  // Electron's template declares two BLE usage keys; the app's own wording replaces Electron's.
  for (const key of [
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
  ]) {
    const text = run("plutil", ["-extract", key, "raw", plist]);
    check(
      "its BLE usage text is its own",
      text.out === "Neuro Studio does not use BLE.",
      `${key}: ${text.out}`,
    );
  }
  const gatekeeper = run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  note(
    "Gatekeeper",
    gatekeeper.status === 0
      ? `accepted: ${tail(gatekeeper.out, 2)}`
      : `not accepted (expected without notarization): ${tail(gatekeeper.out, 2)}`,
  );
  return {
    exe,
    async uninstall() {
      fs.rmSync(dest, { recursive: true, force: true });
      check("removing the app leaves nothing in its folder", !fs.existsSync(app));
    },
  };
}

async function installLinux() {
  const deb = path.join(release, "neuro-studio_amd64.deb");
  if (!check("the .deb was built", fs.existsSync(deb), deb)) return null;
  const install = run("sudo", ["apt-get", "install", "-y", deb]);
  const exe = "/opt/Neuro Studio/neuro-studio";
  check(
    "apt installs it with its dependencies",
    install.status === 0 && fs.existsSync(exe),
    tail(install.out, 4),
  );
  check("it adds a menu entry", fs.existsSync("/usr/share/applications/neuro-studio.desktop"));
  // A full desktop has every library already; a minimal system shows whether Depends is complete.
  const missing = fs.existsSync(exe)
    ? run("ldd", [exe])
        .out.split(/\r?\n/)
        .filter((line) => line.includes("not found"))
    : ["the app is not installed"];
  check("every library it loads is installed", missing.length === 0, missing.join("; "));
  const rule = "/lib/udev/rules.d/60-neuro-n6.rules";
  const shipped = fs.readFileSync(
    path.join(root, "packaging", "linux", "60-neuro-n6.rules"),
    "utf8",
  );
  check(
    "it installs the board's udev rule",
    fs.existsSync(rule) && fs.readFileSync(rule, "utf8") === shipped,
  );
  check("the package owns the rule", run("dpkg", ["-S", rule]).out.startsWith("neuro-studio:"));
  const userns =
    run("cat", ["/proc/sys/kernel/apparmor_restrict_unprivileged_userns"]).out || "absent";
  note("unprivileged user namespaces restricted by AppArmor", userns);
  note(
    "AppArmor profile",
    fs.existsSync("/etc/apparmor.d/neuro-studio") ? "installed" : "not installed",
  );
  return {
    exe: fs.existsSync(exe) ? exe : null,
    async uninstall() {
      const remove = run("sudo", ["apt-get", "remove", "-y", "neuro-studio"]);
      check("apt removes it", remove.status === 0 && !fs.existsSync(exe), tail(remove.out, 3));
      check("and the udev rule with it", !fs.existsSync(rule));
    },
  };
}

function unpackedExe() {
  if (process.platform === "win32") return path.join(release, "win-unpacked", "Neuro Studio.exe");
  if (process.platform === "darwin") {
    const dir = ["mac-universal", "mac-arm64", "mac"].find((d) =>
      fs.existsSync(path.join(release, d)),
    );
    return path.join(
      release,
      dir ?? "mac-universal",
      "Neuro Studio.app",
      "Contents",
      "MacOS",
      "Neuro Studio",
    );
  }
  return path.join(release, "linux-unpacked", "neuro-studio");
}

async function main() {
  console.log(
    `Neuro Studio ${pkg.version} smoke test: ${process.platform}, ${mode}${intel ? ", Intel under Rosetta" : ""}`,
  );
  if (mode === "unpacked") {
    const exe = unpackedExe();
    if (check("the unpacked app was built", fs.existsSync(exe), exe)) await exercise(exe);
  } else if (mode === "appimage") {
    const appImage = path.join(release, "Neuro-Studio-x86_64.AppImage");
    if (check("the AppImage was built", fs.existsSync(appImage), appImage)) {
      fs.chmodSync(appImage, 0o755);
      const fuse2 = run("sh", ["-c", "ldconfig -p | grep -c 'libfuse\\.so\\.2' || true"]).out;
      note(
        "libfuse2 on this system",
        fuse2 === "0" ? "absent, as on a stock Ubuntu desktop" : `present (${fuse2})`,
      );
      // Where unprivileged user namespaces are restricted, as on Ubuntu 24.04, Electron's
      // sandbox cannot start inside an AppImage. Record whether --no-sandbox is needed.
      if (!(await exercise(appImage, [], "the AppImage"))) {
        note("AppImage sandbox", "did not start with the sandbox; retrying with --no-sandbox");
        await exercise(appImage, ["--no-sandbox"], "the AppImage with --no-sandbox");
      }
    }
  } else {
    const installer =
      process.platform === "win32"
        ? installWindows
        : process.platform === "darwin"
          ? installMac
          : installLinux;
    const installed = await installer();
    if (installed?.exe) await exercise(installed.exe, [], "the installed app");
    if (installed) await installed.uninstall();
  }

  const failed = results.filter((r) => r.ok === false);
  console.log(failed.length ? `\n${failed.length} check(s) failed` : "\nall checks passed");
  if (reportPath) {
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          platform: process.platform,
          arch: intel ? "x64 (Rosetta)" : process.arch,
          mode,
          version: pkg.version,
          results,
        },
        null,
        2,
      ),
    );
  }
  process.exitCode = failed.length ? 1 : 0;
}

await main();
