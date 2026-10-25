const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } = require("electron");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const {
  DeviceSession,
  listUsbBoards,
  listUsbBoardsWithSerials,
  setUsbAllowed,
  DEVICE_IDENTITIES,
  WIFI_DEFAULT_HOST,
  WIFI_DEFAULT_PORT,
  ETHERNET_DEFAULT_HOST,
  ETHERNET_DEFAULT_PORT,
} = require("./device/session.cjs");
const { parseLaunchOptions, rendererArguments } = require("./launch.cjs");
const { FLASH_BASE, FLASH_END, crc32 } = require("./dfu/protocol.cjs");
const {
  enumeratePorts,
  imagePlacementError,
  isAppPort,
  isBootloaderFamily,
  lingeringFsblPorts,
  runFlash,
} = require("./dfu/session.cjs");
const { Recorder } = require("./recorder.cjs");
const { checkForUpdates } = require("./updater.cjs");

const launch = parseLaunchOptions(process.argv, process.env);
if (launch.networkOnly) setUsbAllowed(false);

const BOOTLOADER_OFF =
  "The bootloader tool needs USB, which is off: Neuro Studio was started network-only.";

const devServerUrl = app.isPackaged ? null : process.env.VITE_DEV_SERVER_URL || null;

// A development run keeps its own settings folder and so its own single-instance lock.
if (!app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "neuro-studio-dev"));
}

/** The renderer's own URL. Nothing else may be navigated to. */
const appUrl = devServerUrl
  ? new URL(devServerUrl)
  : pathToFileURL(path.join(__dirname, "../dist/index.html"));

function isAppUrl(url) {
  try {
    const target = new URL(url);
    if (devServerUrl) return target.origin === appUrl.origin;
    return target.protocol === appUrl.protocol && target.pathname === appUrl.pathname;
  } catch {
    return false;
  }
}

/** Minimum time between crash reloads, so a renderer that dies at startup does not loop. */
const CRASH_RELOAD_INTERVAL_MS = 10_000;

const RECORDER_QUIT_TIMEOUT_MS = 5_000;

const sessions = new Map(); // webContents.id -> { session, recorder, generation }

function sessionFor(event) {
  return sessions.get(event.sender.id) || null;
}

const finishingRecorders = new Set();

function finishRecorder(recorder) {
  const done = recorder.stop().finally(() => finishingRecorders.delete(done));
  finishingRecorders.add(done);
  return done;
}

function resetWindowState(contentsId) {
  const entry = sessions.get(contentsId);
  if (!entry) return;
  entry.generation += 1;
  entry.session.frameSink = null;
  if (entry.recorder) {
    void finishRecorder(entry.recorder);
    entry.recorder = null;
  }
  entry.session.setAutoRecover(true);
  entry.session.close({ status: false }).catch(() => undefined);
}

function attachSession(window) {
  const contentsId = window.webContents.id;
  const session = new DeviceSession();

  session.on("event", (message) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send("device:event", message);
  });

  sessions.set(contentsId, { session, recorder: null, generation: 0 });
  // A window opened mid-flash starts parked, or it would grab the board in its bootloader.
  if (transportsParked()) void session.suspend();

  // Every page load after the first is a reload; the new page's IPC arrives after this event.
  let loads = 0;
  window.webContents.on("did-navigate", () => {
    loads += 1;
    if (loads > 1) resetWindowState(contentsId);
  });

  let lastCrashAt = 0;
  window.webContents.on("render-process-gone", (_event, details) => {
    resetWindowState(contentsId);
    if (details.reason === "clean-exit" || window.isDestroyed()) return;
    const now = Date.now();
    if (now - lastCrashAt > CRASH_RELOAD_INTERVAL_MS) window.webContents.reload();
    lastCrashAt = now;
  });

  // Closing the last window quits, which would abort the write.
  let closePrompt = null;
  window.on("close", (event) => {
    if (!activeFlash || activeFlash.contentsId !== contentsId) return;
    event.preventDefault();
    if (closePrompt) return;
    // Not showMessageBoxSync: blocking the main process would stall the flash.
    closePrompt = dialog
      .showMessageBox(window, {
        type: "warning",
        buttons: ["Keep flashing", "Close anyway"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: "A flash is in progress.",
        detail:
          "Closing now can abort the write and leave the board unable to boot. " +
          "Close only if the flash has stopped responding.",
      })
      .then(({ response }) => {
        closePrompt = null;
        if (response === 1 && !window.isDestroyed()) window.destroy();
      });
  });

  window.on("closed", () => {
    const entry = sessions.get(contentsId);
    sessions.delete(contentsId);
    dfuChoices.delete(contentsId);
    if (!entry) return;
    if (entry.recorder) void finishRecorder(entry.recorder);
    void entry.session.stop();
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    // Smallest size the stage and sidebar lay out well at.
    minWidth: 1280,
    minHeight: 720,
    title: "Neuro Studio",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#17181b",
      symbolColor: "#a1a1aa",
      height: 40,
    },
    backgroundColor: "#101113",
    // nativeImage decodes .ico only on Windows.
    icon: path.join(__dirname, devServerUrl ? "../public/icon.png" : "../dist/icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      navigateOnDragDrop: false,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: rendererArguments(launch),
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Only the app's own page may load: anything else would get the window.neuro bridge.
  const blockForeignNavigation = (event) => {
    if (!isAppUrl(event.url)) event.preventDefault();
  };
  window.webContents.on("will-navigate", blockForeignNavigation);
  window.webContents.on("will-redirect", blockForeignNavigation);

  attachSession(window);

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  return window;
}

// Device IPC

ipcMain.handle("device:open", async (event, options) => {
  const entry = sessionFor(event);
  if (!entry) return;
  await entry.session.open(options || {});
});

ipcMain.handle("device:open-tcp", async (event, options) => {
  const entry = sessionFor(event);
  if (!entry) return;
  await entry.session.openTcp(options || {});
});

ipcMain.handle("device:switch-transport", async (event, mode, options) => {
  const entry = sessionFor(event);
  if (!entry) return;
  await entry.session.switchTransport(mode, options || {});
});

ipcMain.handle("device:close", async (event) => {
  const entry = sessionFor(event);
  if (!entry) return;
  await entry.session.close();
});

ipcMain.on("device:write", (event, data) => {
  const entry = sessionFor(event);
  if (!entry || !data) return;
  entry.session.write(Buffer.from(data));
});

ipcMain.on("device:set-link-key", (event, host, key) => {
  const entry = sessionFor(event);
  if (!entry) return;
  entry.session.setLinkKey(host, key);
});

ipcMain.on("device:set-auto-recover", (event, on) => {
  const entry = sessionFor(event);
  if (!entry) return;
  entry.session.setAutoRecover(on);
});

ipcMain.handle("device:list-boards", async (event) => {
  if (launch.networkOnly) return [];
  // inUse is relative to the asking window: its own board is not in use.
  const entry = sessionFor(event);
  const self = entry ? entry.session : null;
  try {
    // Reading serials opens each board; not while one is being flashed.
    return activeFlash ? listUsbBoards(self) : await listUsbBoardsWithSerials(self);
  } catch {
    return [];
  }
});

ipcMain.handle("device:defaults", () => ({
  identities: DEVICE_IDENTITIES,
  wifi: { host: launch.wifiHost || WIFI_DEFAULT_HOST, port: launch.wifiPort || WIFI_DEFAULT_PORT },
  ethernet: { host: ETHERNET_DEFAULT_HOST, port: ETHERNET_DEFAULT_PORT },
}));

// File IPC: snapshot, recording, terminal log

function ownerWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.handle("file:save-snapshot", async (event, suggestedName, bytes) => {
  const window = ownerWindow(event);
  const result = await dialog.showSaveDialog(window, {
    defaultPath: suggestedName,
    filters: [{ name: "JPEG", extensions: ["jpg", "jpeg"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    await fsp.writeFile(result.filePath, Buffer.from(bytes));
    return { canceled: false, path: result.filePath };
  } catch (error) {
    return { canceled: false, error: String((error && error.message) || error) };
  }
});

ipcMain.handle("file:save-log", async (event, suggestedName, text) => {
  const window = ownerWindow(event);
  const result = await dialog.showSaveDialog(window, {
    defaultPath: suggestedName,
    filters: [{ name: "Text", extensions: ["txt", "log"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    await fsp.writeFile(result.filePath, String(text), "utf8");
    return { canceled: false, path: result.filePath };
  } catch (error) {
    return { canceled: false, error: String((error && error.message) || error) };
  }
});

ipcMain.handle("recorder:start", async (event, suggestedName) => {
  const entry = sessionFor(event);
  if (!entry) return { canceled: true };
  const generation = entry.generation;
  const window = ownerWindow(event);
  const result = await dialog.showSaveDialog(window, {
    defaultPath: suggestedName,
    filters: [{ name: "MJPEG", extensions: ["mjpeg", "mjpg"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const sender = event.sender;
  let recorder;
  try {
    // The file is truncated: picking an existing file means replace it.
    recorder = await Recorder.open(result.filePath, {
      onError: (error) => {
        if (sender.isDestroyed()) return;
        sender.send("device:event", {
          t: "recorder_error",
          text: String((error && error.message) || error),
        });
      },
    });
  } catch (error) {
    return { canceled: false, error: String((error && error.message) || error) };
  }
  // The page reloaded or the window closed while the dialog was open.
  if (sessions.get(sender.id) !== entry || entry.generation !== generation) {
    void finishRecorder(recorder);
    return { canceled: true };
  }
  if (entry.recorder) void finishRecorder(entry.recorder);
  entry.recorder = recorder;
  // Fed from ingest, so every frame the board sent is kept, not only the ones shown.
  entry.session.frameSink = (jpeg) => recorder.append(jpeg);
  return { canceled: false, path: result.filePath };
});

ipcMain.handle("recorder:stop", async (event) => {
  const entry = sessionFor(event);
  if (!entry || !entry.recorder) return { path: null };
  const recorder = entry.recorder;
  entry.recorder = null;
  entry.session.frameSink = null;
  return finishRecorder(recorder);
});

// Bootloader IPC

/** The file and ports each window's bootloader dialog was given; it may flash nothing else. */
const dfuChoices = new Map(); // webContents.id -> { file: { path, data, crc } | null, ports: Set }

/** The one flash in progress: a second would fight it for the port. */
let activeFlash = null; // { contentsId, parked, controller, critical, lastActivityAt, log, view }

/** Set while the transports stay parked after a failed flash. */
let fsblHold = null;

const FLASH_BYTES = FLASH_END - FLASH_BASE + 1;
const PROGRESS_INTERVAL_MS = 50;
/** Mid-write silence after which the flash may be stopped. Matches src/device/dfu.ts. */
const DFU_STALL_MS = 30000;
const FLASH_LOG_LIMIT = 5000;
/** After a failed flash: the wait for a board still entering the FSBL, and the poll period. */
const FSBL_SETTLE_MS = 3000;
const FSBL_POLL_MS = 1000;

const errorMessage = (error) => String((error && error.message) || error);

function dfuChoicesFor(event) {
  let choices = dfuChoices.get(event.sender.id);
  if (!choices) {
    choices = { file: null, ports: new Set() };
    dfuChoices.set(event.sender.id, choices);
  }
  return choices;
}

/** Parks every window's transport: an idle one would claim the board as it enters the FSBL. */
function suspendTransports() {
  return Promise.all([...sessions.values()].map((entry) => entry.session.suspend()));
}

function resumeTransports() {
  return Promise.all([...sessions.values()].map((entry) => entry.session.resume()));
}

function transportsParked() {
  return Boolean((activeFlash && activeFlash.parked) || fsblHold);
}

async function restartTransports(log) {
  log("restarting the video stream…");
  try {
    await resumeTransports();
    log("video stream restarted.");
  } catch (error) {
    log(
      `could not restart the stream: ${errorMessage(error)}. ` +
        "Reconnect from the status bar if the view stays blank.",
    );
  }
}

/**
 * Keeps the transports parked while the board sits in its FSBL, whose ID the video sessions
 * match, until it resets or is unplugged or a new flash takes over.
 */
async function holdWhileInFsbl(trace, log) {
  const hold = {};
  fsblHold = hold;
  const settleUntil = Date.now() + FSBL_SETTLE_MS;
  let told = false;
  for (;;) {
    let lingering = [];
    try {
      lingering = lingeringFsblPorts(await enumeratePorts(), trace);
    } catch {
      // Nothing to go on, so resume as usual.
    }
    if (fsblHold !== hold) return;
    if (!lingering.length && Date.now() >= settleUntil) break;
    if (lingering.length && !told) {
      told = true;
      log(
        `the board is still in its bootloader (${lingering.map((p) => p.name).join(", ")}); ` +
          "the video stream stays stopped until it resets or is unplugged.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, FSBL_POLL_MS));
    if (fsblHold !== hold) return;
  }
  fsblHold = null;
  await restartTransports(log);
}

ipcMain.handle("bootloader:list-ports", async (event) => {
  if (launch.networkOnly) return [];
  let ports = [];
  try {
    ports = await enumeratePorts();
  } catch {
    // Auto-detect still works, and its log says what it could see.
  }
  dfuChoicesFor(event).ports = new Set(ports.map((p) => p.name));
  return ports.map((p) => ({
    ...p,
    isApp: isAppPort(p),
    isBootloaderFamily: isBootloaderFamily(p),
  }));
});

ipcMain.handle("bootloader:pick-file", async (event) => {
  const result = await dialog.showOpenDialog(ownerWindow(event), {
    properties: ["openFile"],
    filters: [{ name: "Firmware", extensions: ["bin"] }],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const choices = dfuChoicesFor(event);
  const filePath = result.filePaths[0];
  choices.file = null;
  try {
    if ((await fsp.stat(filePath)).size > FLASH_BYTES) {
      return { canceled: false, error: "That file is larger than the whole flash." };
    }
    const data = await fsp.readFile(filePath);
    if (!data.length) return { canceled: false, error: "That file is empty." };
    const crc = crc32(data);
    choices.file = { path: filePath, data, crc };
    return {
      canceled: false,
      path: filePath,
      name: path.basename(filePath),
      size: data.length,
      crc,
    };
  } catch (error) {
    return { canceled: false, error: `Could not read the file: ${errorMessage(error)}` };
  }
});

ipcMain.handle("bootloader:flash", async (event, request) => {
  if (launch.networkOnly) return { ok: false, message: BOOTLOADER_OFF };
  if (activeFlash) return { ok: false, message: "Another flash is already running." };

  const choices = dfuChoices.get(event.sender.id);
  const file = choices ? choices.file : null;
  const { path: filePath, offset, port, confirmFsbl } = request || {};
  if (!file || filePath !== file.path) {
    return { ok: false, message: "Choose the .bin again: it was not picked in this window." };
  }
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    FLASH_BASE + offset + file.data.length - 1 > FLASH_END
  ) {
    return { ok: false, message: "This image does not fit at that address." };
  }
  const image = { label: path.basename(file.path), data: file.data, offset };
  // The dialog asks before writing into the FSBL region, but must not be the only guard.
  const allowFsbl = confirmFsbl === true;
  const placement = imagePlacementError(image, { allowFsbl });
  if (placement) return { ok: false, message: placement };
  if (port !== null && !(typeof port === "string" && choices.ports.has(port))) {
    return { ok: false, message: "Unknown port. Rescan the ports and pick again." };
  }

  const sender = event.sender;
  const flash = {
    contentsId: sender.id,
    parked: true,
    controller: new AbortController(),
    critical: false,
    lastActivityAt: Date.now(),
    log: null,
    view: {
      file: { path: file.path, name: image.label, size: file.data.length, crc: file.crc },
      offset,
      port,
      log: [],
      progress: null,
      startedAt: Date.now(),
    },
  };
  const send = (message) => {
    flash.lastActivityAt = Date.now();
    if (!sender.isDestroyed()) sender.send("bootloader:event", message);
  };
  const log = (text) => {
    const lines = flash.view.log;
    lines.push(text);
    if (lines.length > FLASH_LOG_LIMIT) lines.splice(0, lines.length - FLASH_LOG_LIMIT);
    send({ t: "log", text });
  };
  flash.log = log;
  let progressSentAt = 0;
  const onProgress = (progress) => {
    flash.view.progress = progress;
    flash.lastActivityAt = Date.now();
    const now = Date.now();
    const edge = progress.written === 0 || progress.written === progress.total;
    if (!edge && now - progressSentAt < PROGRESS_INTERVAL_MS) return;
    progressSentAt = now;
    send({ t: "progress", ...progress });
  };
  const onStage = (critical) => {
    flash.critical = critical;
    send({ t: "stage", critical });
  };
  // A reload mid-flash would drop the dialog and its "do not unplug" warning.
  const blockReload = (keyEvent, input) => {
    if (input.type !== "keyDown") return;
    const key = String(input.key).toLowerCase();
    if (key === "f5" || ((input.control || input.meta) && key === "r")) keyEvent.preventDefault();
  };
  const onDestroyed = () => flash.controller.abort();

  fsblHold = null; // this flash has the transports now
  activeFlash = flash;
  sender.on("before-input-event", blockReload);
  sender.once("destroyed", onDestroyed);
  let result = { ok: false, message: "The flash did not run." };
  let trace = {};
  try {
    // The board re-enumerates twice, and auto-recovery would fight the bootloader for it.
    log("stopping the video stream to release the USB device…");
    await suspendTransports().catch((error) =>
      log(`could not stop the video stream: ${errorMessage(error)}`),
    );

    const outcome = await runFlash({
      images: [image],
      preferredPort: port,
      allowFsbl,
      signal: flash.controller.signal,
      log,
      onProgress,
      onStage,
    });
    result = { ok: outcome.ok, message: outcome.message };
    trace = { bootPort: outcome.bootPort, portsBefore: outcome.portsBefore };
    log(result.ok ? `Done: ${result.message}` : `Failed: ${result.message}`);
  } finally {
    sender.removeListener("destroyed", onDestroyed);
    if (!sender.isDestroyed()) sender.removeListener("before-input-event", blockReload);
    if (result.ok) {
      // Cleared in the same tick as the resume snapshot, so a window opened meanwhile connects.
      flash.parked = false;
      await restartTransports(log);
    } else {
      // Sets fsblHold before activeFlash clears, so no window slips through.
      void holdWhileInFsbl(trace, log);
    }
    activeFlash = null;
    send({ t: "done", ...result });
  }
  return result;
});

// This window's flash, for a dialog opened after a reload. null when none.
ipcMain.handle("bootloader:state", (event) => {
  const flash = activeFlash;
  if (!flash || flash.contentsId !== event.sender.id) return null;
  return {
    ...flash.view,
    log: [...flash.view.log],
    critical: flash.critical,
    lastActivityAt: flash.lastActivityAt,
  };
});

ipcMain.handle("bootloader:cancel", (event, force) => {
  const flash = activeFlash;
  if (!flash || flash.contentsId !== event.sender.id) {
    return { ok: false, message: "No flash is running in this window." };
  }
  if (flash.critical && (force !== true || Date.now() - flash.lastActivityAt < DFU_STALL_MS)) {
    return {
      ok: false,
      message: "The board is being written. Stopping now would leave it half-flashed.",
    };
  }
  if (!flash.controller.signal.aborted) {
    flash.log(flash.critical ? "stopping the stalled flash…" : "cancelling…");
    flash.controller.abort();
  }
  return { ok: true, message: "Stopping." };
});

// Window IPC

ipcMain.handle("window:new", () => {
  createWindow();
});

/**
 * Packaged builds drop the default menu, whose Reload and DevTools shortcuts would swap out
 * the renderer. macOS keeps the menus that carry Quit, Close Window and copy/paste.
 */
function installMenu() {
  if (!app.isPackaged) return;
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "fileMenu" },
        { role: "editMenu" },
        { role: "windowMenu" },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

function focusExistingWindow() {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// One process owns every window, so a flash in any window parks all their transports.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) focusExistingWindow();
  });

  app.whenReady().then(() => {
    // Must match build.appId for the taskbar to group windows under the installed shortcut.
    if (process.platform === "win32") app.setAppUserModelId("com.ohmlab.neurostudio");

    // Packaged builds take their icon from the bundle.
    if (process.platform === "darwin" && !app.isPackaged && app.dock) {
      const icon = nativeImage.createFromPath(path.join(__dirname, "../buildResources/icon.png"));
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    }

    installMenu();
    const firstWindow = createWindow();
    // After the window has settled, so the dialog does not open over a blank page.
    setTimeout(() => void checkForUpdates(firstWindow).catch(() => undefined), 5000);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Closing a window only starts flushing its recording; quitting waits, up to the timeout.
let recordersFlushedForQuit = false;
app.on("will-quit", (event) => {
  if (recordersFlushedForQuit || finishingRecorders.size === 0) return;
  event.preventDefault();
  recordersFlushedForQuit = true;
  const timeout = new Promise((resolve) => setTimeout(resolve, RECORDER_QUIT_TIMEOUT_MS));
  void Promise.race([Promise.all([...finishingRecorders]), timeout]).then(() => app.quit());
});
