# ZELDO · Mosslight — The Hollow Crown

A complete, procedural 3D woodland adventure. Explore six areas of Larkspur Valley, cross the creek, discover Emberstone Hollow, find a brass key, defeat the Cinder Warden, and recover the Hollow Crown.

## Run

Requires Node.js 20.9 or newer.

```bash
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000). For a production build:

```bash
npm run build
npm start
```

## Controls

| Action | Controls |
| --- | --- |
| Start / retry | Enter or the start button |
| Move | WASD or arrow keys |
| Swing sword | Space (hold to repeat) or click the world |
| Enter / return / open chest / read sign | E |
| Pause | Escape or P |
| Mute | M |
| Map | Tab |

Phones have an analog movement joystick on the left, with sword and interaction buttons on the right. Drag a little to walk slowly or farther to run. The toolbar includes instructions, sound, pause, and fullscreen controls. Fullscreen depends on browser support; both portrait and landscape work without it. Opening the map or instructions pauses play, and closing them resumes it.

## Your quest

Follow the sandy path east from Willow Home, turn north across the wooden bridge, then follow the far bank east and the path north to the rocky arch. Press E near the arch to enter the dungeon. Approach the western pedestal in Lantern Hall to collect the key, then approach the northern gate to unlock it automatically. Defeat the Cinder Warden and open the chest at the north wall with E to finish.

The Warden pursues around obstacles, telegraphs its charge, and regularly fires aimed embers after a short visual and audio warning. Its embers pass through cover, so keep moving even behind pillars. At half health it attacks faster and fires a spread of three embers. Dodge the marked direction, then strike during recovery; repeated sword attacks cannot lock it in hitstun. Pots and the key pedestal are solid. Break pots with the sword to clear them.

Grass and clay pots can drop hearts or gems. You have three hearts, and home is a safe haven. Regular monsters return after about twenty seconds; defeated dungeon enemies and the boss stay defeated for the run. Retrying starts a new adventure.

## Implementation

- **Next.js App Router, React, TypeScript, Tailwind CSS**: the shell and HUD.
- **Babylon.js**: all 3D geometry, lighting, directional shadows, animation, and particles. Static geometry is batched by shared material and spatial region. Every asset is generated in code; there are no fetched textures, models, fonts, or audio files.
- **Zustand**: serializable player, enemies, pickups, effects, quest state, seeded randomness, and room snapshots.
- **Pure simulation**: `game/simulation.ts` advances at a fixed 60 Hz. Frame accumulation lives in the canvas lifecycle; simulation time stops on pause and while the tab is hidden. Collision includes axis sliding, substeps for fast knockback, solid pots and pedestals, and solid body separation. Pursuing enemies use radius-aware tile-grid A* with cached routes, including dynamic obstacles.
- **RPG HUD**: a terrain-accurate minimap marks the player, living enemies, boss, and quest locations. The objective tracker advances through entrance, key, gate, boss, and treasure. The performance panel samples twice per second: FPS, average frame interval, draw calls, active meshes, and submitted triangles. Draw calls and triangles include shadow passes. Minimap updates are sampled separately from rendering.
- **Web Audio**: handmade synthesized effects, unlocked by the first user gesture.

The renderer reads the store and never decides gameplay. `world.ts` describes the six-screen overworld and two-room dungeon. The React UI owns title, pause, game-over, victory, map, and instructions overlays.

## Verify

```bash
npm run typecheck
npm test
npm run build
```

The tests cover deterministic simulation, spawn protection, obstacle and water collision, combat separation, hitstun and invulnerability, pickup magnetism, breakable rewards, monster respawn, zone persistence, pathfinding, automatic gate unlocking, boss attack telegraphs and projectiles, and the complete key → gate → boss → chest quest.
