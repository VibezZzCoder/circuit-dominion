// SPDX-License-Identifier: GPL-3.0-or-later

const MANIFEST_URL = new URL("../assets/live/manifest.json", import.meta.url);

export class AssetManager {
  constructor() {
    this.assets = new Map();
    this.images = new Map();
    this.warned = new Set();
    this.ready = this.loadManifest();
  }

  async loadManifest() {
    try {
      const response = await fetch(MANIFEST_URL);
      if (!response.ok) {
        this.warnOnce("manifest", `Asset manifest unavailable: HTTP ${response.status}`);
        return;
      }
      const manifest = await response.json();
      for (const asset of manifest.assets || []) {
        this.assets.set(asset.id, asset);
        if (asset.path && (asset.type === "background" || asset.type === "unit-sprite" || asset.type === "sprite-sheet")) {
          this.loadImage(asset);
        }
      }
    } catch (error) {
      this.warnOnce("manifest", `Asset manifest unavailable: ${error.message}`);
    }
  }

  loadImage(asset) {
    const image = new Image();
    const imageState = { image, loaded: false, failed: false, asset };
    this.images.set(asset.id, imageState);
    image.addEventListener(
      "load",
      () => {
        imageState.loaded = true;
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        imageState.failed = true;
        this.warnOnce(asset.id, `Asset failed to load: ${asset.path}. Using ${asset.fallbackRendererId || "procedural fallback"}.`);
      },
      { once: true },
    );
    image.src = new URL(`../${asset.path}`, import.meta.url).href;
  }

  getImage(id) {
    const state = this.images.get(id);
    if (!state) {
      return null;
    }
    if (state.loaded) {
      return state.image;
    }
    if (state.failed) {
      return null;
    }
    return null;
  }

  getUnitImage(unitType) {
    return this.getImage(`unit.${unitType}`);
  }

  getAsset(id) {
    return this.assets.get(id) || null;
  }

  applyTitleBackgrounds(root = document.documentElement) {
    const landscape = this.getAsset("background.title-landscape");
    const portrait = this.getAsset("background.title-portrait");
    if (landscape) {
      root.style.setProperty("--title-bg-landscape", `url("${new URL(`../${landscape.path}`, import.meta.url).href}")`);
    }
    if (portrait) {
      root.style.setProperty("--title-bg-portrait", `url("${new URL(`../${portrait.path}`, import.meta.url).href}")`);
    }
  }

  warnOnce(id, message) {
    if (this.warned.has(id)) {
      return;
    }
    this.warned.add(id);
    console.warn(`[Circuit Dominion] ${message}`);
  }
}
