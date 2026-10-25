// Before a release: the tag, package.json and CHANGELOG.md must agree, and package.json must
// name the repository being released from, as the app's update check reads it from there.
//
//   node scripts/check-release.mjs <tag> <owner/repo>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { repoFromPackage } = createRequire(import.meta.url)("../electron/update-check.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const [tag = "", repository = ""] = process.argv.slice(2);

const problems = [];
const version = tag.replace(/^v/, "");
if (!/^v\d+\.\d+\.\d+$/.test(tag)) problems.push(`the tag ${tag} is not vX.Y.Z`);
if (pkg.version !== version) {
  problems.push(`package.json's version is ${pkg.version}, not ${version}`);
}
if (!changelog.split(/\r?\n/).includes(`## ${version}`)) {
  problems.push(`CHANGELOG.md has no "## ${version}" section for the release notes`);
}
const named = repoFromPackage(pkg);
if (!named || named.toLowerCase() !== repository.toLowerCase()) {
  problems.push(
    `package.json's repository is ${named ?? "not on GitHub"}, not ${repository}; ` +
      "the update check would look for releases in the wrong place",
  );
}

if (problems.length) {
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`${tag}: package.json, CHANGELOG.md and the repository agree`);
