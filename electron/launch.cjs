// Launch options, read once by the main process and passed to each window's preload.
//
//   --network-only         or NEURO_STUDIO_NETWORK_ONLY=1  no libusb and no serial ports
//   --wifi-host=<address>  or NEURO_STUDIO_WIFI_HOST       WiFi SoftAP host, default 192.168.10.1
//   --wifi-port=<port>     or NEURO_STUDIO_WIFI_PORT       WiFi SoftAP port, default 5000

/** Window arguments the preload reads. */
const RENDERER_NETWORK_ONLY = "--neuro-network-only";
const RENDERER_WIFI_HOST = "--neuro-wifi-host=";
const RENDERER_WIFI_PORT = "--neuro-wifi-port=";

function argValue(argv, name) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => typeof arg === "string" && arg.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

/** A host name or address with nothing that could split an argument. */
function cleanHost(value) {
  if (typeof value !== "string") return null;
  const host = value.trim();
  return /^[A-Za-z0-9.:-]{1,253}$/.test(host) ? host : null;
}

function cleanPort(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {{ networkOnly: boolean, wifiHost: string | null, wifiPort: number | null }}
 */
function parseLaunchOptions(argv = [], env = {}) {
  const networkOnly =
    argv.includes("--network-only") || /^(1|true|yes)$/i.test(env.NEURO_STUDIO_NETWORK_ONLY || "");
  return {
    networkOnly,
    wifiHost: cleanHost(argValue(argv, "wifi-host") ?? env.NEURO_STUDIO_WIFI_HOST),
    wifiPort: cleanPort(argValue(argv, "wifi-port") ?? env.NEURO_STUDIO_WIFI_PORT),
  };
}

function rendererArguments(options) {
  const args = [];
  if (options.networkOnly) args.push(RENDERER_NETWORK_ONLY);
  if (options.wifiHost) args.push(`${RENDERER_WIFI_HOST}${options.wifiHost}`);
  if (options.wifiPort) args.push(`${RENDERER_WIFI_PORT}${options.wifiPort}`);
  return args;
}

module.exports = {
  parseLaunchOptions,
  rendererArguments,
  RENDERER_NETWORK_ONLY,
  RENDERER_WIFI_HOST,
  RENDERER_WIFI_PORT,
};
