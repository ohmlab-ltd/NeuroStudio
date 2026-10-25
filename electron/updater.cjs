// Once per launch, offers the release page when GitHub has a newer release. Nothing is
// downloaded or installed. NEURO_STUDIO_NO_UPDATE_CHECK=1 turns it off.

const { app, dialog, net, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { findUpdate, repoFromPackage } = require("./update-check.cjs");

const REQUEST_TIMEOUT_MS = 10_000;

const stateFile = () => path.join(app.getPath("userData"), "update-check.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
  } catch {
    // Best effort: the version is offered again next launch.
  }
}

async function fetchLatest(url) {
  const response = await net.fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `NeuroStudio/${app.getVersion()}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** @param {import("electron").BrowserWindow} window */
async function checkForUpdates(window) {
  if (!app.isPackaged || process.env.NEURO_STUDIO_NO_UPDATE_CHECK) return;
  const update = await findUpdate({
    repo: repoFromPackage(require("../package.json")),
    currentVersion: app.getVersion(),
    skippedVersion: loadState().skippedVersion ?? null,
    fetchLatest,
  });
  if (!update || window.isDestroyed()) return;

  const { response } = await dialog.showMessageBox(window, {
    type: "info",
    title: "Neuro Studio update",
    message: `Neuro Studio ${update.version} is available`,
    detail:
      `You have ${app.getVersion()}. Download opens the release page on GitHub; ` +
      "run the new installer from there to update.",
    buttons: ["Download", "Skip this version", "Later"],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) void shell.openExternal(update.url);
  else if (response === 1) saveState({ skippedVersion: update.tag });
}

module.exports = { checkForUpdates };
