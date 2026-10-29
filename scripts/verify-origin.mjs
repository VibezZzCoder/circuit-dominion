// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
// Refuses a publishable folder that no longer says who made the game.
//
//   node scripts/verify-origin.mjs                 # release/ (after build-release)
//   node scripts/verify-origin.mjs --dir <folder>  # e.g. a public repo export
//
// Every marker fails silently when lost (a hand-edited page, a dropped banner,
// a rewritten README), so this is a refusal, not a warning. The strings come
// from src/origin.js; fix the marker, never this check.
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN } from "../src/origin.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ATTRIBUTION = `${ORIGIN.title} — original game by ${ORIGIN.author} (${ORIGIN.handle})`;
const PAGE_NEEDLES = [ATTRIBUTION, ORIGIN.authorUrl, ORIGIN.repositoryUrl, ORIGIN.homepageUrl,
  "License: GPL-3.0-or-later", 'class="creditLine"', 'id="helpAbout"', 'id="originNotice"'];
// Text files are required only where the caller says they must ship.
const TEXT_FILES = {
  "NOTICE.md": [ATTRIBUTION, ORIGIN.repositoryUrl, "section 7"],
  "README.md": [ORIGIN.author, ORIGIN.handle, ORIGIN.repositoryUrl],
};

async function pages(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...await pages(directory, relative));
    else if (/\.html?$/i.test(entry.name)) found.push(relative);
  }
  return found.sort();
}

export async function verifyOrigin(directory = path.join(ROOT, "release"), { require = ["NOTICE.md"] } = {}) {
  const problems = [];
  const htmlFiles = await pages(directory);
  if (htmlFiles.length === 0) problems.push("no .html page to check — is this the published folder?");
  for (const file of htmlFiles) {
    const html = await readFile(path.join(directory, file), "utf8");
    const missing = PAGE_NEEDLES.filter((needle) => !html.includes(needle));
    if (missing.length) problems.push(`${file} is missing: ${missing.join(" | ")}`);
    // The script itself must carry the origin: the bundle in the single file, main.js otherwise.
    const scripts = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || []).join("\n");
    const modular = /<script\b[^>]*src="\.\/src\/main\.js"/.test(html);
    if (!modular && !scripts.includes(ORIGIN.repositoryUrl)) problems.push(`${file}: no inline <script> carries the origin banner`);
  }
  const main = path.join(directory, "src/main.js");
  if (existsSync(main)) {
    const source = await readFile(main, "utf8");
    if (!source.includes(`/*! ${ATTRIBUTION}`) || !source.includes("console.info(ORIGIN_LINE)")) {
      problems.push("src/main.js lost its /*! origin banner or boot console line");
    }
  }
  const originModule = path.join(directory, "src/origin.js");
  if (existsSync(originModule)) {
    const source = await readFile(originModule, "utf8");
    const missing = [ORIGIN.author, ORIGIN.handle, ORIGIN.repositoryUrl].filter((needle) => !source.includes(needle));
    if (missing.length) problems.push(`src/origin.js is missing: ${missing.join(" | ")}`);
  }
  for (const [file, needles] of Object.entries(TEXT_FILES)) {
    const full = path.join(directory, file);
    if (!existsSync(full)) {
      if (require.includes(file)) problems.push(`${file} is required here and missing`);
      continue;
    }
    const text = await readFile(full, "utf8");
    const missing = needles.filter((needle) => !text.includes(needle));
    if (missing.length) problems.push(`${file} is missing: ${missing.join(" | ")}`);
  }
  if (problems.length) {
    throw new Error(`Origin markers missing in ${directory}; this build will not be released:\n  - ${problems.join("\n  - ")}`);
  }
  return { pages: htmlFiles.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--dir");
  const directory = path.resolve(at > -1 ? process.argv[at + 1] : path.join(ROOT, "release"));
  verifyOrigin(directory).then((result) => console.log("verify-origin: ok", result)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
