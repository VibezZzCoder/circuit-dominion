// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rename, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "./verify-release.mjs";
const root = fileURLToPath(new URL("../release/", import.meta.url));
await verifyRelease(root);
const fixture = await mkdtemp(path.join(tmpdir(), "cd-release-negative-"));
try {
  await cp(root, fixture, { recursive: true });
  const single = "circuit_dominion.single-file.html";
  await mkdir(path.join(fixture, "release"));
  await rename(path.join(fixture, single), path.join(fixture, "release", single));
  await assert.rejects(verifyRelease(fixture), /Release file layout differs/);
  await rename(path.join(fixture, "release", single), path.join(fixture, single));
  await rm(path.join(fixture, "release"), { recursive: true });
  await appendFile(path.join(fixture, "styles/main.css"), "\n/* stale fixture */\n");
  await assert.rejects(verifyRelease(fixture), /Stale or changed release file/);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
console.log("release-tests: ok (correct artifact, misplaced artifact, stale CSS)");
