// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import { listFiles } from "./verify-release.mjs";
import { buildArenaObstacles } from "../src/combat.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOT_DIR = process.env.CD_E2E_SCREENSHOT_DIR || path.join(tmpdir(), "circuit-dominion-e2e");
const FULL_MATCH_SEED = Number(process.env.CD_E2E_FULL_MATCH_SEED || 2);
const PYTHON = process.env.PYTHON || "python3";
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const results = [];
const consoleIssues = [];
const requestIssues = [];
let requestPolicy = null;
let expectCoverFailure = false;
const coverFailureWarnings = [];

async function runtimeFingerprint() {
  const files = ["index.html", "styles/main.css",
    ...(await listFiles(path.join(ROOT, "src"))).map(file => `src/${file}`),
    ...(await listFiles(path.join(ROOT, "release"))).map(file => `release/${file}`)];
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(file).update(await readFile(path.join(ROOT, file)));
  return hash.digest("hex");
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.handlers = new Map();
  }

  async connect() {
    assert.ok(globalThis.WebSocket, "This Node runtime must provide global WebSocket for CDP tests.");
    this.socket = new WebSocket(this.wsUrl);
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
      } else {
        resolve(message.result || {});
      }
      return;
    }

    const waiters = this.listeners.get(message.method) || [];
    for (const waiter of [...waiters]) {
      if (!waiter.predicate || waiter.predicate(message.params || {})) {
        clearTimeout(waiter.timer);
        waiter.resolve(message.params || {});
        this.listeners.set(
          message.method,
          waiters.filter((candidate) => candidate !== waiter),
        );
      }
    }

    const handlers = this.handlers.get(message.method) || [];
    for (const handler of handlers) {
      handler(message.params || {});
    }
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}${params.type ? ` (${params.type})` : ""}`));
      }, method === "Runtime.evaluate" ? 120000 : 15000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  waitFor(method, predicate, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      const waiters = this.listeners.get(method) || [];
      waiters.push(waiter);
      this.listeners.set(method, waiters);
      waiter.timer = setTimeout(() => {
        const current = this.listeners.get(method) || [];
        if (current.includes(waiter)) {
          this.listeners.set(
            method,
            current.filter((candidate) => candidate !== waiter),
          );
          reject(new Error(`Timed out waiting for ${method}`));
        }
      }, timeoutMs);
      waiter.timer.unref?.();
    });
  }

  close() {
    this.socket.close();
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }
}

async function main() {
  const beforeFingerprint = await runtimeFingerprint();
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const serverPort = await freePort();
  const cdpPort = await freePort();
  const server = spawn(PYTHON, ["-m", "http.server", String(serverPort), "--bind", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.resume();
  server.stderr.resume();
  const chromeUserDir = await mkdtemp(path.join(tmpdir(), "circuit-dominion-chrome-"));
  const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  assert.ok(chromePath, "Could not find Chrome or Chromium. Set CHROME_PATH to run browser E2E tests.");
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeUserDir}`,
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  chrome.stdout.resume();
  chrome.stderr.resume();
  let cdp;
  try {
    await waitForHttp(`http://127.0.0.1:${serverPort}/index.html`);
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);
    const pageInfo = await createPage(cdpPort);
    cdp = new CdpClient(pageInfo.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    cdp.on("Network.requestWillBeSent", ({ request }) => {
      if (requestPolicy && !requestPolicy(request.url)) requestIssues.push(request.url);
    });
    cdp.on("Runtime.exceptionThrown", (entry) => {
      const details = entry.exceptionDetails || {};
      consoleIssues.push({
        level: "error",
        source: "exception",
        text: details.exception?.description || details.text || "Runtime exception",
        url: details.url || "",
        lineNumber: details.lineNumber,
      });
    });
    cdp.on("Runtime.consoleAPICalled", (entry) => {
      if (!["warning", "warn", "error"].includes(entry.type)) return;
      const text = entry.args.map(arg => arg.value ?? arg.description ?? "").join(" ");
      if (expectCoverFailure && /Asset failed to load: assets\/live\/sprites\/environment\/cover-(horizontal|vertical)\.png/.test(text)) {
        coverFailureWarnings.push(text);
      } else {
        consoleIssues.push({ level: entry.type, source: "console", text });
      }
    });
    cdp.on("Log.entryAdded", (entry) => {
      if (["error", "warning"].includes(entry.entry?.level)) {
        consoleIssues.push({ level: entry.entry.level, source: entry.entry.source, text: entry.entry.text });
      }
    });

    const sourceUrl = `http://127.0.0.1:${serverPort}/index.html`;
    const releaseUrl = `http://127.0.0.1:${serverPort}/release/index.html`;
    const singleFileUrl = pathToFileURL(path.join(ROOT, "release", "circuit_dominion.single-file.html")).href;
    requestPolicy = url => url.startsWith(`http://127.0.0.1:${serverPort}/`) || url.startsWith("data:") || url.startsWith("blob:");

    if (process.env.CD_E2E_ONLY_COVER === "1") {
      // Asset/render-only iteration: test exact modular/embedded bytes over HTTP.
      // This mode does not claim a fresh file:// or physical-device acceptance.
      const embeddedUrl = `http://127.0.0.1:${serverPort}/release/circuit_dominion.single-file.html`;
      for (const [label, url] of [["source", sourceUrl], ["release", releaseUrl], ["embedded-http", embeddedUrl]]) {
        await runMenuClickCase(cdp, label, url);
        await runAttackPoseCase(cdp, label, url);
        await runCoverArtCases(cdp, label, url);
      }
      await runCoverFallbackCase(cdp, releaseUrl);
    } else if (process.env.CD_E2E_ONLY_TOUCH === "1") {
      await runTouchCases(cdp, releaseUrl);
    } else if (process.env.CD_E2E_ONLY_FULL_MATCH === "1") {
      await runFullMatchCase(cdp, sourceUrl);
    } else if (process.env.CD_E2E_ONLY_GAMEPAD === "1") {
      await runGamepadCase(cdp, releaseUrl);
    } else if (process.env.CD_E2E_ONLY_PRESENTATION === "1") {
      await runAnimatedPresentationCase(cdp, sourceUrl);
    } else {
      await runMenuClickCase(cdp, "source", sourceUrl);
      await runAttackPoseCase(cdp, "source", sourceUrl);
      await runMenuClickCase(cdp, "release", releaseUrl);
      await runAttackPoseCase(cdp, "release", releaseUrl);
      requestPolicy = url => url === singleFileUrl || url.startsWith("data:") || url.startsWith("blob:");
      await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      await runMenuClickCase(cdp, "single-file", singleFileUrl);
      await runAttackPoseCase(cdp, "single-file", singleFileUrl);
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      requestPolicy = url => url.startsWith(`http://127.0.0.1:${serverPort}/`) || url.startsWith("data:") || url.startsWith("blob:");
      await runFullMatchCase(cdp, sourceUrl);
      await runNodeVictoryCase(cdp, sourceUrl);
      await runAnimatedPresentationCase(cdp, releaseUrl);
      if (process.env.CD_E2E_EXTRA_VISUALS === "1") {
        await runExtraVisualCases(cdp, releaseUrl);
      }
      await runTouchCases(cdp, releaseUrl);
      await runGamepadCase(cdp, releaseUrl);
    }

    cdp.close();
  } catch (error) {
    if (cdp) {
      await screenshot(cdp, "failure-state.png").catch(() => {});
      const snapshot = await callQa(cdp, "getSnapshot").catch(() => null);
      const pointerEvents = await evalJson(cdp, `()=>window.__CD_EVENT_AUDIT__||[]`).catch(() => []);
      await writeFile(path.join(SCREENSHOT_DIR, "failure-state.json"), JSON.stringify({error:String(error),snapshot,pointerEvents}, null, 2));
    }
    throw error;
  } finally {
    await stopProcess(chrome);
    await stopProcess(server);
    await delay(300);
    await rm(chromeUserDir, { recursive: true, force: true }).catch(() => {});
  }

  assert.deepEqual(consoleIssues, [], "Browser console warnings/errors were captured.");
  assert.deepEqual(requestIssues, [], "Unexpected runtime network or single-file dependency requests were captured.");
  assert.equal(await runtimeFingerprint(), beforeFingerprint, "Runtime/source changed during QA; rebuild and rerun against stable bytes.");
  console.log(`browser-e2e-tests: ok (${results.length} menu paths)`);
  for (const result of results) {
    console.log(`- ${result.label}: ${result.beforeScreenshot} -> ${result.afterScreenshot}`);
    console.log(`  combat: ${result.combatScreenshot}`);
    console.log(`  win: ${result.winScreenshot}`);
  }
}

async function runFullMatchCase(cdp, sourceUrl) {
  await navigate(cdp, `${sourceUrl}?full-match=1`);
  await waitForReady(cdp);
  const completed = await callQa(cdp, "autoPlayFullMatch", [180, FULL_MATCH_SEED]);
  assert.equal(
    completed.qaAutoPlay?.completed,
    true,
    `full PvAI match should reach a winner: ${JSON.stringify(completed.qaAutoPlay)} top=${completed.topState} winner=${completed.winner}`,
  );
  await waitForEval(
    cdp,
    `document.querySelector(".screen.active")?.id === "endScreen"`,
    15000,
    "full PvAI match: end screen did not appear",
  );
  assert.ok(completed.qaAutoPlay?.duels > 0, "full PvAI match should include real combat simulations");
  assert.ok(completed.qaAutoPlay?.turns <= 180, "full PvAI match should complete within the turn budget");
  assert.ok(["S", "V", "draw"].includes(readWinner(completed)),
    `full PvAI match should declare a valid outcome: ${JSON.stringify(completed.qaAutoPlay)} winner=${completed.winner}`);
  if (readWinner(completed) === "draw") {
    assert.ok(!completed.units.some(unit => unit.alive && ["CC", "NO"].includes(unit.type)),
      "A drawn match requires both commanders to be destroyed");
    assert.match(completed.winReason, /both Command Units were destroyed/);
  }
  console.log(`- full PvAI seed ${FULL_MATCH_SEED}: ${readWinner(completed)} in ${completed.qaAutoPlay.turns} turns / ${completed.qaAutoPlay.duels} duels`);
  await screenshot(cdp, "source-full-pvai-match-win.png");
}

// QA calls normally make presentation instant; this case opts back in so the
// real animated path (attack approach, duel, aftermath, AI gate) is covered.
async function runAnimatedPresentationCase(cdp, url) {
  const label = "animated-presentation";
  await navigate(cdp, url);
  await waitForReady(cdp);
  await callQa(cdp, "setInstantPresentation", [false]);
  await callQa(cdp, "startGame", ["ai"]);
  await waitForEval(cdp, `!window.__CD_TEST__.presentationState().busy`, 6000, `${label}: deployment march should finish`);
  await callQa(cdp, "setUnit", [{ type: "RC", col: 1 }, { row: 5, col: 1 }]);
  await clickBoardCell(cdp, 8, 1);
  await delay(120);
  await clickBoardCell(cdp, 5, 1);
  await delay(60);
  const approaching = await callQa(cdp, "getSnapshot");
  assert.equal(readTopState(approaching), "boardAnimating", `${label}: an attack should glide and clash before the duel`);
  assert.equal(readCombat(approaching), null, `${label}: the duel opens after the approach`);
  assertUnitAt(approaching, "PS", 8, 1, label);
  assert.ok((await callQa(cdp, "presentationState")).pendingDuel, `${label}: a pending duel should be scheduled`);
  await waitForEval(cdp, `Boolean(window.__CD_TEST__.getSnapshot().combat)`, 4000, `${label}: duel should open after the clash`);
  await screenshot(cdp, `${label}-duel.png`);
  await callQa(cdp, "resolveCombat", ["attacker"]);
  await waitForEval(cdp, `document.querySelector(".screen.active")?.id === "boardScreen"`, 5000, `${label}: board should return`);
  const after = await callQa(cdp, "getSnapshot");
  assertUnitAt(after, "PS", 5, 1, label);
  assert.equal(after.turn, "V", `${label}: Void should be next`);
  assert.equal(readTopState(after), "board", `${label}: aftermath keeps the board top state`);
  assert.ok((await callQa(cdp, "presentationState")).busy, `${label}: the aftermath should hold the AI for a beat`);
  await screenshot(cdp, `${label}-aftermath.png`);
  await waitForEval(cdp, `window.__CD_TEST__.getSnapshot().turn === "S"`, 8000, `${label}: AI should move after the aftermath and intent highlight`);
  await callQa(cdp, "setInstantPresentation", [true]);
  console.log(`- ${label}: approach/clash before duel, aftermath gate, AI intent then move`);
}

async function runNodeVictoryCase(cdp, sourceUrl) {
  await navigate(cdp, `${sourceUrl}?node-victory=1`);
  await waitForReady(cdp);
  await callQa(cdp, "startGame", ["ai"]);
  await callQa(cdp, "occupyPowerNodes", ["S"]);
  const won = await callQa(cdp, "evaluateCurrentWinners");
  await waitForEval(
    cdp,
    `document.querySelector(".screen.active")?.id === "endScreen"`,
    5000,
    "node victory: end screen did not appear",
  );
  assert.equal(readWinner(won), "S", "Solar should win after occupying all five Power Nodes");
  assert.match(won.winReason || "", /all Power Nodes/i, "node victory should report its objective");
  await screenshot(cdp, "source-node-victory.png");
}

const volumeUiSource = `()=>{
  const music=[...document.querySelectorAll('input[data-volume=music]')];
  const link=document.querySelector('#titleScreen .siteLink');
  return {music:music.map(s=>s.value), label:music[0]?.parentElement.querySelector('.volumeValue')?.textContent,
    sfx:document.querySelector('#helpOverlay input[data-volume=sfx]')?.value,
    link:link&&{href:link.href,target:link.target,rel:link.rel,height:link.getBoundingClientRect().height}};
}`;

// Music slider starts below full, persists across reloads, and mirrors into Help.
async function runVolumeUiCase(cdp, label, url) {
  const clearVolumes = `()=>{localStorage.removeItem("cd.musicVolume");localStorage.removeItem("cd.sfxVolume");return true}`;
  await evalJson(cdp, clearVolumes);
  await navigate(cdp, url);
  await waitForReady(cdp);
  const fresh = await evalJson(cdp, volumeUiSource);
  assert.deepEqual(fresh.music, ["60", "60"], `${label}: music sliders should default to 60%`);
  assert.equal(fresh.sfx, "100", `${label}: effects slider should default to full`);
  assert.deepEqual(fresh.link && [fresh.link.href, fresh.link.target, fresh.link.rel],
    ["https://circuit.erodmen.com/", "_blank", "noopener"], `${label}: title should link to the website in a new tab`);
  assert.ok(fresh.link.height >= 44, `${label}: website link should be a full touch target`);
  await evalJson(cdp, `()=>{const s=document.querySelector('#titleScreen input[data-volume=music]');s.value="25";s.dispatchEvent(new Event("input",{bubbles:true}));return true}`);
  await navigate(cdp, url);
  await waitForReady(cdp);
  const kept = await evalJson(cdp, volumeUiSource);
  assert.deepEqual([kept.music, kept.label], [["25", "25"], "25%"], `${label}: music volume should persist and mirror into Help`);
  await evalJson(cdp, clearVolumes);
}

async function runMenuClickCase(cdp, label, url) {
  await navigate(cdp, url);
  await waitForReady(cdp);
  await runVolumeUiCase(cdp, label, url);
  await navigate(cdp, url);
  await waitForReady(cdp);

  const before = await evalJson(cdp, menuDiagnosticsSource, label);
  assert.equal(before.title, "Circuit Dominion", `${label}: page title should identify the game`);
  assert.deepEqual(before.activeScreens, ["titleScreen"], `${label}: title screen should be active before click`);
  assert.equal(before.button.present, true, `${label}: Player vs AI button should exist`);
  assert.equal(before.button.disabled, false, `${label}: Player vs AI button should be enabled`);
  assert.ok(before.button.rect.width > 40 && before.button.rect.height > 30, `${label}: button should have a visible box`);
  assert.equal(before.topAtButtonCenter.closestButtonId, "newAI", `${label}: button center should not be covered`);
  assert.equal(before.button.styles.pointerEvents, "auto", `${label}: button should receive pointer events`);
  assert.equal(before.overlays.length, 0, `${label}: no overlay should be active on title`);

  const beforeScreenshot = await screenshot(cdp, `${label}-menu-before.png`);
  await click(cdp, before.button.center.x, before.button.center.y);
  await waitForBoard(cdp, label);
  const after = await evalJson(cdp, boardDiagnosticsSource, label);

  assert.deepEqual(after.activeScreens, ["boardScreen"], `${label}: board screen should become active after visible click`);
  assert.ok(after.boardCanvas.clientWidth > 0 && after.boardCanvas.clientHeight > 0, `${label}: board canvas should be visible`);
  assert.ok(after.boardCanvas.width > 0 && after.boardCanvas.height > 0, `${label}: board canvas backing size should be non-zero`);
  assert.equal(after.topAtBoardCenter.closestCanvasId, "board", `${label}: board canvas center should not be covered`);
  assert.equal(after.log, "Solar Protocol begins. Select a robot.", `${label}: start-game log should render`);
  const boardStart = await callQa(cdp, "getSnapshot");
  assert.equal(boardStart.roundCount, 1, `${label}: a new match should begin on round 1`);
  assert.equal(boardStart.fluxPhase, 0, `${label}: a new match should begin on Neutral Flux`);
  assert.deepEqual(boardStart.commandCharge, { S: 0, V: 0 }, `${label}: Command meters should begin empty`);
  const squares = boardStart.board.flat();
  assert.equal(squares.filter((square) => square.flux).length, 27, `${label}: board should contain 27 Flux squares`);
  assert.equal(
    squares.filter((square) => !square.flux && square.energy === "L").length,
    27,
    `${label}: board should contain 27 fixed Light squares`,
  );
  assert.equal(
    squares.filter((square) => !square.flux && square.energy === "D").length,
    27,
    `${label}: board should contain 27 fixed Dark squares`,
  );

  const afterScreenshot = await screenshot(cdp, `${label}-menu-after.png`);
  const gameplay = await runGameplayContinuation(cdp, label);
  results.push({ label, beforeScreenshot, afterScreenshot, ...gameplay });
}

async function runExtraVisualCases(cdp, sourceUrl) {
  await setViewport(cdp, 390, 844);
  await navigate(cdp, sourceUrl);
  await waitForReady(cdp);
  await screenshot(cdp, "mobile-portrait-title.png");
  await clickStartAndWaitForBoard(cdp, "mobile portrait");
  await screenshot(cdp, "mobile-portrait-board.png");
  await callQa(cdp, "startCombatByMatch", [{ type: "AS", row: 8, col: 0 }, { type: "EC", row: 0, col: 0 }, 0, 0]);
  await waitForEval(cdp, `document.querySelector(".screen.active")?.id === "combatScreen"`, 5000, "mobile portrait: combat screen did not appear");
  await screenshot(cdp, "mobile-portrait-combat.png");

  await setViewport(cdp, 844, 390);
  await navigate(cdp, sourceUrl);
  await waitForReady(cdp);
  await clickStartAndWaitForBoard(cdp, "mobile landscape");
  await screenshot(cdp, "mobile-landscape-board.png");
  await callQa(cdp, "startCombatByMatch", [{ type: "AS", row: 8, col: 0 }, { type: "EC", row: 0, col: 0 }, 0, 0]);
  await waitForEval(cdp, `document.querySelector(".screen.active")?.id === "combatScreen"`, 5000, "mobile landscape: combat screen did not appear");
  await waitForEval(cdp, `window.__CD_TEST__.getSnapshot().combat?.countdown === 0`, 15000,
    "mobile landscape: combat countdown should finish before capture");
  await screenshot(cdp, "mobile-landscape-combat-active.png");

  await setViewport(cdp, 1280, 800);
  await navigate(cdp, sourceUrl);
  await waitForReady(cdp);
  await clickStartAndWaitForBoard(cdp, "desktop selected");
  await clickBoardCell(cdp, 8, 0);
  await delay(150);
  await screenshot(cdp, "desktop-selected-legal-moves.png");
  await callQa(cdp, "startCombatByMatch", [{ type: "AS", row: 8, col: 0 }, { type: "EC", row: 0, col: 0 }, 0, 0]);
  await waitForEval(cdp, `document.querySelector(".screen.active")?.id === "combatScreen"`, 5000, "desktop: combat screen did not appear");
  await waitForEval(cdp, `window.__CD_TEST__.getSnapshot().combat?.countdown === 0`, 15000);
  await screenshot(cdp, "desktop-combat-active.png");
  await cdp.send("Emulation.clearDeviceMetricsOverride");
}

async function runAttackPoseCase(cdp, label, url) {
  // A pose is drawn from its <img> only when it first appears on screen (its
  // scaled cache is built then), so a drawImage hook on the pose URLs proves
  // the real swap in modular and embedded builds alike. Also checks the floor.
  const manifest = JSON.parse(await readFile(path.join(ROOT, "assets/live/manifest.json"), "utf8"));
  const poses = manifest.assets.filter((asset) => asset.type === "unit-pose").map((asset) => ({ unit: asset.unitId, path: asset.path }));
  await setViewport(cdp, 1280, 800, false);
  await navigate(cdp, url);
  await waitForReady(cdp);
  await evalJson(cdp, `(poses)=>{
    const inline = window.__CD_INLINE_ASSETS__?.dataUris || {};
    const byUrl = new Map(poses.map((p) => [inline[p.path] || new URL(p.path, document.baseURI).href, p.unit]));
    window.__CD_POSE_DRAWS__ = []; window.__CD_FLOOR_DRAWS__ = []; window.__CD_POSE_FRAMES__ = [];
    // Sprite caches scale on OffscreenCanvas, so hook both context types.
    const hook = (proto) => { const original = proto.drawImage; proto.drawImage = function (...args) {
      const unit = args[0] instanceof HTMLImageElement ? byUrl.get(args[0].src) : null;
      if (unit && args[0].naturalWidth === 512) {
        window.__CD_POSE_DRAWS__.push(unit);
        if (window.__CD_POSE_FRAMES__.length < 2) requestAnimationFrame(() => {
          window.__CD_POSE_FRAMES__.push({ unit, png: document.getElementById("arena").toDataURL("image/png") });
        });
      }
      if (this.canvas.id === "arena" && args.length === 5 && args[3] >= 960 * 1.06 - 0.01) {
        window.__CD_FLOOR_DRAWS__.splice(0, 9, args.slice(1).map((v) => Math.round(v * 10) / 10));
      }
      return original.apply(this, args);
    }; };
    hook(CanvasRenderingContext2D.prototype);
    if (typeof OffscreenCanvasRenderingContext2D !== "undefined") hook(OffscreenCanvasRenderingContext2D.prototype);
    return byUrl.size;
  }`, poses);
  await callQa(cdp, "startGame", ["ai"]);
  await callQa(cdp, "startCombatByMatch", [{ type: "AS", row: 8, col: 0 }, { type: "EC", row: 0, col: 0 }, 0, 0]);
  // Void is the AI; the Solar human fires with held Space once the duel opens.
  await waitForEval(cdp, `window.__CD_TEST__.getSnapshot().combat?.state === "combatActive"`, 10000);
  await pressKey(cdp, " ", "Space", 32, 700);
  await waitForEval(cdp, `new Set(window.__CD_POSE_DRAWS__).size >= 2 && window.__CD_POSE_FRAMES__.length >= 2`, 20000,
    `${label}: Arc Sniper (player fire) and Entropy Cannon (AI) attack poses must draw`);
  const result = await evalJson(cdp, `()=>({ units: [...new Set(window.__CD_POSE_DRAWS__)].sort(), floor: window.__CD_FLOOR_DRAWS__[0], frames: window.__CD_POSE_FRAMES__ })`);
  assert.deepEqual(result.units, ["AS", "EC"], `${label}: only the duelling units' poses draw`);
  const [x, y, w, h] = result.floor;
  assert.ok(Math.abs(x + w / 2 - 480) < 0.2 && Math.abs(y + h / 2 - 260) < 0.2 && w / h > 1.84 && w / h < 1.85,
    `${label}: top-down floor is centred on the arena at 960:520 (${result.floor})`);
  for (const [index, frame] of result.frames.entries()) {
    await writeFile(path.join(SCREENSHOT_DIR, `${label}-attack-pose-${index}-${frame.unit}.png`), frame.png.split(",")[1], "base64");
  }
  console.log(`- ${label}: attack poses swap in (${result.units.join(", ")}) over the centred top-down floor`);
}

async function runCoverArtCases(cdp, label, url) {
  const profiles = label === "release" ? [[1280,800],[390,844],[844,390],[768,1024],[1024,768]] : [[1280,800]];
  const manifest = JSON.parse(await readFile(path.join(ROOT,"assets/live/manifest.json"),"utf8"));
  for (const [width,height] of profiles) {
    await setViewport(cdp,width,height);
    await navigate(cdp,url);
    await waitForReady(cdp);
    await evalJson(cdp,`()=>{
      window.__CD_COVER_DRAWS__=[];
      const original=CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage=function(...args){
        if(this.canvas.id==='arena' && args.length===9 && [76,92].includes(args[7])) {
          const image=args[0];
          window.__CD_COVER_DRAWS__.push({rect:args.slice(1),loaded:image.complete&&image.naturalWidth>0,
            embedded:image.src.startsWith('data:image/')});
          if(window.__CD_COVER_DRAWS__.length>100)window.__CD_COVER_DRAWS__.shift();
        }
        return original.apply(this,args);
      };
      return true;
    }`);
    for (const energy of ["L","D","N"]) {
      const board = await callQa(cdp,"startGame",["ai"]);
      let cell;
      board.board.forEach((row,r)=>row.forEach((square,c)=>{if(!cell && square.energy===energy)cell={r,c};}));
      assert.ok(cell,`${label}: board has ${energy} energy`);
      await evalJson(cdp,`()=>{window.__CD_COVER_DRAWS__=[];return true;}`);
      const initial = await callQa(cdp,"startCombatByMatch",[{type:"AS"},{type:"EC"},cell.r,cell.c]);
      assert.deepEqual(initial.combat.obstacles,buildArenaObstacles(energy));
      await waitForEval(cdp,`window.__CD_COVER_DRAWS__.length>=2`,8000,`${label}: cover sprites must draw`);
      const expectedAsset = manifest.assets.find(a=>a.id===`environment.cover-${energy==="N"?"vertical":"horizontal"}`);
      const source = expectedAsset.sourceRect;
      const draws=await evalJson(cdp,`()=>window.__CD_COVER_DRAWS__.slice(-2)`);
      assert.deepEqual(draws.map(d=>d.rect),initial.combat.obstacles.map(o=>[
        source.x,source.y,source.width,source.height,o.x,o.y,o.width,o.height]));
      assert.ok(draws.every(d=>d.loaded));
      if(label==="embedded-http")assert.ok(draws.every(d=>d.embedded),"Embedded cover must draw from data URIs");
      const pixels=await coverPixelRead(cdp);
      assert.ok(pixels.every(p=>p.warmFraction>0.25),`${label} ${energy}: actual armor pixels must replace fallback (${JSON.stringify(pixels)})`);
      await waitForEval(cdp,`window.__CD_TEST__.getSnapshot().combat?.countdown===0`,8000);
      await screenshot(cdp,`${label}-cover-${energy}-${width}x${height}.png`);
    }
    console.log(`- ${label}: loaded/cropped cover pixels and exact footprints L/D/N at ${width}x${height}`);
  }
  await setViewport(cdp,1280,800,false);
}

async function coverPixelRead(cdp) {
  return evalJson(cdp,`()=>{
    const canvas=document.getElementById('arena');
    // Read a snapshot, not the GPU-backed gameplay canvas repeatedly. The QA
    // probe must not generate Canvas readback warnings or change renderer hints.
    const probe=document.createElement('canvas');probe.width=canvas.width;probe.height=canvas.height;
    const ctx=probe.getContext('2d',{willReadFrequently:true});ctx.drawImage(canvas,0,0);
    const scale=Math.min(canvas.width/960,canvas.height/520);
    const ox=(canvas.width-960*scale)/2, oy=(canvas.height-520*scale)/2;
    return window.__CD_TEST__.getSnapshot().combat.obstacles.map(o=>{
      const w=Math.max(1,Math.floor(o.width*0.7*scale)),h=Math.max(1,Math.floor(o.height*0.7*scale));
      const data=ctx.getImageData(Math.floor(ox+(o.x+o.width*0.15)*scale),Math.floor(oy+(o.y+o.height*0.15)*scale),w,h).data;
      let warm=0;for(let i=0;i<data.length;i+=4)if(data[i]>75&&data[i]>data[i+2]*1.16&&data[i+1]>data[i+2]*1.1)warm++;
      return {warmFraction:warm/(w*h)};
    });
  }`);
}

async function runCoverFallbackCase(cdp,url) {
  // An actual failed loader path, not a different mock renderer. Replace only
  // the two optional image URLs before the loader assigns src; no network error noise.
  expectCoverFailure = true;
  const setup=await cdp.send("Page.addScriptToEvaluateOnNewDocument",{source:`
    const descriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
    Object.defineProperty(HTMLImageElement.prototype,'src',{...descriptor,set(value){
      descriptor.set.call(this,/cover-(horizontal|vertical)\\.png$/.test(value)?'data:image/png;base64,broken':value);
    }});
  `});
  try {
    await setViewport(cdp,1280,800,false);
    await navigate(cdp,url); await waitForReady(cdp);
    await callQa(cdp,"startGame",["ai"]);
    await callQa(cdp,"startCombatByMatch",[{type:"AS"},{type:"EC"},0,0]);
    await delay(200);
    const pixels=await coverPixelRead(cdp);
    assert.ok(pixels.every(p=>p.warmFraction<0.05),"Known-bad missing artwork must fail the armor pixel gate");
    await screenshot(cdp,"release-cover-missing-fallback.png");
    await pressKey(cdp,"w","KeyW",87,120);
    assert.ok((await callQa(cdp,"getSnapshot")).combat,"Optional cover-image failures must not crash gameplay");
    assert.equal(coverFailureWarnings.length,2,"Both failed cover loads must report their fallback once");
    console.log("- release: failed image loader retains procedural cover; negative control fails armor-pixel gate");
  } finally {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument",{identifier:setup.identifier});
    expectCoverFailure = false;
  }
}

async function clickStartAndWaitForBoard(cdp, label) {
  const before = await evalJson(cdp, menuDiagnosticsSource, label);
  await click(cdp, before.button.center.x, before.button.center.y);
  await waitForBoard(cdp, label);
}

async function runTouchCases(cdp, url) {
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await runMobileNavigationCase(cdp, url);
  const profiles = [[320, 568, "ai"], [568, 320, "ai"], [390, 844, "ai"], [844, 390, "ai"],
    [768, 1024, "ai"], [1024, 768, "ai"], [390, 844, "pvp"],
    [844, 390, "pvp"], [768, 1024, "pvp"]];
  for (const [width, height, mode] of profiles) {
    const label = `touch-${width}x${height}-${mode}`;
    if (process.env.CD_E2E_TOUCH_PROFILE && label !== process.env.CD_E2E_TOUCH_PROFILE) continue;
    await setViewport(cdp, width, height, true);
    await navigate(cdp, url);
    await waitForReady(cdp);
    await evalJson(cdp, `()=>{
      window.__CD_EVENT_AUDIT__=[];
      for(const type of ['pointerdown','pointerup','pointercancel','lostpointercapture','click']) {
        window.addEventListener(type,e=>{
          window.__CD_EVENT_AUDIT__.push({type,id:e.pointerId,target:e.target?.id,primary:e.isPrimary,detail:e.detail});
          if(window.__CD_EVENT_AUDIT__.length>100)window.__CD_EVENT_AUDIT__.shift();
        },true);
      }
      return true;
    }`);
    const touch = new TouchSession(cdp);
    if (mode === "ai") {
      await touch.tap(await elementCenter(cdp, "practiceBtn", true));
    } else {
      await touch.tap(await elementCenter(cdp, "newPVP", true));
      await waitForBoard(cdp, label);
      // Actual board input, not startCombatByMatch: exercise both ownership orders.
      await touch.tap(await boardCellPoint(cdp, 8, 0));
      await touch.tap(await boardCellPoint(cdp, 4, 0));
      await touch.tap(await boardCellPoint(cdp, 0, 0));
      if (width > height) {
        await touch.tap(await boardCellPoint(cdp, 2, 0));
        await touch.tap(await boardCellPoint(cdp, 4, 0));
        await touch.tap(await boardCellPoint(cdp, 2, 0)); // Solar attacker.
      } else {
        await touch.tap(await boardCellPoint(cdp, 4, 0)); // Solar defender.
      }
    }
    await waitForEval(cdp, `Boolean(window.__CD_TEST__.getSnapshot().combat)`, 5000, `${label}: real input enters combat`);
    await waitForEval(cdp, `window.__CD_TEST__.getSnapshot().audio.state === "running"`, 5000,
      `${label}: a completed trusted tap should unlock audio`);
    await waitForEval(cdp, `window.__CD_TEST__.getSnapshot().combat?.countdown === 0`, 8000);
    await captureNormalTouchCombat(cdp, touch, label);
    if (process.env.CD_E2E_NORMAL_CAPTURE_ONLY === "1") continue;
    // This long lifecycle matrix is not a win-rate or survival test. Preserve
    // real controllers, attacks and damage, but keep both fighters alive while
    // testing nine viewports, real multitouch, overlays, and rotation. Normal
    // combat completion remains covered separately without this fixture.
    await callQa(cdp, "setCombatHpForTest", [10000]);
    const boxes = await evalJson(cdp, `() => Object.fromEntries(["arena", "stick1", "atk1", "sp1", "stick2", "atk2", "sp2", "pauseBtn", "combatHelp", "combatMute", "combatExit"].map(id => {
      const el = document.getElementById(id); const r = el.getBoundingClientRect();
      return [id,{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}];
    }))`);
    for (const id of ["stick1", "atk1", "sp1", "pauseBtn", "combatHelp", "combatMute", "combatExit", ...(mode === "pvp" ? ["stick2", "atk2", "sp2"] : [])]) {
      const box = boxes[id];
      assert.ok(box.width >= 44 && box.height >= 44, `${label}: ${id} touch target too small ${JSON.stringify(box)}`);
      assert.ok(box.x >= 0 && box.y >= 0 && box.right <= width + 1 && box.bottom <= height + 1,
        `${label}: ${id} is outside viewport ${JSON.stringify(box)}`);
      await elementCenter(cdp, id); // Assert the real hit target is not occluded.
    }
    assert.ok(boxes.arena.height >= 100 && boxes.arena.width >= 200, `${label}: arena must remain usable`);
    const before = await callQa(cdp, "getSnapshot");
    const human = before.combat.fighters.find(f => f.controller === "p1");
    assert.equal(human.type, "AS", `${label}: Solar remains P1 whether attacking or defending`);
    assert.equal(before.combat.fighters.some(f => f.controller === "p2"), mode === "pvp");
    const origin = await elementCenter(cdp, "stick1");
    await assertEightWayTouch(cdp, touch, boxes.stick1, width, height, label);
    const direction = human.x > 480 ? -1 : 1;
    await touch.down(1, origin);
    await delay(60);
    const neutral = await callQa(cdp, "getSnapshot");
    assert.equal(neutral.input.touch.p1.x, 0, `${label}: floating joystick starts neutral under the finger`);
    await touch.move(1, {x: origin.x + direction * 34, y: origin.y});
    await touch.down(2, await elementCenter(cdp, "atk1"));
    await delay(2200);
    const moved = await callQa(cdp, "getSnapshot");
    const movedHuman = moved.combat?.fighters.find(f => f.controller === "p1");
    assert.ok(movedHuman, `${label}: human fighter remains in the duel`);
    assert.ok(moved.input.touch.p1.x * direction > 0.5, `${label}: two-thumb movement remains active while firing`);
    assert.ok((movedHuman.x - human.x) * direction > 2, `${label}: real touch moves the fighter while firing`);
    assert.ok(movedHuman.attackCount - human.attackCount >= 2, `${label}: held touch repeats basic fire after reload`);
    assert.equal(moved.audio.state, "running", `${label}: trusted touch should unlock audio`);
    const fireOrigin = await elementCenter(cdp, "atk1");
    await touch.move(2, {x:fireOrigin.x,y:fireOrigin.y-28});
    await delay(650);
    const aimed = await callQa(cdp, "getSnapshot");
    assert.ok(aimed.input.actions.p1ManualAim && aimed.input.actions.p1AimY < -0.8,
      `${label}: dragging the held fire thumb supplies independent manual aim`);
    assert.ok(aimed.combat.fighters.find(f=>f.controller==='p1').facingY < -0.8,
      `${label}: manual touch aim reaches actual fighter facing`);
    await touch.up(2);
    await delay(60);
    const releasedFire = await callQa(cdp, "getSnapshot");
    assert.equal(releasedFire.input.touchButtons.p1.attack, false, `${label}: the released fire pointer must be gone`);
    assert.ok(releasedFire.input.touch.p1.x * direction > 0.5,
      `${label}: releasing fire must not release the movement finger`);
    await touch.up(1);
    await waitForEval(cdp, `window.__CD_TEST__.getSnapshot().combat?.fighters.find(f=>f.controller==='p1')?.specialCooldown === 0`, 10000);
    const specialBefore = await callQa(cdp, "getSnapshot");
    await touch.down(1, origin);
    await touch.move(1, {x:origin.x + direction * 26, y:origin.y - 12});
    await touch.down(2, await elementCenter(cdp, "sp1"));
    await delay(300);
    const specialAfter = await callQa(cdp, "getSnapshot");
    assert.equal(specialAfter.combat.fighters.find(f=>f.controller==='p1').specialCount,
      specialBefore.combat.fighters.find(f=>f.controller==='p1').specialCount + 1,
      `${label}: second-thumb Special fires exactly once while moving`);
    await touch.up(2);
    assert.equal((await callQa(cdp, "getSnapshot")).input.touchButtons.p1.special, false,
      `${label}: the released special pointer must be gone`);
    // Actual third touch operates Pause while movement remains held.
    await touch.tap(await elementCenter(cdp, "pauseBtn"), 3);
    await delay(80);
    const paused = await callQa(cdp, "getSnapshot");
    assert.equal(paused.topState, "paused", `${label}: touch-only pause works during another gesture`);
    assert.equal(paused.input.touch.p1.x, 0, `${label}: pause clears held touch`);
    await delay(120);
    const heldPause = await callQa(cdp, "getSnapshot");
    assert.equal(heldPause.combat.nowMs, paused.combat.nowMs, `${label}: pause freezes combat timing`);
    await touch.move(1, {x:origin.x + 3,y:origin.y});
    await touch.up(1);
    await touch.tap(await elementCenter(cdp, "pauseBtn"));
    await delay(80);
    const resumed = await callQa(cdp, "getSnapshot");
    assert.equal(resumed.input.touch.p1.x, 0, `${label}: old touch must not reactivate after resume`);
    await touch.tap(await elementCenter(cdp, "combatHelp"));
    await delay(80);
    const help = await callQa(cdp, "getSnapshot");
    assert.equal(help.topState, "help", `${label}: combat sync must preserve Help`);
    assert.equal(help.combat.paused, true);
    await assertNativeHelpScroll(cdp, touch, label);
    await touch.tap(await elementCenter(cdp, "closeHelp", true));
    await delay(50);
    const dismissedHelp = await callQa(cdp, "getSnapshot");
    assert.equal(dismissedHelp.topState, "combatActive", `${label}: touch closes Help and restores the duel`);
    assert.equal(await evalJson(cdp, `() => document.getElementById("helpOverlay").classList.contains("active")`), false,
      `${label}: Help overlay must be gone before combat resumes`);
    if (mode === "pvp") {
      const p2Origin = await elementCenter(cdp, "stick2");
      await touch.down(1, origin);
      await touch.move(1, {x:origin.x + 24, y:origin.y});
      await touch.down(2, p2Origin);
      await touch.move(2, {x:p2Origin.x - 24, y:p2Origin.y});
      await delay(80);
      const twoPlayers = await callQa(cdp, "getSnapshot");
      assert.ok(twoPlayers.input.touch.p1.x > 0.3 && twoPlayers.input.touch.p2.x < -0.3,
        `${label}: both player sticks retain independent pointer ownership`);
      await touch.up(1);
      assert.ok((await callQa(cdp, "getSnapshot")).input.touch.p2.x < -0.3, `${label}: P1 release must not stop P2`);
      await touch.up(2);
    }
    await screenshot(cdp, `${label}.png`);
    // Rotate the live duel with a held thumb. A resize must cancel stale geometry
    // and pause, not silently redirect the player using the previous origin.
    await touch.down(1, origin);
    await touch.move(1, {x:origin.x + 24, y:origin.y});
    await setViewport(cdp, height, width, true);
    await delay(150);
    const rotated = await callQa(cdp, "getSnapshot");
    assert.equal(rotated.topState, "paused", `${label}: held rotation pauses safely`);
    assert.equal(rotated.input.touch.p1.x, 0, `${label}: held rotation clears the old stick`);
    await touch.cancel();
    await touch.tap(await elementCenter(cdp, "pauseBtn"));
    const rotatedOrigin = await elementCenter(cdp, "stick1");
    await touch.down(1, rotatedOrigin);
    await touch.move(1, {x:rotatedOrigin.x + 24, y:rotatedOrigin.y});
    await delay(70);
    assert.ok((await callQa(cdp, "getSnapshot")).input.touch.p1.x > 0.3, `${label}: new gesture works after rotation`);
    await touch.cancel();
    await screenshot(cdp, `${label}-rotated.png`);
    // A toolbar pointer can outlive its screen/session just like a joystick.
    // Simulate the lifecycle notification while Pause is physically held, then
    // release that old finger: it must not undo the automatic blur pause.
    await touch.down(1, await elementCenter(cdp, "pauseBtn"));
    await evalJson(cdp, `()=>{window.dispatchEvent(new Event('blur'));return true;}`);
    await touch.up(1);
    await delay(100);
    assert.equal((await callQa(cdp, "getSnapshot")).topState, "paused",
      `${label}: stale Pause release after blur must not resume combat`);
    await touch.tap(await elementCenter(cdp, "pauseBtn"));
    assert.equal((await callQa(cdp, "getSnapshot")).topState, "combatActive",
      `${label}: a genuinely new toolbar tap works after blur reset`);
    console.log(`- ${label}: real transition, held fire + move, Special, touch Pause/Help, ownership, rotation/reset, audio passed`);
  }
  await cdp.send("Emulation.setTouchEmulationEnabled", {enabled:false});
  await cdp.send("Emulation.clearDeviceMetricsOverride");
}

async function captureNormalTouchCombat(cdp, touch, label) {
  const before = await callQa(cdp, "getSnapshot");
  const fighter = before.combat.fighters.find(f=>f.controller==='p1');
  const stick = await elementCenter(cdp,"stick1");
  const fire = await elementCenter(cdp,"atk1");
  await touch.down(1,stick);
  await touch.move(1,{x:stick.x+(fighter.x>480?-24:24),y:stick.y});
  await touch.down(2,fire);
  await delay(250);
  const active = await callQa(cdp,"getSnapshot");
  assert.ok(active.combat?.fighters.find(f=>f.controller==='p1').attackCount>fighter.attackCount,
    `${label}: normal-HP native touch capture must show an accepted attack`);
  await screenshot(cdp,`${label}-normal-combat.png`);
  await touch.up(2);
  await touch.up(1);
  console.log(`- ${label}: normal-HP native-touch gameplay capture (no survival fixture)`);
}

async function assertNativeHelpScroll(cdp, touch, label) {
  const before = await evalJson(cdp, `()=>{
    const el=document.querySelector('.helpBox'), r=el.getBoundingClientRect();
    return {top:el.scrollTop,max:el.scrollHeight-el.clientHeight,x:r.x+r.width/2,y:Math.min(innerHeight-70,r.bottom-70)};
  }`);
  if (before.max < 30) return; // No overflow on a sufficiently tall viewport.
  const direction = before.top < before.max-25 ? -1 : 1;
  await touch.down(4, before);
  for (let step=1;step<=6;step+=1) {
    await touch.move(4,{x:before.x,y:before.y+direction*step*20});
    await delay(25);
  }
  await touch.up(4);
  await delay(160);
  const after = await evalJson(cdp, `()=>document.querySelector('.helpBox').scrollTop`);
  assert.ok(Math.abs(after-before.top)>20, `${label}: native touch swipe must scroll Help rules (${before.top} -> ${after})`);
}

async function runMobileNavigationCase(cdp, url) {
  await setViewport(cdp, 320, 568, true);
  await navigate(cdp, url);
  await waitForReady(cdp);
  const touch = new TouchSession(cdp);
  await touch.tap(await elementCenter(cdp, "newPVP", true));
  await waitForBoard(cdp, "portrait board scrolling");
  const inspect = `()=>{
    const card=document.querySelector('.sidePane .card'),r=card.getBoundingClientRect();
    const owners=[document.scrollingElement,document.getElementById('gameRoot'),document.getElementById('boardScreen'),document.querySelector('.sidePane')];
    return {scroll:owners.reduce((sum,el)=>sum+(el?.scrollTop||0),0)+(visualViewport?.pageTop||0),x:r.x+r.width/2,
      y:Math.min(innerHeight-30,r.bottom-20),top:r.top};
  }`;
  const before = await evalJson(cdp, inspect);
  assert.ok(before.y>before.top+15, "Portrait board must expose a non-canvas region for native scrolling");
  await touch.down(1,before);
  for(let step=1;step<=7;step+=1){await touch.move(1,{x:before.x,y:before.y-step*24});await delay(25);}
  await touch.up(1);
  await delay(150);
  const after=await evalJson(cdp,inspect);
  assert.ok(after.scroll>before.scroll+20 || after.top<before.top-20,
    `Portrait board status/actions must scroll natively (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
  await screenshot(cdp,"touch-portrait-board-scrolled.png");
  console.log("- portrait board: native touch pan reaches lower status/actions");
}

async function setViewport(cdp, width, height, mobile = Math.min(width, height) < 700) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
}

class TouchSession {
  constructor(cdp) { this.cdp = cdp; this.points = new Map(); }
  async send(type) {
    await this.cdp.send("Input.dispatchTouchEvent", {type, touchPoints:[...this.points.values()]});
  }
  async down(id, point) { this.points.set(id, {id, x:point.x, y:point.y}); await this.send("touchStart"); }
  async move(id, point) { this.points.set(id, {id, x:point.x, y:point.y}); await this.send("touchMove"); }
  async up(id) {
    const released = this.points.get(id);
    this.points.delete(id);
    // Current Chromium's synthetic-pointer path ends the explicitly listed
    // point (as Puppeteer's CdpTouchHandle.end does). Passing remaining points
    // releases the wrong finger; omitting a point in TouchMove does not end it.
    await this.cdp.send("Input.dispatchTouchEvent", {type:"touchEnd", touchPoints:released?[released]:[]});
  }
  async tap(point, id = 9) { await this.down(id, point); await delay(35); await this.up(id); await delay(50); }
  async cancel() { this.points.clear(); await this.send("touchCancel"); }
}

async function assertEightWayTouch(cdp, touch, box, width, height, label) {
  // Start near a natural lower/outer thumb contact, not the old idealized
  // fixed center. Reachable glass-edge throw must still provide full intent.
  const origin = {x:box.x+Math.min(18,box.width/2), y:box.y+box.height-12};
  for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
    await touch.down(1, origin);
    await touch.move(1, {x:Math.max(2,Math.min(width-2,origin.x+dx*40)),
      y:Math.max(2,Math.min(height-2,origin.y+dy*40))});
    const snapshot = await callQa(cdp, "getSnapshot");
    const vector = snapshot.input.touch.p1;
    assert.ok(Math.hypot(vector.x,vector.y)>0.85, `${label}: reachable ${dx},${dy} drag needs full movement: ${JSON.stringify(vector)}`);
    if (dx) assert.ok(vector.x*dx>0.3, `${label}: horizontal sign for ${dx},${dy}`);
    if (dy) assert.ok(vector.y*dy>0.3, `${label}: vertical sign for ${dx},${dy}`);
    await touch.up(1);
  }
}

async function elementCenter(cdp, id, scroll = false) {
  const point = await evalJson(cdp, `({id,scroll}) => {
    const el=document.getElementById(id); if(!el) return {error:'missing '+id};
    if(scroll) el.scrollIntoView({block:'nearest'});
    const r=el.getBoundingClientRect(), x=r.x+r.width/2,y=r.y+r.height/2;
    const top=document.elementFromPoint(x,y);
    return {x,y,width:r.width,height:r.height,visible:r.width>0&&r.height>0,hit:top===el||el.contains(top)};
  }`, {id,scroll});
  assert.ok(point.visible && point.hit, `${id}: expected an unobstructed visible control: ${JSON.stringify(point)}`);
  return point;
}

async function runGamepadCase(cdp, url) {
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  // The browser Gamepad API cannot create a physical controller. This fixture
  // tests sampled standard-mapping values through the real InputManager loop,
  // menus, board, and combat. It is not a hardware/controller compatibility claim.
  const fixture = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__CD_PADFIXTURE__=[{connected:true,axes:[0,0,0,0],buttons:[]}];
    Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>
      window.__CD_PADFIXTURE__.map((pad,index)=>pad?.connected?{
        id:'Circuit Dominion synthetic standard pad '+index,index,connected:true,mapping:'standard',timestamp:performance.now(),
        axes:pad.axes,buttons:Array.from({length:17},(_,i)=>({pressed:!!pad.buttons[i],touched:!!pad.buttons[i],value:pad.buttons[i]?1:0}))
      }:null)});
  ` });
  try {
    await navigate(cdp, url);
    await waitForReady(cdp);
    await delay(180);
    const boot = await callQa(cdp, "getSnapshot");
    assert.equal(boot.topState, "title", "Neutral controller must not skip the title");
    assert.equal(boot.input.gamepads[0]?.blocked, false, "Neutral controller should arm after discovery");
    let focused = "";
    for (let count = 0; count < 16 && focused !== "newPVP"; count += 1) {
      await pulsePad(cdp, 5);
      focused = await evalJson(cdp, `()=>document.activeElement?.id||''`);
    }
    assert.equal(focused, "newPVP", "Gamepad focus navigation must reach the PvP start button");
    await pulsePad(cdp, 0);
    await waitForBoard(cdp, "synthetic controller");
    await callQa(cdp, "setCommandCharge", ["S", 3]); // Only the earned-charge precondition is arranged.
    await pulsePad(cdp, 9);
    focused = await evalJson(cdp, `()=>document.activeElement?.id||''`);
    for (let count = 0; count < 12 && focused !== "gridLockBtn"; count += 1) {
      await pulsePad(cdp, 5);
      focused = await evalJson(cdp, `()=>document.activeElement?.id||''`);
    }
    assert.equal(focused, "gridLockBtn", "Controller can reach an available board command");
    await pulsePad(cdp, 0);
    let snapshot = await callQa(cdp, "getSnapshot");
    assert.ok(snapshot.boardAction, "Controller enters command targeting");
    const fluxRow = snapshot.board.findIndex(row => row.some(square => square.flux));
    const fluxCol = snapshot.board[fluxRow].findIndex(square => square.flux);
    await movePadCursor(cdp, fluxRow, fluxCol);
    await pulsePad(cdp, 0);
    snapshot = await callQa(cdp, "getSnapshot");
    assert.equal(snapshot.board[fluxRow][fluxCol].lockFaction, "S", "Command focus returns to the board so its target can be confirmed");
    assert.equal(snapshot.commandCharge.S, 2, "Real controller command spends exactly one charge");
    assert.equal(snapshot.turn, "V", "Command finishes the Solar turn");
    await movePadCursor(cdp, 0, 0);
    await pulsePad(cdp, 0);
    snapshot = await callQa(cdp, "getSnapshot");
    assert.ok(snapshot.selectedUnitId && hasLegalMove(snapshot, 4, 0), "Controller confirms a board unit");
    await movePadCursor(cdp, 4, 0);
    await pulsePad(cdp, 0);
    assertUnitAt(await callQa(cdp, "getSnapshot"), "EC", 4, 0, "controller board move");
    await movePadCursor(cdp, 8, 0);
    await pulsePad(cdp, 0);
    await movePadCursor(cdp, 4, 0);
    await pulsePad(cdp, 0);
    await waitForEval(cdp, `window.__CD_TEST__.getSnapshot().combat?.countdown===0`, 8000,
      "Controller hostile board selection enters combat");
    const before = await callQa(cdp, "getSnapshot");
    const p1 = before.combat.fighters.find(f=>f.controller==='p1');
    assert.equal(p1.type, "AS", "Controller one owns Solar when Solar is attacking");
    const direction = p1.x > 480 ? -1 : 1;
    await setPad(cdp, {axes:[direction,0,0,-1],buttons:{0:true}});
    await delay(2200);
    snapshot = await callQa(cdp, "getSnapshot");
    const acting = snapshot.combat?.fighters.find(f=>f.controller==='p1');
    assert.ok(acting && (acting.x-p1.x)*direction > 2, "Left stick moves the fighter");
    assert.ok(acting.attackCount-p1.attackCount>=2, "Held controller Attack repeats through reload");
    assert.ok(acting.facingY < -0.8, "Right stick explicitly aims independently from movement");
    await setPad(cdp, {connected:false});
    await delay(150);
    snapshot = await callQa(cdp, "getSnapshot");
    assert.equal(snapshot.topState, "paused", "Disconnecting a held controller pauses combat");
    assert.equal(snapshot.input.actions.p1MoveX, 0, "Disconnect clears controller movement");
    assert.equal(snapshot.input.actions.p1Attack, false, "Disconnect clears held fire");
    await setPad(cdp, {connected:true,axes:[1,0,0,0],buttons:{0:true}});
    await delay(150);
    snapshot = await callQa(cdp, "getSnapshot");
    assert.equal(snapshot.topState, "paused", "Reconnect-held cannot resume or confirm behind pause");
    assert.equal(snapshot.input.gamepads[0]?.blocked, true, "Reconnect requires neutral before arming");
    await setPad(cdp, {axes:[0,0,0,0],buttons:{}});
    await delay(100);
    await pulsePad(cdp, 9);
    assert.equal((await callQa(cdp, "getSnapshot")).topState, "combatActive", "Fresh Start resumes after neutral reconnect");
    await pulsePad(cdp, 3);
    assert.equal((await callQa(cdp, "getSnapshot")).topState, "help", "Controller Y opens combat Help");
    const helpScrollBefore=await evalJson(cdp,`()=>document.querySelector('.helpBox').scrollTop`);
    await pulsePad(cdp,13);
    const helpScrollAfter=await evalJson(cdp,`()=>document.querySelector('.helpBox').scrollTop`);
    assert.ok(helpScrollAfter>helpScrollBefore, "Controller D-pad scrolls Help rules rather than trapping focus on Close");
    await pulsePad(cdp, 1);
    assert.equal((await callQa(cdp, "getSnapshot")).topState, "combatActive", "Controller B closes Help");
    await setPad(cdp, {axes:[0,0,0,0],buttons:{},connected:true}, 1);
    await delay(100);
    await setPad(cdp, {axes:[1,0,0,0],buttons:{0:true}}, 0);
    await setPad(cdp, {axes:[-1,0,0,0],buttons:{0:true}}, 1);
    await delay(180);
    snapshot = await callQa(cdp, "getSnapshot");
    assert.ok(snapshot.input.actions.p1MoveX > 0.5 && snapshot.input.actions.p2MoveX < -0.5,
      "Two standard controllers retain independent PvP ownership");
    assert.ok(snapshot.input.actions.p1Attack && snapshot.input.actions.p2Attack,
      "Both controllers can fire simultaneously");
    await setPad(cdp, {axes:[0,0,0,0],buttons:{}}, 0);
    await setPad(cdp, {axes:[0,0,0,0],buttons:{}}, 1);
    await screenshot(cdp, "synthetic-controller-pvp.png");
    console.log("- synthetic standard gamepad: neutral boot, title navigation, board-to-duel, movement/manual aim/held fire, disconnect/reconnect, Help, two-player ownership passed (not physical hardware)");
  } finally {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {identifier:fixture.identifier});
  }
}

async function setPad(cdp, update, index = 0) {
  await evalJson(cdp, `({update,index})=>{
    const pads=window.__CD_PADFIXTURE__;
    pads[index]={connected:true,axes:[0,0,0,0],buttons:{},...pads[index],...update};
    return true;
  }`, {update,index});
}

async function pulsePad(cdp, button, heldMs = 90) {
  await setPad(cdp, {axes:[0,0,0,0],buttons:{[button]:true}});
  await delay(heldMs);
  await setPad(cdp, {axes:[0,0,0,0],buttons:{}});
  await delay(90);
}

async function movePadCursor(cdp, row, col) {
  for (let count = 0; count < 24; count += 1) {
    const {boardCursor} = await callQa(cdp, "getSnapshot");
    assert.ok(boardCursor, "QA snapshot must expose the actual controller board cursor");
    if (boardCursor.row === row && boardCursor.col === col) return;
    const button = boardCursor.row !== row ? (boardCursor.row > row ? 12 : 13) : (boardCursor.col > col ? 14 : 15);
    await pulsePad(cdp, button, 55);
  }
  throw new Error(`Controller board cursor could not reach ${row},${col}`);
}

async function runGameplayContinuation(cdp, label) {
  await clickBoardCell(cdp, 8, 0);
  await delay(150);
  const afterSelect = await callQa(cdp, "getSnapshot");
  assert.ok(hasLegalMove(afterSelect, 4, 0), `${label}: selecting Solar Arc Sniper should show A5 as a legal move`);

  await clickBoardCell(cdp, 4, 0);
  await delay(120);
  const afterMove = await callQa(cdp, "getSnapshot");
  assertUnitAt(afterMove, "AS", 4, 0, label);

  const asMatch = { type: "AS", row: 4, col: 0 };
  const ecMatch = { type: "EC", row: 0, col: 0 };
  const combatStart = await callQa(cdp, "startCombatByMatch", [asMatch, ecMatch, 0, 0]);
  await waitForEval(cdp, `document.querySelector(".screen.active")?.id === "combatScreen"`, 5000, `${label}: combat screen did not appear`);
  assert.ok(readCombat(combatStart), `${label}: arranged board attack should create combat state`);
  assert.equal(readCombat(combatStart).obstacles.length, 2, `${label}: duel should create mirrored projectile-blocking cover`);
  for (const fighter of readCombat(combatStart).fighters) {
    assert.equal(
      fighter.specialCooldown,
      fighter.specialCooldownMax * 0.5,
      `${label}: ${fighter.type} special should begin at half charge`,
    );
  }
  const combatScreenshot = await screenshot(cdp, `${label}-combat.png`);

  const aiStart = readCombat(combatStart).fighters.find((fighter) => fighter.controller === "ai");
  await waitForEval(cdp, `window.__CD_TEST__.getSnapshot().combat?.countdown === 0`, 15000,
    `${label}: combat countdown should finish before movement input`);
  await pressKey(cdp, "h", "KeyH", 72, 50);
  assert.equal((await callQa(cdp, "getSnapshot")).topState, "help", `${label}: keyboard Help pauses combat`);
  for(let tab=0;tab<8;tab+=1){
    await pressKey(cdp,"Tab","Tab",9,10);
    assert.equal(await evalJson(cdp,`()=>Boolean(document.activeElement?.closest('#helpOverlay'))`),true,
      `${label}: Tab focus must remain inside the open Help modal`);
  }
  const closeHelp = await elementCenter(cdp, "closeHelp", true);
  await click(cdp, closeHelp.x, closeHelp.y);
  assert.equal((await callQa(cdp, "getSnapshot")).topState, "combatActive", `${label}: mouse closes keyboard-opened Help`);
  const mute = await elementCenter(cdp, "combatMute");
  await click(cdp, mute.x, mute.y);
  await pressKey(cdp, "w", "KeyW", 87, 180);
  const afterFacingInput = await callQa(cdp, "getSnapshot");
  const humanAfterFacing = readCombat(afterFacingInput)?.fighters.find((fighter) => fighter.controller === "p1");
  const humanBeforeMove = readCombat(combatStart).fighters.find(fighter => fighter.controller === "p1");
  assert.ok(humanAfterFacing?.y < humanBeforeMove.y - 2, `${label}: keyboard movement moves the human independently from assisted aim`);
  const attacksBefore = humanAfterFacing.attackCount;
  await pressKey(cdp, " ", "Space", 32, 1300);
  const afterHeldFire = await callQa(cdp, "getSnapshot");
  assert.ok(afterHeldFire.combat?.fighters.find(f=>f.controller==='p1')?.attackCount >= attacksBefore+2,
    `${label}: held keyboard fire repeats after closing Help and clicking Mute (no focus trap)`);
  assert.equal(afterHeldFire.topState, "combatActive", `${label}: Space must not re-open a previously focused Help button`);
  await delay(1200);
  const afterKeyboard = await callQa(cdp, "getSnapshot");
  const aiAfter = readCombat(afterKeyboard)?.fighters.find((fighter) => fighter.controller === "ai");
  assert.ok(aiAfter, `${label}: PvAI combat should keep a Void AI fighter`);
  const aiMoved = Math.hypot((aiAfter.x || 0) - (aiStart.x || 0), (aiAfter.y || 0) - (aiStart.y || 0)) > 0.5;
  const aiActed = aiMoved || (aiAfter.attackCooldown || 0) > 0 || aiAfter.hp < aiStart.hp;
  assert.ok(aiActed, `${label}: Void AI should move or act after countdown`);

  await callQa(cdp, "resolveCombat", ["attacker"]);
  await waitForEval(cdp, `document.querySelector(".screen.active")?.id === "boardScreen"`, 5000, `${label}: combat should return to board`);
  const afterCombat = await callQa(cdp, "getSnapshot");
  assert.equal(readTopState(afterCombat), "board", `${label}: QA state should return to board after combat resolution`);

  await callQa(cdp, "setUnit", [{ type: "NO" }, { hp: 0, alive: false }]);
  const afterWin = await callQa(cdp, "evaluateCurrentWinners");
  await waitForEval(cdp, `document.querySelector(".screen.active")?.id === "endScreen"`, 5000, `${label}: command-unit win should show end screen`);
  assert.ok(["gameOver", "end"].includes(readTopState(afterWin)), `${label}: win state should be game-over/end`);
  assert.equal(readWinner(afterWin), "S", `${label}: Solar should win after Null Overlord is destroyed`);
  const winScreenshot = await screenshot(cdp, `${label}-win.png`);

  const restart = await evalJson(cdp, `(label) => {
    const btn = document.getElementById("endRestartAI");
    const rect = btn.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const top = document.elementFromPoint(center.x, center.y);
    return { label, center, topButton: top?.closest?.("button")?.id || "" };
  }`, label);
  assert.equal(restart.topButton, "endRestartAI", `${label}: restart button should be topmost at its center`);
  await click(cdp, restart.center.x, restart.center.y);
  await waitForEval(cdp, `document.querySelector(".screen.active")?.id === "boardScreen"`, 5000, `${label}: restart should return to board`);
  const afterRestart = await callQa(cdp, "getSnapshot");
  assert.equal(readTopState(afterRestart), "board", `${label}: restart should create a playable board state`);
  assert.ok(readUnits(afterRestart).length >= 18, `${label}: restart should restore the unit roster`);

  return { combatScreenshot, winScreenshot };
}

const menuDiagnosticsSource = `(label) => {
  const btn = document.getElementById("newAI");
  const rect = btn?.getBoundingClientRect();
  const center = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 };
  const top = document.elementFromPoint(center.x, center.y);
  const style = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      position: cs.position
    };
  };
  return {
    label,
    url: location.href,
    title: document.title,
    ready: document.documentElement.dataset.cdTestReady || "",
    activeScreens: [...document.querySelectorAll(".screen.active")].map((el) => el.id),
    overlays: [...document.querySelectorAll("#helpOverlay.active, #debugOverlay.active")].map((el) => el.id),
    button: {
      present: Boolean(btn),
      disabled: Boolean(btn?.disabled),
      text: btn?.innerText || "",
      rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
      center,
      styles: style(btn)
    },
    topAtButtonCenter: {
      tag: top?.tagName || "",
      id: top?.id || "",
      closestButtonId: top?.closest?.("button")?.id || "",
      text: top?.innerText || top?.textContent || "",
      styles: style(top)
    }
  };
}`;

const boardDiagnosticsSource = `(label) => {
  const board = document.getElementById("board");
  const rect = board.getBoundingClientRect();
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const top = document.elementFromPoint(center.x, center.y);
  return {
    label,
    activeScreens: [...document.querySelectorAll(".screen.active")].map((el) => el.id),
    boardCanvas: {
      width: board.width,
      height: board.height,
      clientWidth: board.clientWidth,
      clientHeight: board.clientHeight
    },
    topAtBoardCenter: {
      tag: top?.tagName || "",
      id: top?.id || "",
      closestCanvasId: top?.closest?.("canvas")?.id || ""
    },
    log: document.getElementById("log").textContent
  };
}`;

async function evalJson(cdp, fnSource, arg) {
  const expression = `JSON.stringify((${fnSource})(${JSON.stringify(arg)}))`;
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return JSON.parse(response.result.value);
}

async function callQa(cdp, action, args = []) {
  const expression = `JSON.stringify(window.__CD_TEST__[${JSON.stringify(action)}](...${JSON.stringify(args)}))`;
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || `QA action failed: ${action}`);
  }
  return JSON.parse(response.result.value);
}

async function clickBoardCell(cdp, row, col) {
  const point = await boardCellPoint(cdp, row, col);
  await click(cdp, point.x, point.y);
}

async function boardCellPoint(cdp, row, col) {
  const point = await evalJson(
    cdp,
    `({ row, col }) => {
      // The renderer owns board geometry (framed board with coordinate margin).
      const point = window.__CD_TEST__.boardCellClientPoint(row, col);
      return {
        x: point.x,
        y: point.y,
        topCanvas: document.elementFromPoint(point.x, point.y)?.closest?.("canvas")?.id || ""
      };
    }`,
    { row, col },
  );
  assert.equal(point.topCanvas, "board", `board cell ${row},${col} should be clickable`);
  return point;
}

function hasLegalMove(snapshot, row, col) {
  const moves = snapshot.legalMoves || snapshot.legal || [];
  return moves.some((move) => (move.row ?? move.r) === row && (move.col ?? move.c) === col);
}

function assertUnitAt(snapshot, type, row, col, label) {
  const unit = readUnits(snapshot).find((candidate) => candidate.type === type);
  assert.ok(unit, `${label}: ${type} should exist`);
  assert.equal(unit.row ?? unit.r, row, `${label}: ${type} row should update after real board click`);
  assert.equal(unit.col ?? unit.c, col, `${label}: ${type} column should update after real board click`);
}

function readUnits(snapshot) {
  return snapshot.units || [];
}

function readCombat(snapshot) {
  return snapshot.combat || null;
}

function readTopState(snapshot) {
  return snapshot.topState || snapshot.screen;
}

function readWinner(snapshot) {
  if (snapshot.winner === "S") {
    return "S";
  }
  if (typeof snapshot.winner === "string" && snapshot.winner.includes("Solar")) {
    return "S";
  }
  return snapshot.winner;
}

async function navigate(cdp, url) {
  const load = cdp.waitFor("Page.loadEventFired", () => true, 15000);
  await cdp.send("Page.navigate", { url });
  await load;
}

async function waitForReady(cdp) {
  await waitForEval(cdp, `document.readyState === "complete" && Boolean(document.getElementById("newAI"))`);
}

async function waitForBoard(cdp, label) {
  await waitForEval(
    cdp,
    `document.querySelector(".screen.active")?.id === "boardScreen" && document.getElementById("board").clientWidth > 0`,
    8000,
    `${label}: board did not become active`,
  );
}

async function waitForEval(cdp, expression, timeoutMs = 10000, message = `Timed out waiting for ${expression}`) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (response.result.value) {
      return;
    }
    await delay(100);
  }
  throw new Error(message);
}

async function click(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function pressSpace(cdp) {
  await pressKey(cdp, " ", "Space", 32, 120);
}

async function pressKey(cdp, key, code, keyCode, heldMs = 120) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
  });
  await delay(heldMs);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
  });
}

async function screenshot(cdp, name) {
  const response = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(SCREENSHOT_DIR, name);
  await writeFile(file, response.data, "base64");
  return file;
}

async function createPage(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Unable to create Chrome page: HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForHttp(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  // Chrome helpers can inherit output pipes after the parent exits. Waiting
  // for `close` then hangs cleanup; bound the wait on the owned parent instead.
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(1000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  child.stdout?.destroy();
  child.stderr?.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
