// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Renderer } from "../src/render.js";
import { AssetManager } from "../src/assets.js";
import { buildArenaObstacles, projectileHitsObstacle } from "../src/combat.js";

const manifest = JSON.parse(await readFile(new URL("../assets/live/manifest.json", import.meta.url)));
const covers = manifest.assets.filter(asset => asset.type === "environment-sprite");
assert.equal(covers.length, 2);
const bytes = [];
for (const asset of covers) {
  const png = await readFile(new URL(`../${asset.path}`, import.meta.url));
  bytes.push(png);
  assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), asset.nativeWidth);
  assert.equal(png.readUInt32BE(20), asset.nativeHeight);
  assert.equal(png[25], 6, "Cover source must retain RGBA transparency");
  const s = asset.sourceRect;
  assert.ok(s.x >= 0 && s.y >= 0 && s.width > 0 && s.height > 0);
  assert.ok(s.x + s.width <= asset.nativeWidth && s.y + s.height <= asset.nativeHeight);
  assert.ok(Math.abs((s.width / s.height) / (asset.drawWidth / asset.drawHeight) - 1) < 0.08,
    "Source silhouette should match gameplay proportions without major stretching");
}
assert.ok(!bytes[0].equals(bytes[1]), "Horizontal/vertical assets must be distinct");

globalThis.Image = class {
  addEventListener(type, listener) { this[type] = listener; }
  set src(value) { this.url = value; }
};
const loader = Object.create(AssetManager.prototype);
Object.assign(loader, { assets: new Map(), images: new Map(), warned: new Set() });
loader.registerManifest({ assets: covers });
for (const asset of covers) {
  assert.equal(loader.getImage(asset.id), null, "Not-yet-loaded art uses fallback");
  const state = loader.images.get(asset.id);
  assert.ok(state, "Environment sprites must be registered with the image loader");
  state.image.load();
  assert.equal(loader.getImage(asset.id), state.image);
  globalThis.__CD_INLINE_ASSETS__ = { dataUris: { [asset.path]: "data:image/png;base64,test" } };
  assert.equal(loader.resolveAssetUrl(asset.path), "data:image/png;base64,test");
  delete globalThis.__CD_INLINE_ASSETS__;
}

const expected = {
  L: [{ x:315, y:190, width:92, height:54 }, { x:553, y:276, width:92, height:54 }],
  D: [{ x:315, y:276, width:92, height:54 }, { x:553, y:190, width:92, height:54 }],
  N: [{ x:442, y:92, width:76, height:112 }, { x:442, y:316, width:76, height:112 }],
};
function render(obstacle, energy, assets) {
  const calls = [];
  const ctx = new Proxy({}, { get: (target, name) => target[name] ?? ((...args) => calls.push([name, ...args])),
    set: (target, name, value) => { target[name] = value; return true; } });
  const original = JSON.stringify(obstacle);
  Renderer.prototype.drawCover.call({ arenaCtx: ctx, assets }, obstacle, energy);
  assert.equal(JSON.stringify(obstacle), original, "Rendering must not mutate collision data");
  assert.equal(calls.filter(c=>c[0]==="save").length, calls.filter(c=>c[0]==="restore").length);
  return calls;
}
for (const energy of ["L", "D", "N"]) {
  const obstacles = buildArenaObstacles(energy);
  assert.deepEqual(obstacles, expected[energy], "Cover art must not change collision geometry");
  for (const obstacle of obstacles) {
    const id = `environment.cover-${obstacle.width > obstacle.height ? "horizontal" : "vertical"}`;
    const asset = loader.getAsset(id);
    const source = asset.sourceRect;
    const calls = render(obstacle, energy, loader);
    assert.deepEqual(calls.find(c=>c[0]==="drawImage"), ["drawImage", loader.getImage(id),
      source.x, source.y, source.width, source.height, obstacle.x, obstacle.y, obstacle.width, obstacle.height]);
    assert.ok(!calls.some(c=>c[0]==="fillText"), "Loaded art must not retain the placeholder COVER label");
    const fallback = render(obstacle, energy, null);
    assert.ok(!fallback.some(c=>c[0]==="drawImage"));
    assert.ok(fallback.some(c=>c[0]==="fillText" && c[1]==="COVER"));
    assert.ok(fallback.some(c=>c[0]==="clip"), "Fallback hatching stays inside the footprint");
    assert.equal(projectileHitsObstacle({ x:obstacle.x+obstacle.width/2, y:obstacle.y+obstacle.height/2, radius:1 }, obstacles), true);
  }
}
const failed = loader.images.get(covers[0].id);
failed.loaded = false;
loader.warnOnce = () => {};
failed.image.error();
assert.equal(failed.failed, true);
assert.equal(loader.getImage(covers[0].id), null, "Failed image must expose the same fallback path");
assert.ok(render(expected.L[0], "L", loader).some(c=>c[0]==="fillText" && c[1]==="COVER"));
console.log("cover-art-tests: ok (PNG metadata, loader/embedded/failure paths, 3 polarities, exact footprints, fallback and projectile blocking)");
