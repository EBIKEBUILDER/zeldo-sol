import {
  CHEST_POSITION,
  DUNGEON_ENTRANCE,
  GATE_POSITION,
  KEY_POSITION,
  type Breakable,
  type Enemy,
  type Tile,
  type WorldData,
  type WorldObject,
  type Zone,
} from './types';

const variation = (x: number, z: number) => {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

function onPath(x: number, z: number, margin = 1.7) {
  return (
    (x >= 7 && x <= 25 && Math.abs(z - 5) <= margin) ||
    (z >= 5 && z <= 20 && Math.abs(x - 25) <= margin) ||
    (x >= 25 && x <= 42 && Math.abs(z - 20) <= margin) ||
    (z >= 20 && z <= 28 && Math.abs(x - 42) <= margin)
  );
}

function makeOverworld(): WorldData {
  const tiles: Tile[] = [];
  const objects: WorldObject[] = [];
  const add = (object: Omit<WorldObject, 'id'>, id?: string) => {
    objects.push({ ...object, id: id ?? `overworld-${object.kind}-${objects.length}` });
  };

  for (let z = 0; z < 32; z++) {
    for (let x = 0; x < 48; x++) {
      let kind: Tile['kind'] = 'grass';
      if (onPath(x, z, 1)) kind = 'path';
      if (z >= 13 && z <= 15) kind = x >= 23 && x <= 27 ? 'bridge' : 'water';
      if (x >= 37 && z >= 23 && kind !== 'path') kind = 'stone';
      tiles.push({ x, z, kind, variant: Math.floor(variation(x, z) * 4) });
    }
  }

  // The boundary reads as a continuous forest, with occasional rocks and hedges.
  for (let x = 1; x < 48; x += 2) {
    add({ kind: 'tree', x, z: 0, scale: 0.95 + variation(x, 0) * 0.35, solid: { r: 0.72 } });
    add({ kind: x > 35 ? 'rock' : 'tree', x, z: 31, scale: 1 + variation(x, 31) * 0.4, solid: { r: 0.85 } });
  }
  for (let z = 2; z < 31; z += 2) {
    if (z >= 12 && z <= 16) continue;
    add({ kind: 'tree', x: 0, z, scale: 1.1, solid: { r: 0.75 } });
    add({ kind: z > 20 ? 'rock' : 'tree', x: 47, z, scale: 1.2, solid: { r: 0.8 } });
  }

  const groves = [
    [4, 20], [10, 25], [14, 21], [19, 26], [33, 8], [40, 8], [43, 3],
    [4, 10], [14, 10], [18, 9], [30, 28], [34, 25], [31, 4],
  ];
  for (const [cx, cz] of groves) {
    for (let i = 0; i < 6; i++) {
      const angle = i * 2.399;
      const distance = 1.3 + (i % 3) * 0.9;
      const x = cx + Math.cos(angle) * distance;
      const z = cz + Math.sin(angle) * distance;
      if (x < 1 || x > 46 || z < 1 || z > 30 || (z > 11.4 && z < 16.7) || onPath(x, z)) continue;
      if (Math.hypot(x - 8, z - 5) < 4.6) continue;
      add({ kind: 'tree', x, z, scale: 0.8 + variation(x, z) * 0.5, rotation: variation(z, x) * Math.PI * 2, solid: { r: 0.63 } });
    }
  }

  add({ kind: 'house', x: 6, z: 8.6, scale: 1, solid: { w: 3.6, d: 2.8 } }, 'willow-cottage');
  add({ kind: 'bench', x: 3.7, z: 5.1, rotation: 0.3, solid: { w: 1.6, d: 0.65 } });
  add({ kind: 'sign', x: 10.8, z: 6.8, rotation: 0.1 }, 'sign-home');
  add({ kind: 'sign', x: 22.5, z: 11.2 }, 'sign-crossing');
  add({ kind: 'sign', x: 40, z: 21.8 }, 'sign-dungeon');
  add({ kind: 'banner', x: 40.2, z: 27.1, rotation: -0.08 });
  add({ kind: 'arch', ...DUNGEON_ENTRANCE, scale: 1.15 }, 'dungeon-entrance');
  add({ kind: 'torch', x: 40.6, z: 26.8 });
  add({ kind: 'torch', x: 43.4, z: 26.8 });

  for (const [x, z, scale] of [
    [38.5, 25, 1.4], [39, 28.2, 1.3], [40.4, 29, 1.1], [42.2, 29.4, 1.5],
    [44, 29, 1.2], [45, 27.6, 1.4], [45.1, 24.6, 1.2], [35.5, 22.5, 1],
    [29, 10, 0.9], [20.4, 3, 0.7], [16.2, 28.6, 0.8], [7.7, 21.2, 0.9],
  ]) add({ kind: 'rock', x, z, scale, rotation: variation(x, z) * 6.28, solid: { r: scale * 0.65 } });

  for (let z = 7; z <= 10; z++) add({ kind: 'hedge', x: 11.8, z, scale: 0.85, solid: { w: 0.9, d: 1.05 } });
  for (let x = 14; x < 20; x++) add({ kind: 'hedge', x, z: 1.5, scale: 0.75, solid: { w: 1.04, d: 0.9 } });

  for (let i = 0; i < 85; i++) {
    const x = 2 + variation(i, 9) * 43;
    const z = 2 + variation(i, 16) * 27;
    if ((z > 11.8 && z < 16.3) || onPath(x, z, 1.3) || (x > 37 && z > 23)) continue;
    add({ kind: i % 7 === 0 ? 'mushroom' : 'flowers', x, z, scale: 0.7 + variation(i, 6) * 0.6, rotation: variation(i, 3) * 6.28, variant: i % 4 });
  }
  for (let x = 3; x <= 45; x += 3.5) {
    if (x >= 22 && x <= 28) continue;
    add({ kind: 'reeds', x, z: 12.1, scale: 0.8 + variation(x, 2) * 0.5 });
    add({ kind: 'reeds', x: x + 0.4, z: 16, scale: 0.7 + variation(x, 4) * 0.5 });
  }
  add({ kind: 'stump', x: 12.3, z: 25.4, scale: 0.85, solid: { r: 0.55 } });
  add({ kind: 'stump', x: 35, z: 11, scale: 0.75, solid: { r: 0.5 } });
  return { width: 48, height: 32, tiles, objects };
}

function makeDungeon(): WorldData {
  const tiles: Tile[] = [];
  const objects: WorldObject[] = [];
  const add = (object: Omit<WorldObject, 'id'>, id?: string) => objects.push({ ...object, id: id ?? `dungeon-${object.kind}-${objects.length}` });
  for (let z = 0; z < 36; z++) {
    for (let x = 0; x < 24; x++) tiles.push({ x, z, kind: 'stone', variant: Math.floor(variation(x, z) * 4) });
  }
  for (let x = 0; x < 24; x++) {
    add({ kind: 'wall', x, z: 0, solid: { w: 1.06, d: 1.1 } });
    add({ kind: 'wall', x, z: 35, solid: { w: 1.06, d: 1.1 } });
  }
  for (let z = 1; z < 35; z++) {
    add({ kind: 'wall', x: 0, z, solid: { w: 1.1, d: 1.06 } });
    add({ kind: 'wall', x: 23, z, solid: { w: 1.1, d: 1.06 } });
  }
  for (let x = 1; x < 23; x++) {
    if (x >= 10 && x <= 14) continue;
    add({ kind: 'wall', x, z: 17, solid: { w: 1.06, d: 1.2 } });
  }
  add({ kind: 'gate', ...GATE_POSITION, solid: { w: 5.2, d: 1.1 } }, 'boss-gate');
  add({ kind: 'pedestal', ...KEY_POSITION, scale: 1, solid: { w: 1.05, d: 1.05 } }, 'key-pedestal');
  add({ kind: 'arch', x: 12, z: 2, scale: 0.85 }, 'return-arch');
  add({ kind: 'chest', ...CHEST_POSITION, solid: { w: 1.8, d: 1.15 } }, 'ember-chest');
  for (const [x, z] of [[2, 5], [21, 5], [2, 13], [21, 13], [2, 21], [21, 21], [2, 30], [21, 30], [9, 17], [15, 17]]) {
    add({ kind: 'torch', x, z });
  }
  for (const [x, z] of [[4, 5], [20, 5], [4, 13], [20, 13], [4, 23], [20, 23], [4, 31], [20, 31]]) {
    add({ kind: 'rock', x, z, scale: 0.85, rotation: variation(x, z) * 6.28, solid: { r: 0.58 } });
  }
  add({ kind: 'banner', x: 8.3, z: 33.6, rotation: 0.05, variant: 1 });
  add({ kind: 'banner', x: 15.7, z: 33.6, rotation: -0.05, variant: 1 });
  return { width: 24, height: 36, tiles, objects };
}

const worlds: Record<Zone, WorldData> = { overworld: makeOverworld(), dungeon: makeDungeon() };

/** Static, hand-placed world geometry. The simulation owns all mutable entities. */
export const getWorld = (zone: Zone): WorldData => worlds[zone];

export function createEnemies(zone: Zone): Enemy[] {
  const placements = zone === 'overworld'
    ? [[17, 5], [21, 10], [31, 6], [42, 10], [8, 23], [18, 20], [28, 23], [34, 20], [41, 24]]
    : [[14, 10], [18, 14], [8, 23], [17, 24], [12, 27]];
  return placements.map(([x, z], i) => {
    const boss = zone === 'dungeon' && i === placements.length - 1;
    return {
      id: `${zone}-${boss ? 'boss' : 'blob'}-${i}`, x, z, homeX: x, homeZ: z, vx: 0, vz: 0,
      hp: boss ? 12 : 2, maxHp: boss ? 12 : 2, alive: true, boss,
      hitstun: 0, flash: 0, contactCooldown: 0, respawn: 0,
      wanderAngle: i * 2.399, wanderTime: 1 + i * 0.15, lastAttack: -4,
      navigation: { path: [], index: 0, repath: 0, targetX: x, targetZ: z, stuck: 0, chasing: false },
      attackMode: 'pursue', attackTimer: 0, rangedCooldown: 1.15, damageCooldown: 0, aimX: x, aimZ: z, phase: 1,
    };
  });
}

export function createBreakables(zone: Zone): Breakable[] {
  const positions = zone === 'overworld' ? [
    [12, 3], [13, 3.6], [14, 3], [16, 7], [17, 7.5], [20, 8], [28.5, 5], [29.2, 5.8],
    [35, 5], [36, 5.6], [38, 11], [39, 11.6], [22, 17.8], [21, 18.4], [28, 18.2],
    [29, 18.6], [8, 19], [8.7, 19.6], [11, 27], [11.8, 27.5], [19, 22], [19.8, 22.7],
    [31, 21.9], [32, 22.4], [37, 18.2], [38, 18.6], [44, 22], [44, 23],
    [4.3, 7], [8.7, 8.7],
  ] : [
    [3, 3], [4, 3], [20, 3], [21, 3], [5, 10], [5, 11], [19, 9], [20, 9],
    [3, 15], [20, 15], [3, 19], [20, 19], [6, 30], [18, 30],
  ];
  return positions.map(([x, z], i) => ({ id: `${zone}-breakable-${i}`, x, z, kind: zone === 'dungeon' || i >= positions.length - 2 ? 'pot' : 'grass', alive: true }));
}

export function areaName(zone: Zone, x: number, z: number): string {
  if (zone === 'dungeon') return z < 17 ? 'Lantern Hall' : 'Heart of Ember';
  const names = z < 16
    ? ['Willow Home', 'Honeygrass Meadow', 'Sunleaf Grove']
    : ['Fernwood', 'Old Crossing', 'Emberstone Rise'];
  return names[Math.min(2, Math.max(0, Math.floor(x / 16)))];
}
