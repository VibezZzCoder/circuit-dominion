// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
// Origin/attribution contracts: official-host detection, and proof that the
// release check refuses a copy whose credits were stripped or that loads remotely.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN, ORIGIN_LINE, applyOriginNotice, isOfficialHost } from "../src/origin.js";
import { verifyOrigin } from "./verify-origin.mjs";
import { remoteLoad } from "./verify-release.mjs";

const RELEASE = fileURLToPath(new URL("../release/", import.meta.url));
let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
const at = (href) => new URL(href);

await test("official hosts and offline files never show the copy notice; other hosts do", () => {
  for (const href of ["https://circuit.erodmen.com/", "https://vibezzzcoder.github.io/circuit-dominion/",
    "http://127.0.0.1:8787/index.html", "http://localhost:3000/", "http://[::1]:8000/", "http://game.localhost/",
    "file:///Users/someone/Downloads/circuit_dominion.single-file.html"]) {
    assert.equal(isOfficialHost(at(href)), true, href);
  }
  for (const href of ["https://someone-else.github.io/circuit-dominion/", "https://games.example.com/robots/",
    "https://circuit.erodmen.com.example.net/"]) {
    assert.equal(isOfficialHost(at(href)), false, href);
  }
  const notice = { hidden: true };
  applyOriginNotice({ getElementById: () => notice }, at("https://mirror.example.org/"));
  assert.equal(notice.hidden, false);
  applyOriginNotice({ getElementById: () => notice }, at("https://circuit.erodmen.com/"));
  assert.equal(notice.hidden, true);
  assert.match(ORIGIN_LINE, /Edwin RodMen \(VibezZzCoder\)\. Source: https:\/\/github\.com\/VibezZzCoder\/circuit-dominion$/);
});

await test("the built release carries the origin on every page, script and notice", async () => {
  await verifyOrigin(RELEASE);
  const single = await readFile(path.join(RELEASE, "circuit_dominion.single-file.html"), "utf8");
  assert.ok(single.indexOf(ORIGIN.repositoryUrl) < 400, "head comment names the source first");
  assert.match(single, /<script type="module">\n\/\*! Circuit Dominion v1\.0 — original game by Edwin RodMen/);
});

await test("a copy with the credits stripped is refused", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "cd-origin-negative-"));
  try {
    await cp(RELEASE, fixture, { recursive: true });
    for (const file of ["index.html", "circuit_dominion.single-file.html", "src/main.js", "src/origin.js", "NOTICE.md"]) {
      const full = path.join(fixture, file);
      let text = await readFile(full, "utf8");
      for (const value of [ORIGIN.author, ORIGIN.handle, ORIGIN.repositoryUrl]) text = text.replaceAll(value, "REMOVED");
      await writeFile(full, text);
    }
    await assert.rejects(verifyOrigin(fixture), /Origin markers missing/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

await test("each surface is checked on its own: page credit, main.js banner, NOTICE", async () => {
  const cases = [
    ["index.html", (s) => s.replace('class="creditLine"', 'class="footer"'), /index\.html is missing: class="creditLine"/],
    ["src/main.js", (s) => s.replace("console.info(ORIGIN_LINE);", ""), /src\/main\.js lost/],
    ["NOTICE.md", (s) => s.replaceAll("section 7", "the terms"), /NOTICE\.md is missing: section 7/],
  ];
  for (const [file, edit, expected] of cases) {
    const fixture = await mkdtemp(path.join(tmpdir(), "cd-origin-surface-"));
    try {
      await cp(RELEASE, fixture, { recursive: true });
      const full = path.join(fixture, file);
      await writeFile(full, edit(await readFile(full, "utf8")));
      await assert.rejects(verifyOrigin(fixture), expected, file);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }
});

await test("attribution URLs are allowed as text, but a remote load still fails the release", () => {
  const url = ORIGIN.repositoryUrl;
  for (const loads of [`<script src="${url}/x.js">`, `<img src='${url}/a.png'>`, `background: url(${url}/a.png)`,
    `fetch("${url}/data.json")`, `import("${url}/m.js")`, `<link rel="stylesheet" href="${url}/a.css">`]) {
    assert.match(loads, remoteLoad, loads);
  }
  for (const text of [`<link rel="canonical" href="${ORIGIN.homepageUrl}">`, `<link rel="author" href="${ORIGIN.authorUrl}">`,
    `<link rel="code-repository" href="${url}">`, `<a class="siteLink" href="${url}" target="_blank">`,
    `<meta name="author" content="${ORIGIN.author}">`, `console.info("Source: ${url}")`, `Source: ${url}`]) {
    assert.doesNotMatch(text, remoteLoad, text);
  }
});

console.log(`origin-tests: ${passed}/${passed} passed (official hosts, release markers, stripped copy refused, per-surface, remote load)`);
