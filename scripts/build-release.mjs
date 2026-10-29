// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import { mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { buildSingleFile } from './build-single-file.mjs';
import { verifyRelease } from './verify-release.mjs';

const RELEASE_DIR = new URL('../release/', import.meta.url);
const ROOT = new URL('../', import.meta.url);
const SINGLE_FILE_RELEASE = new URL('./circuit_dominion.single-file.html', RELEASE_DIR);

async function rebuildRelease() {
  if (existsSync(RELEASE_DIR)) {
    await rm(RELEASE_DIR, { recursive: true, force: true });
  }

  await mkdir(RELEASE_DIR, { recursive: true });
  await mkdir(new URL('./src/', RELEASE_DIR), { recursive: true });
  await mkdir(new URL('./styles/', RELEASE_DIR), { recursive: true });
  await mkdir(new URL('./assets/live/', RELEASE_DIR), { recursive: true });

  await cp(new URL('./index.html', ROOT), new URL('./index.html', RELEASE_DIR));
  await cp(new URL('./LICENSE', ROOT), new URL('./LICENSE', RELEASE_DIR));
  await cp(new URL('./NOTICE.md', ROOT), new URL('./NOTICE.md', RELEASE_DIR));
  await cp(new URL('./styles/main.css', ROOT), new URL('./styles/main.css', RELEASE_DIR));
  const publicFiles = { recursive: true, filter: (source) => !source.endsWith('/.DS_Store') };
  await cp(new URL('./src/', ROOT), new URL('./src/', RELEASE_DIR), publicFiles);
  await cp(new URL('./assets/live/', ROOT), new URL('./assets/live/', RELEASE_DIR), publicFiles);

  // Generate the all-in-one single-file artifact from the canonical modular source.
  await buildSingleFile(SINGLE_FILE_RELEASE);
  await verifyRelease();
}

rebuildRelease().then(() => {
  console.log('release-ready');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
