// The update check's decisions: which repository, which versions count as newer, which page opens.

import { describe, expect, it } from "vitest";
import {
  findUpdate,
  isNewer,
  parseVersion,
  releasePageUrl,
  repoFromPackage,
} from "../electron/update-check.cjs";
import pkg from "../package.json";

describe("the repository", () => {
  it("comes from package.json", () => {
    expect(repoFromPackage(pkg)).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  it("reads each form npm accepts for GitHub", () => {
    for (const url of [
      "git+https://github.com/ohmlab-ltd/neuro-studio.git",
      "https://github.com/ohmlab-ltd/neuro-studio",
      "https://github.com/ohmlab-ltd/neuro-studio/",
      "git@github.com:ohmlab-ltd/neuro-studio.git",
    ]) {
      expect(repoFromPackage({ repository: { url } }), url).toBe("ohmlab-ltd/neuro-studio");
    }
    expect(repoFromPackage({ repository: "https://github.com/a/b.git" })).toBe("a/b");
  });

  it("is null off GitHub or when missing", () => {
    expect(repoFromPackage({ repository: { url: "https://gitlab.com/a/b.git" } })).toBeNull();
    expect(repoFromPackage({})).toBeNull();
    expect(repoFromPackage(null)).toBeNull();
  });
});

describe("versions", () => {
  it("parse with or without a v, and not pre-releases", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion(" 0.10.0 ")).toEqual([0, 10, 0]);
    expect(parseVersion("v1.2.3-beta.1")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it("compare by number, not as text", () => {
    expect(isNewer([0, 10, 0], [0, 9, 9])).toBe(true);
    expect(isNewer([0, 9, 9], [0, 10, 0])).toBe(false);
    expect(isNewer([1, 0, 0], [1, 0, 0])).toBe(false);
  });
});

describe("the release page", () => {
  it("is the release's own page when it is in this repository", () => {
    const page = "https://github.com/o/r/releases/tag/v0.2.0";
    expect(releasePageUrl("o/r", { html_url: page })).toBe(page);
  });

  it("falls back to the latest release for any other address", () => {
    for (const html_url of [
      "https://evil.example/o/r/releases/tag/v0.2.0",
      "https://github.com/other/r/releases/tag/v0.2.0",
      "javascript:alert(1)",
      undefined,
    ]) {
      expect(releasePageUrl("o/r", { html_url })).toBe("https://github.com/o/r/releases/latest");
    }
  });
});

describe("finding an update", () => {
  const release = (tag_name: string) => () =>
    Promise.resolve({ tag_name, html_url: `https://github.com/o/r/releases/tag/${tag_name}` });

  it("offers a newer release", async () => {
    const found = await findUpdate({
      repo: "o/r",
      currentVersion: "0.1.0",
      fetchLatest: release("v0.2.0"),
    });
    expect(found).toEqual({
      version: "0.2.0",
      tag: "v0.2.0",
      url: "https://github.com/o/r/releases/tag/v0.2.0",
    });
  });

  it("asks GitHub's API for the latest release of the repository", async () => {
    const asked: string[] = [];
    await findUpdate({
      repo: "o/r",
      currentVersion: "0.1.0",
      fetchLatest: (url: string) => {
        asked.push(url);
        return Promise.resolve({ tag_name: "v0.1.0" });
      },
    });
    expect(asked).toEqual(["https://api.github.com/repos/o/r/releases/latest"]);
  });

  it("offers nothing for the same, an older, a pre-release or a skipped version", async () => {
    for (const [tag, skipped] of [
      ["v0.1.0", null],
      ["v0.0.9", null],
      ["v0.2.0-rc.1", null],
      ["v0.2.0", "v0.2.0"],
    ]) {
      const found = await findUpdate({
        repo: "o/r",
        currentVersion: "0.1.0",
        skippedVersion: skipped,
        fetchLatest: release(tag as string),
      });
      expect(found, String(tag)).toBeNull();
    }
  });

  it("offers nothing when the check fails or there is no repository", async () => {
    const failing = () => Promise.reject(new Error("offline"));
    expect(
      await findUpdate({ repo: "o/r", currentVersion: "0.1.0", fetchLatest: failing }),
    ).toBeNull();
    expect(
      await findUpdate({ repo: null, currentVersion: "0.1.0", fetchLatest: release("v9.0.0") }),
    ).toBeNull();
  });
});
