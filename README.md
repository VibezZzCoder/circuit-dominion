# Circuit Dominion

Browser game inspired by the gameplay structure of classic board-strategy/action-duel games like Archon, but with an original AI robots theme, original units, original names, original visuals, and no copyrighted assets.

Circuit Dominion is a tactical 9x9 board strategy game with real-time duel resolution between robot factions:
- Solar Protocol
- Void Core

## Project Structure

- `index.html`: source entry point
- `src/`: gameplay, combat, rendering, input, UI, AI, platform, state modules
- `styles/main.css`: styling and responsive layout
- `release/`: single-file with all code merged `circuit_dominion.single-file.html`

## Play it here

https://vibezzzcoder.github.io/circuit-dominion/

or play the single-file build, which is available inside the release folder.

## Controls

### Board
- Mouse/touch: select unit and destination square
- `H`: open help
- `R`: restart current mode
- `` ` ``: toggle debug overlay

### Duel
- Solar (P1):
  - Move: `WASD`
  - Attack: `Space` or `F`
  - Special: `Left Shift`
- Void (P2 in PvP):
  - Move: Arrow keys
  - Attack: `Enter` or `/`
  - Special: `Right Shift`
- Mobile touch:
  - Virtual stick + Attack/Special buttons
- `Esc`: pause/resume duel

## Game Modes

- Player vs AI
- Player vs Player

PvAI invariant: human always controls Solar in duels; AI always controls Void, regardless of who initiated combat.

## Win Conditions

- Destroy enemy Command Unit
- Occupy all Power Nodes at end of turn

## Unit List

### Solar Protocol
- Core Commander
- Photon Striker
- Arc Sniper
- Shield Drone
- Pulse Medic
- Nova Walker

### Void Core
- Null Overlord
- Razor Crawler
- Entropy Cannon
- Glitch Wraith
- Corruptor Bot
- Gravity Bruiser

## Polarity and Power Nodes

Board squares are:
- ☀ Light Grid
- ◆ Dark Grid
- ◇ Neutral Grid

Combat modifiers:
- Aligned polarity: +15% HP and damage
- Hostile polarity: -10% damage
- Neutral: no modifier

Unstable squares rotate polarity every 3 turns.

## License

Circuit Dominion is licensed under the GNU General Public License v3.0 or later.

You may play, study, modify, share, redistribute, and host this game under the terms of the GPL-3.0-or-later license.

If you distribute modified versions, you must provide the corresponding source code and keep the work under GPL-compatible terms.

The GPL permits commercial distribution, but it does not permit taking away recipients’ GPL rights. Anyone who receives a copy must retain the freedom to inspect, modify, and redistribute it.

Unless otherwise noted, this license applies to the entire project, including code, generated visuals, procedural audio, UI text, faction names, unit names, and game content.
