// SPDX-License-Identifier: GPL-3.0-or-later
// Additional terms under GPL-3.0 section 7 apply; see NOTICE.md.
export function updateDebugSnapshot(game, input, combat) {
  game.debug.inputSnapshot = input.getSnapshot();

  if (combat) {
    game.debug.combat = {
      state: combat.state,
      countdown: combat.countdown,
      fighters: combat.fighters.map((f) => ({
        id: f.id,
        type: f.unit.type,
        hp: Number(f.hp.toFixed(2)),
        state: f.state,
        controller: f.controller,
      })),
      projectileCount: combat.projectiles.length,
    };
  } else {
    game.debug.combat = null;
  }
}

export function fpsMeter() {
  let last = performance.now();
  return () => {
    const now = performance.now();
    const frameMs = now - last;
    last = now;
    return { fps: frameMs > 0 ? 1000 / frameMs : 0, frameMs };
  };
}
