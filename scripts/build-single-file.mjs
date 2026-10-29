// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
//
// Generates release/circuit_dominion.single-file.html: a true all-in-one build of
// the canonical modular source (index.html + styles/main.css + src/*.js + assets).
//
// - CSS is inlined into a <style> tag.
// - All ES modules are bundled into one <script type="module"> using a tiny
//   factory/registry so each module keeps its own scope (no name collisions) and
//   `import.meta` stays valid.
// - The asset manifest and every image are embedded as data: URIs via the global
//   window.__CD_INLINE_ASSETS__, which src/assets.js consumes (see resolveAssetUrl),
//   so the file runs offline from file:// with full art and no fetch.
//
// Run directly: `node scripts/build-single-file.mjs`
// Or import { buildSingleFile } and call it from build-release.mjs.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ORIGIN } from "../src/origin.js";

const ROOT = new URL("../", import.meta.url);

// Module load order honoring the dependency graph (acyclic). Lazy __require also
// tolerates ordering, but a sensible order keeps the output readable.
const MODULE_ORDER = [
  "utils",
  "origin",
  "presentation",
  "state",
  "units",
  "combat-state",
  "board",
  "ai",
  "combat",
  "audio",
  "platform",
  "debug",
  "assets",
  "fx",
  "board-render",
  "combat-render",
  "render",
  "input",
  "ui",
  "main",
];

const IMAGE_MIME = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

// Origin banner at the top of the bundle; the page's own head comment (from
// index.html) carries the full GPL notice and section 7 terms.
const BUNDLE_BANNER = `/*! ${ORIGIN.title} v${ORIGIN.version} — original game by ${ORIGIN.author} (${ORIGIN.handle})
 * Source: ${ORIGIN.repositoryUrl}
 * Copyright (C) ${ORIGIN.year} ${ORIGIN.author}. ${ORIGIN.licence} with section 7 terms (NOTICE.md). */`;

function transformModule(name, source) {
  const exportNames = new Set();
  const exportRe = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g;
  let match;
  while ((match = exportRe.exec(source)) !== null) {
    exportNames.add(match[1]);
  }

  let body = source;

  // import { a, b } from "./mod.js";  ->  const { a, b } = __require("mod");
  body = body.replace(
    /import\s*\{([^}]*)\}\s*from\s*["']\.\/([\w.-]+)\.js["'];?/g,
    (_m, names, mod) => `const {${names}} = __require(${JSON.stringify(mod)});`,
  );

  // Drop the leading `export ` keyword from declarations; the registry returns them.
  body = body.replace(/export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/g, "");

  const returned = [...exportNames].join(", ");
  return [
    `__modules[${JSON.stringify(name)}] = function () {`,
    body,
    `return { ${returned} };`,
    `};`,
  ].join("\n");
}

async function buildModuleBundle() {
  const parts = [];
  for (const name of MODULE_ORDER) {
    const source = await readFile(new URL(`src/${name}.js`, ROOT), "utf8");
    parts.push(transformModule(name, source));
  }

  return [
    BUNDLE_BANNER,
    '"use strict";',
    "const __modules = {};",
    "const __cache = new Map();",
    "function __require(name) {",
    "  if (!__cache.has(name)) {",
    "    __cache.set(name, undefined);",
    "    __cache.set(name, __modules[name]());",
    "  }",
    "  return __cache.get(name);",
    "}",
    parts.join("\n\n"),
    '__require("main");',
  ].join("\n");
}

async function buildInlineAssets() {
  const manifestRaw = await readFile(new URL("assets/live/manifest.json", ROOT), "utf8");
  const manifest = JSON.parse(manifestRaw);

  const dataUris = {};
  const seen = new Set();
  for (const asset of manifest.assets || []) {
    if (!asset.path || seen.has(asset.path)) {
      continue;
    }
    seen.add(asset.path);
    const ext = asset.path.slice(asset.path.lastIndexOf(".")).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) {
      continue;
    }
    const bytes = await readFile(new URL(asset.path, ROOT));
    dataUris[asset.path] = `data:${mime};base64,${bytes.toString("base64")}`;
  }

  return { manifest, dataUris, count: Object.keys(dataUris).length };
}

export async function buildSingleFile(outUrl = new URL("release/circuit_dominion.single-file.html", ROOT)) {
  const [indexHtml, css, moduleBundle, inlineAssets] = await Promise.all([
    readFile(new URL("index.html", ROOT), "utf8"),
    readFile(new URL("styles/main.css", ROOT), "utf8"),
    buildModuleBundle(),
    buildInlineAssets(),
  ]);

  let html = indexHtml;

  // Inline the stylesheet.
  html = html.replace(
    /<link\s+rel="stylesheet"\s+href="\.\/styles\/main\.css">/,
    `<style>\n${css}\n</style>`,
  );

  // Any literal "</script>" inside embedded JS/JSON (e.g. the QA-bridge HTML string
  // in main.js) would close the inline <script> tag early; neutralize it.
  const escapeForScript = (text) => text.replace(/<\/(script)/gi, "<\\/$1");

  // Embed assets (classic script, runs before the deferred module) + the bundle.
  const inlineAssetsScript =
    `<script>window.__CD_INLINE_ASSETS__ = ${escapeForScript(
      JSON.stringify({
        manifest: inlineAssets.manifest,
        dataUris: inlineAssets.dataUris,
      }),
    )};<\/script>`;
  const bundleScript = `<script type="module">\n${escapeForScript(moduleBundle)}\n<\/script>`;

  html = html.replace(
    /<script\s+type="module"\s+src="\.\/src\/main\.js"><\/script>/,
    `${inlineAssetsScript}\n${bundleScript}`,
  );

  // The GPL notice comes from index.html's head comment; never invent one here.
  if (!html.slice(0, 2400).includes("License: GPL-3.0-or-later")) {
    throw new Error("index.html lost its GPL/origin head comment; restore it before building.");
  }

  await writeFile(outUrl, html, "utf8");
  return { path: fileURLToPath(outUrl), bytes: Buffer.byteLength(html), assetCount: inlineAssets.count };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  buildSingleFile()
    .then((result) => {
      console.log(
        `single-file-ready: ${result.path} (${(result.bytes / 1024 / 1024).toFixed(2)} MB, ${result.assetCount} embedded images)`,
      );
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
