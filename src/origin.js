// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
// Who made the game and where it lives. index.html, README.md and NOTICE.md
// repeat these strings literally; scripts/verify-origin.mjs checks they still
// match and refuses a release that lost any of them.
export const ORIGIN = Object.freeze({
  title: "Circuit Dominion",
  version: "1.0",
  author: "Edwin RodMen",
  handle: "VibezZzCoder",
  authorUrl: "https://github.com/VibezZzCoder",
  repositoryUrl: "https://github.com/VibezZzCoder/circuit-dominion",
  homepageUrl: "https://circuit.erodmen.com/",
  pagesUrl: "https://vibezzzcoder.github.io/circuit-dominion/",
  year: "2026",
  licence: "GPL-3.0-or-later",
  // Hosts serving the official build. Any other web host shows a small,
  // non-blocking pointer back to the original; file:// never does.
  officialHosts: Object.freeze(["circuit.erodmen.com", "vibezzzcoder.github.io", "localhost", "127.0.0.1", "[::1]"]),
});

export const ORIGIN_LINE = `${ORIGIN.title} v${ORIGIN.version} — original game by ${ORIGIN.author} (${ORIGIN.handle}). Source: ${ORIGIN.repositoryUrl}`;

export function isOfficialHost(location) {
  if (!location || !/^https?:$/.test(location.protocol)) return true;
  const host = String(location.hostname).toLowerCase();
  return ORIGIN.officialHosts.includes(host) || host.endsWith(".localhost");
}

// Reveals the title-screen pointer to the original when served elsewhere.
export function applyOriginNotice(doc, location) {
  const notice = doc?.getElementById?.("originNotice");
  if (notice) notice.hidden = isOfficialHost(location);
}
