// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSingleFile } from "./build-single-file.mjs";
import { verifyOrigin } from "./verify-origin.mjs";
import { ORIGIN } from "../src/origin.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Outbound links the player can choose to open; never loaded by the game.
export const OUTBOUND_LINKS = ["https://circuit.erodmen.com", "https://github.com/VibezZzCoder/circuit-dominion"];
// Attribution URLs may appear as plain text (head comment, metadata, credits,
// console line) but are never loaded; anything that loads remotely still fails.
const ATTRIBUTION_URLS = [ORIGIN.repositoryUrl, ORIGIN.authorUrl, ORIGIN.homepageUrl, ORIGIN.pagesUrl]
  .sort((a, b) => b.length - a.length);
export const remoteLoad = /(?:\bsrc\s*=|url\(|fetch\(|import\s*\(?|<link\b(?![^>]*\brel="(?:author|canonical|code-repository)")[^>]*\bhref\s*=)\s*["']?https?:\/\//i;
const outboundHref = new RegExp(`<a\\b[^>]*\\bhref="(?:${OUTBOUND_LINKS.map((url) => url.replace(/[.]/g, "\\.")).join("|")})/?"`, "gi");
export async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(directory, relative));
    else files.push(relative);
  }
  return files.sort();
}

export async function verifyRelease(directory = path.join(ROOT, "release")) {
  const sourceFiles = ["index.html", "LICENSE", "NOTICE.md", "styles/main.css",
    ...(await listFiles(path.join(ROOT, "src"))).map((file) => `src/${file}`),
    ...(await listFiles(path.join(ROOT, "assets/live"))).map((file) => `assets/live/${file}`)];
  const single = "circuit_dominion.single-file.html";
  const actualFiles = await listFiles(directory);
  assert.deepEqual(actualFiles, [...sourceFiles, single].sort(),
    "Release file layout differs: check missing files, nested release folders, or work assets");
  for (const file of sourceFiles) {
    assert.ok((await readFile(path.join(ROOT, file))).equals(await readFile(path.join(directory, file))),
      `Stale or changed release file: ${file}`);
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "cd-release-check-"));
  try {
    const freshPath = path.join(temporary, single);
    await buildSingleFile(pathToFileURL(freshPath));
    const generated = await readFile(path.join(directory, single));
    assert.ok(generated.equals(await readFile(freshPath)), "Single-file build is stale");
    assert.match(generated.subarray(0, 2400).toString(), /License: GPL-3.0-or-later/);
    const manifest = JSON.parse(await readFile(path.join(directory, "assets/live/manifest.json")));
    for (const asset of manifest.assets) {
      assert.ok(actualFiles.includes(asset.path), `Manifest path/casing mismatch: ${asset.path}`);
    }
    for (const file of ["index.html", "styles/main.css", ...sourceFiles.filter((file) => file.startsWith("src/"))]) {
      const raw = await readFile(path.join(directory, file), "utf8");
      assert.doesNotMatch(raw, remoteLoad, `Remote load in ${file}`);
      let text = raw.replace(outboundHref, "<a");
      for (const url of ATTRIBUTION_URLS) text = text.replaceAll(url, "");
      assert.doesNotMatch(text, /https?:\/\//i, `Unexpected remote runtime reference: ${file}`);
    }
    await verifyOrigin(directory);
    return { files: actualFiles.length, singleFileBytes: generated.length, images: manifest.assets.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log("verify-release: ok", await verifyRelease());
}
