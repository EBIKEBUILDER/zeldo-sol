# ZELDO — The Hollow Crown

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
| Enter / leave dungeon | Walk into the doorway |
| Open chest / read sign | E |
| Pause | Escape or P |
| Mute | M |
| Map | Tab |

Phones have an analog movement joystick on the left, with sword and interaction buttons on the right. Drag a little to walk slowly or farther to run. The toolbar includes instructions, sound, pause, and fullscreen controls. Fullscreen depends on browser support; both portrait and landscape work without it. Opening the map or instructions pauses play, and closing them resumes it.

## Your quest

Follow the sandy path east from Willow Home, turn north across the wooden bridge, then follow the far bank east and the path north to the rocky arch. Walk into the arch to enter the dungeon; walk back into the southern doorway to leave. Approach the western pedestal in Lantern Hall to collect the key, then approach the northern gate to unlock it automatically. Defeat the Cinder Warden and open the chest at the north wall with E to finish.

The Warden pursues around obstacles and marks a wide orange path before lunging. The dash cannot be damaged, interrupted, or knocked back; dodge sideways and strike during recovery. At range, or when cover blocks its approach, it marks a landing area and lobs an ember over obstacles. The impact splashes burning embers across the marked circle for a short time, so move away from the glowing ground. At half health it attacks faster and throws three embers. Pots and the key pedestal are solid. Break pots with the sword to clear them.

Grass and clay pots can drop hearts or gems. You have three hearts, and home is a safe haven. Regular monsters return after about twenty seconds; defeated dungeon enemies and the boss stay defeated for the run. Retrying starts a new adventure.

## Implementation

- **Next.js App Router, React, TypeScript, Tailwind CSS**: the shell and HUD.
- **Babylon.js**: all 3D geometry, lighting, directional shadows, animation, and particles. Static geometry is batched by shared material and spatial region. Every asset is generated in code; there are no fetched textures, models, fonts, or audio files.
- **Zustand**: serializable player, enemies, pickups, effects, quest state, seeded randomness, and room snapshots.
- **Pure simulation**: `game/simulation.ts` advances at a fixed 60 Hz. Frame accumulation lives in the canvas lifecycle; simulation time stops on pause and while the tab is hidden. Collision includes axis sliding, substeps for fast knockback, solid pots and pedestals, and solid body separation. Pursuing enemies use radius-aware tile-grid A* with cached routes, including dynamic obstacles.
- **RPG HUD**: a terrain-accurate minimap marks the player, living enemies, boss, and quest locations. The objective tracker advances through entrance, key, gate, boss, and treasure. The performance panel samples twice per second: FPS, average frame interval, draw calls, active meshes, and submitted triangles. Draw calls and triangles include shadow passes. Minimap updates are sampled separately from rendering.
- **Web Audio**: handmade synthesized effects and three original looping themes: a bright overworld melody, a mysterious dungeon arrangement, and driving boss battle music. Music fades between areas and starts when the Warden engages; pause, map/help overlays, hidden tabs, and the sound toggle silence it. Audio unlocks on the first user gesture, with no fetched music assets.

The renderer reads the store and never decides gameplay. `world.ts` describes the six-screen overworld and two-room dungeon. The React UI owns title, pause, game-over, victory, map, and instructions overlays.

During local development, the current run survives code refreshes and tab switches. This recovery is limited to the preview tab; published games still start a fresh adventure on reload.

## Verify

```bash
npm run typecheck
npm test
npm run build
```

The tests cover deterministic simulation, spawn protection, obstacle and water collision, combat separation, hitstun and invulnerability, pickup magnetism, breakable rewards, monster respawn, zone persistence, pathfinding, automatic gate unlocking, boss attack telegraphs and projectiles, and the complete key → gate → boss → chest quest.
