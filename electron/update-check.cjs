// Whether GitHub has a newer release than this build. No Electron here, so the tests can run it.

/** "owner/repo" from package.json's repository field, or null when it is not on GitHub. */
function repoFromPackage(pkg) {
  const repository = pkg && pkg.repository;
  const url = typeof repository === "string" ? repository : repository && repository.url;
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url || "");
  return match ? `${match[1]}/${match[2]}` : null;
}

/** "v1.2.3" or "1.2.3" as [1, 2, 3]; null for anything else, pre-releases included. */
function parseVersion(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** The release's own page when it belongs to `repo` on GitHub, else the repo's latest release. */
function releasePageUrl(repo, release) {
  const page = release && release.html_url;
  const prefix = `https://github.com/${repo}/releases/`;
  return typeof page === "string" && page.startsWith(prefix) ? page : `${prefix}latest`;
}

/**
 * The newer release to offer, or null: none, not newer, skipped by the user, or the check failed.
 * @param {{ repo: string | null, currentVersion: string, skippedVersion?: string | null,
 *   fetchLatest: (url: string) => Promise<any> }} options
 * @returns {Promise<{ version: string, tag: string, url: string } | null>}
 */
async function findUpdate({ repo, currentVersion, skippedVersion = null, fetchLatest }) {
  const current = parseVersion(currentVersion);
  if (!repo || !current) return null;
  let release;
  try {
    release = await fetchLatest(`https://api.github.com/repos/${repo}/releases/latest`);
  } catch {
    return null;
  }
  const tag = release && release.tag_name;
  const latest = parseVersion(tag);
  if (!latest || !isNewer(latest, current) || tag === skippedVersion) return null;
  return { version: latest.join("."), tag, url: releasePageUrl(repo, release) };
}

module.exports = { repoFromPackage, parseVersion, isNewer, releasePageUrl, findUpdate };
