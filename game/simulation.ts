import type { SoundName } from './audio';
import {
  CHEST_POSITION,
  DUNGEON_ENTRANCE,
  DUNGEON_SPAWN,
  GATE_POSITION,
  KEY_POSITION,
  OVERWORLD_SPAWN,
  type Effect,
  type Enemy,
  type GameData,
  type GameInput,
  type Pickup,
  type Status,
  type Zone,
} from './types';
import { areaName, createBreakables, createEnemies, getWorld } from './world';
import { createNavigationGrid, findPath, type NavigationGrid } from './pathfinding';

interface ZoneSnapshot {
  enemies: GameData['enemies'];
  breakables: GameData['breakables'];
  pickups: GameData['pickups'];
}

/** Everything required to resume a run lives in this JSON-serializable value. */
export interface AdventureData extends GameData {
  zoneMemory: Partial<Record<Zone, ZoneSnapshot>>;
  attackHitIds: string[];
  inputLatch: { interact: boolean };
  nextId: number;
}

export interface GameStep { data: AdventureData; sounds: SoundName[] }

export const PLAYER_RADIUS = 0.36;
export const SPAWN_SAFE_RADIUS = 5;
export const SWORD_RANGE = 1.65;
export const SWORD_COOLDOWN = 0.38;
export const POT_RADIUS = 0.36;
export const BOSS_TELEGRAPH = 0.55;
export const BOSS_DAMAGE_COOLDOWN = 0.72;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const radius = (enemy: Enemy) => enemy.boss ? 0.83 : 0.46;
const facingVector = (angle: number) => ({ x: Math.cos(angle), z: Math.sin(angle) });

export function createInitialData(status: Status = 'title', muted = false): AdventureData {
  return {
    status, zone: 'overworld',
    player: { ...OVERWORLD_SPAWN, vx: 0, vz: 0, facing: 0, hp: 3, invulnerable: 0, attackTime: 0, attackCooldown: 0 },
    enemies: createEnemies('overworld'), breakables: createBreakables('overworld'), pickups: [], projectiles: [], effects: [],
    quest: { key: false, gate: false, boss: false, treasure: false },
    elapsed: 0, rupees: 0, muted, area: 'Willow Home', shake: 0, hurtFlash: 0,
    notice: status === 'playing' ? { title: 'The lantern has gone quiet.', body: 'Follow the old path across the creek. Find the Hollow Crown.', time: 7 } : null,
    seed: 0x6d6f7373, zoneMemory: {}, attackHitIds: [], inputLatch: { interact: false }, nextId: 1,
  };
}

function cloneData(previous: AdventureData): AdventureData {
  return {
    ...previous,
    player: { ...previous.player }, quest: { ...previous.quest },
    enemies: previous.enemies.map(enemy => ({ ...enemy, navigation: { ...enemy.navigation, path: enemy.navigation.path } })),
    breakables: previous.breakables.map(item => ({ ...item })),
    pickups: previous.pickups.map(item => ({ ...item })),
    effects: previous.effects.map(effect => ({ ...effect })),
    projectiles: previous.projectiles.map(projectile => ({ ...projectile })),
    notice: previous.notice ? { ...previous.notice } : null,
    zoneMemory: { ...previous.zoneMemory }, attackHitIds: [...previous.attackHitIds], inputLatch: { ...previous.inputLatch },
  };
}

function random(data: AdventureData): number {
  data.seed = (Math.imul(data.seed, 1664525) + 1013904223) >>> 0;
  return data.seed / 4294967296;
}

function addEffect(data: AdventureData, kind: Effect['kind'], x: number, z: number, duration = 0.42, angle = 0): void {
  data.effects.push({ id: `effect-${data.nextId++}`, kind, x, z, duration, age: 0, angle });
}

function addPickup(data: AdventureData, kind: Pickup['kind'], x: number, z: number): void {
  data.pickups.push({ id: `pickup-${data.nextId++}`, kind, x, z, age: 0 });
}

const geometry = {
  overworld: getWorld('overworld').objects.filter(object => object.solid),
  dungeon: getWorld('dungeon').objects.filter(object => object.solid),
};
const water = {
  overworld: new Set(getWorld('overworld').tiles.filter(tile => tile.kind === 'water').map(tile => `${tile.x},${tile.z}`)),
  dungeon: new Set<string>(),
};

function circleTouchesBox(x: number, z: number, r: number, cx: number, cz: number, w: number, d: number): boolean {
  const nearX = clamp(x, cx - w / 2, cx + w / 2);
  const nearZ = clamp(z, cz - d / 2, cz + d / 2);
  return (x - nearX) ** 2 + (z - nearZ) ** 2 < r * r;
}

/** Collision includes tile water, static solids, living pots, and the unopened gate. */
export function isBlocked(data: Pick<GameData, 'zone' | 'quest'> & Partial<Pick<GameData, 'breakables'>>, x: number, z: number, r = PLAYER_RADIUS): boolean {
  const world = getWorld(data.zone);
  if (x < r + 0.05 || z < r + 0.05 || x > world.width - 1 - r - 0.05 || z > world.height - 1 - r - 0.05) return true;
  for (let tz = Math.floor(z - r + 0.5); tz <= Math.floor(z + r + 0.5); tz++) {
    for (let tx = Math.floor(x - r + 0.5); tx <= Math.floor(x + r + 0.5); tx++) {
      if (water[data.zone].has(`${tx},${tz}`) && circleTouchesBox(x, z, r, tx, tz, 1, 1)) return true;
    }
  }
  for (const object of geometry[data.zone]) {
    if (object.kind === 'gate' && data.quest.gate) continue;
    const solid = object.solid!;
    if ('r' in solid) {
      if ((x - object.x) ** 2 + (z - object.z) ** 2 < (r + solid.r) ** 2) return true;
    } else if (circleTouchesBox(x, z, r, object.x, object.z, solid.w, solid.d)) return true;
  }
  for (const item of data.breakables ?? []) {
    if (item.alive && item.kind === 'pot' && (x - item.x) ** 2 + (z - item.z) ** 2 < (r + POT_RADIUS) ** 2) return true;
  }
  return false;
}

function allowed(data: AdventureData, x: number, z: number, r: number, enemy?: Enemy): boolean {
  if (isBlocked(data, x, z, r)) return false;
  if (enemy && data.zone === 'overworld' && distance({ x, z }, OVERWORLD_SPAWN) < SPAWN_SAFE_RADIUS + r) return false;
  if (enemy?.boss && z < 18.6) return false;
  return true;
}

/** Substeps prevent fast knockback/dashes from tunneling, with independent axes for wall sliding. */
function move(data: AdventureData, entity: { x: number; z: number }, dx: number, dz: number, r: number, enemy?: Enemy): void {
  const count = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 0.18));
  for (let i = 0; i < count; i++) {
    const x = entity.x + dx / count;
    if (allowed(data, x, entity.z, r, enemy)) entity.x = x;
    const z = entity.z + dz / count;
    if (allowed(data, entity.x, z, r, enemy)) entity.z = z;
  }
}

function switchZone(data: AdventureData, zone: Zone): void {
  data.zoneMemory[data.zone] = { enemies: data.enemies, breakables: data.breakables, pickups: data.pickups };
  const saved = data.zoneMemory[zone];
  data.zone = zone;
  data.enemies = saved ? saved.enemies.map(enemy => ({ ...enemy, navigation: { ...enemy.navigation, path: [], index: 0, repath: 0 }, attackMode: 'pursue', attackTimer: 0, rangedCooldown: 1.15 })) : createEnemies(zone);
  data.breakables = saved ? saved.breakables.map(item => ({ ...item })) : createBreakables(zone);
  data.pickups = saved ? saved.pickups.map(item => ({ ...item })) : [];
  if (zone === 'dungeon' && !data.quest.key && !data.pickups.some(item => item.kind === 'key')) {
    addPickup(data, 'key', KEY_POSITION.x, KEY_POSITION.z);
  }
  const spawn = zone === 'dungeon' ? DUNGEON_SPAWN : { x: DUNGEON_ENTRANCE.x, z: DUNGEON_ENTRANCE.z - 2 };
  Object.assign(data.player, spawn, { vx: 0, vz: 0, attackTime: 0, attackCooldown: 0, invulnerable: 1, facing: zone === 'dungeon' ? Math.PI / 2 : -Math.PI / 2 });
  data.effects = [];
  data.projectiles = [];
  data.attackHitIds = [];
  data.area = areaName(zone, data.player.x, data.player.z);
  data.notice = zone === 'dungeon'
    ? { title: 'Lantern Hall', body: 'A brass key glints on the western pedestal. Approach the key and its gate; interact with the chest.', time: 5 }
    : { title: 'The daylight welcomes you.', body: 'The old path leads safely back to Willow Home.', time: 3 };
}

function interact(data: AdventureData, sounds: SoundName[]): boolean {
  const player = data.player;
  if (data.zone === 'overworld') {
    if (distance(player, DUNGEON_ENTRANCE) < 2.2) {
      switchZone(data, 'dungeon');
      sounds.push('gate');
      return true;
    }
    const sign = getWorld('overworld').objects.find(object => object.kind === 'sign' && distance(player, object) < 2);
    if (sign) {
      const messages: Record<string, { title: string; body: string }> = {
        'sign-home': { title: 'A note from the lantern keeper', body: 'The Hollow Crown waits beyond the creek. Cut grass for hearts. Follow the gold path east.' },
        'sign-crossing': { title: 'The old crossing', body: 'The creek runs deep. This wooden bridge is the only way across. Turn east on the far bank.' },
        'sign-dungeon': { title: 'Emberstone Hollow', body: 'A key, a gate, a sleeping guardian. Bring the Hollow Crown home. Press E at the arch to enter.' },
      };
      data.notice = { ...messages[sign.id], time: 7 };
    }
  } else {
    if (distance(player, { x: 12, z: 2 }) < 1.65) {
      switchZone(data, 'overworld');
      sounds.push('gate');
      return true;
    }
    if (!data.quest.gate && distance(player, GATE_POSITION) < 3.15) {
      if (data.quest.key) openGate(data, sounds);
      else data.notice = { title: 'An old lock holds fast.', body: 'Find the brass key on the western pedestal.', time: 3 };
    } else if (distance(player, CHEST_POSITION) < 2.15) {
      if (data.quest.boss) {
        data.quest.treasure = true;
        data.status = 'victory';
        data.notice = null;
        addEffect(data, 'sparkle', CHEST_POSITION.x, CHEST_POSITION.z, 1.5);
        sounds.push('chest');
      } else data.notice = { title: 'The crown is still bound.', body: 'Defeat the Cinder Warden to release the treasure.', time: 3 };
    }
  }
  return false;
}

function openGate(data: AdventureData, sounds: SoundName[]): void {
  if (data.zone !== 'dungeon' || data.quest.gate || !data.quest.key || distance(data.player, GATE_POSITION) >= 3.15) return;
  data.quest.gate = true;
  data.notice = { title: 'The iron gate is open.', body: 'Dodge the Warden’s glowing aim and charge. Strike between attacks.', time: 5 };
  data.shake = 0.14;
  addEffect(data, 'sparkle', GATE_POSITION.x, GATE_POSITION.z, 0.65);
  sounds.push('gate');
}

function inSword(data: AdventureData, x: number, z: number, targetRadius = 0): boolean {
  const dx = x - data.player.x;
  const dz = z - data.player.z;
  const length = Math.hypot(dx, dz);
  const direction = facingVector(data.player.facing);
  return length <= SWORD_RANGE + targetRadius && (length < 0.28 || (dx * direction.x + dz * direction.z) / length > 0.3);
}

function killEnemy(data: AdventureData, enemy: Enemy, sounds: SoundName[]): void {
  enemy.alive = false;
  enemy.hp = 0;
  enemy.vx = enemy.vz = 0;
  enemy.respawn = data.zone === 'overworld' ? 20 : 0;
  addEffect(data, 'poof', enemy.x, enemy.z, enemy.boss ? 1 : 0.6);
  addPickup(data, 'rupee', enemy.x, enemy.z);
  if (enemy.boss) {
    data.quest.boss = true;
    data.projectiles = data.projectiles.filter(projectile => projectile.ownerId !== enemy.id);
    data.shake = 0.28;
    data.notice = { title: 'The Cinder Warden falls.', body: 'The Hollow Crown is yours. Open the chest at the north wall with E.', time: 7 };
    addPickup(data, 'heart', enemy.x + 0.7, enemy.z);
    addPickup(data, 'rupee', enemy.x - 0.7, enemy.z);
    addPickup(data, 'rupee', enemy.x, enemy.z + 0.6);
  } else if (random(data) < 0.35) addPickup(data, 'heart', enemy.x + 0.35, enemy.z + 0.25);
  sounds.push('death');
}

function swordLineClear(data: AdventureData, enemy: Enemy): boolean {
  const length = distance(data.player, enemy);
  const steps = Math.ceil(length / 0.15);
  for (let step = 1; step < steps; step++) {
    const fraction = step / steps;
    if (isBlocked(data, data.player.x + (enemy.x - data.player.x) * fraction, data.player.z + (enemy.z - data.player.z) * fraction, 0.035)) return false;
  }
  return true;
}

function sword(data: AdventureData, sounds: SoundName[]): void {
  if (data.player.attackTime <= 0) return;
  for (const enemy of data.enemies) {
    if (!enemy.alive || data.attackHitIds.includes(enemy.id) || !inSword(data, enemy.x, enemy.z, radius(enemy))) continue;
    // A sealed room keeps its guardian dormant until the player opens the gate.
    if (enemy.boss && !data.quest.gate || !swordLineClear(data, enemy)) continue;
    data.attackHitIds.push(enemy.id);
    if (enemy.boss && enemy.damageCooldown > 0) continue;
    enemy.hp--;
    enemy.navigation.chasing = true;
    enemy.damageCooldown = enemy.boss ? BOSS_DAMAGE_COOLDOWN : 0;
    enemy.flash = 0.16;
    enemy.hitstun = enemy.boss ? 0 : 0.3;
    const dx = enemy.x - data.player.x;
    const dz = enemy.z - data.player.z;
    const length = Math.hypot(dx, dz) || 1;
    if (!enemy.boss) {
      enemy.vx = dx / length * 7.2;
      enemy.vz = dz / length * 7.2;
      enemy.contactCooldown = Math.max(enemy.contactCooldown, 0.3);
    }
    addEffect(data, 'hit', (enemy.x + data.player.x) / 2, (enemy.z + data.player.z) / 2, 0.3, data.player.facing);
    data.shake = Math.max(data.shake, 0.075);
    sounds.push('hit');
    if (enemy.hp <= 0) killEnemy(data, enemy, sounds);
  }
  for (const item of data.breakables) {
    if (!item.alive || data.attackHitIds.includes(item.id) || !inSword(data, item.x, item.z, 0.24)) continue;
    item.alive = false;
    data.attackHitIds.push(item.id);
    addEffect(data, item.kind, item.x, item.z, 0.55, data.player.facing);
    sounds.push('hit');
    const chance = random(data);
    if (chance < 0.22) addPickup(data, 'heart', item.x, item.z);
    else if (chance < 0.66) addPickup(data, 'rupee', item.x, item.z);
  }
}

function hurtPlayer(data: AdventureData, enemy: Enemy, sounds: SoundName[]): void {
  const player = data.player;
  if (player.invulnerable > 0 || enemy.contactCooldown > 0 || enemy.hitstun > 0) return;
  player.hp = Math.max(0, player.hp - 1);
  player.invulnerable = 1.25;
  const dx = player.x - enemy.x;
  const dz = player.z - enemy.z;
  const length = Math.hypot(dx, dz) || 1;
  player.vx = dx / length * 8.5;
  player.vz = dz / length * 8.5;
  enemy.contactCooldown = 1.1;
  data.shake = 0.3;
  data.hurtFlash = 0.45;
  addEffect(data, 'hit', player.x, player.z, 0.3, Math.atan2(dz, dx));
  sounds.push('hurt');
  if (player.hp <= 0) data.status = 'gameover';
}

// Grids are derived only from immutable world geometry and the current obstacle
// layout. Cached grids never contain entity state and do not affect replay order.
const navigationGrids = new Map<string, NavigationGrid>();
function navigationGrid(data: AdventureData, enemy: Enemy): NavigationGrid {
  const r = radius(enemy);
  const pots = data.breakables.filter(item => item.alive && item.kind === 'pot').map(item => `${item.x},${item.z}`).join(';');
  const key = `${data.zone}:${r}:${Number(data.quest.gate)}:${pots}`;
  const cached = navigationGrids.get(key);
  if (cached) return cached;
  const world = getWorld(data.zone);
  // Cache callbacks close over a frozen obstacle snapshot, never a live run
  // that may open its gate, break a pot, or switch zones later in this tick.
  const obstacles = { zone: data.zone, quest: { ...data.quest }, breakables: data.breakables.filter(item => item.alive && item.kind === 'pot').map(item => ({ ...item })) };
  const boss = enemy.boss;
  const grid = createNavigationGrid(world.width, world.height, (x, z) => {
    if (isBlocked(obstacles, x, z, r)) return true;
    if (obstacles.zone === 'overworld' && distance({ x, z }, OVERWORLD_SPAWN) < SPAWN_SAFE_RADIUS + r) return true;
    return boss && z < 18.6;
  }, (x, z) => isBlocked(obstacles, x, z, 0.035));
  if (navigationGrids.size >= 16) navigationGrids.delete(navigationGrids.keys().next().value!);
  navigationGrids.set(key, grid);
  return grid;
}

function navigate(data: AdventureData, enemy: Enemy, target: { x: number; z: number }, dt: number): { x: number; z: number; reachable: boolean } {
  const nav = enemy.navigation;
  nav.repath -= dt;
  const changed = Math.hypot(target.x - nav.targetX, target.z - nav.targetZ) > 0.8;
  const grid = navigationGrid(data, enemy);
  if (nav.repath <= 0 || changed) {
    nav.path = findPath(grid, enemy, target, enemy.boss ? 1.8 : 1.3) ?? [];
    nav.index = 0;
    nav.targetX = target.x;
    nav.targetZ = target.z;
    nav.repath = enemy.boss ? 0.42 : 0.6;
  }
  while (nav.index < nav.path.length && distance(enemy, nav.path[nav.index]) < 0.18) nav.index++;
  // Skip already-visible waypoints for a smooth approach without cutting corners.
  for (let next = Math.min(nav.index + 3, nav.path.length - 1); next > nav.index; next--) {
    if (grid.canTravel(enemy, nav.path[next])) { nav.index = next; break; }
  }
  const point = nav.path[nav.index];
  if (!point) return { x: 0, z: 0, reachable: nav.path.length > 0 };
  const dx = point.x - enemy.x;
  const dz = point.z - enemy.z;
  const length = Math.hypot(dx, dz) || 1;
  return { x: dx / length, z: dz / length, reachable: true };
}

function beginBossTell(data: AdventureData, enemy: Enemy, mode: 'telegraph' | 'chargeTelegraph', sounds: SoundName[]): void {
  enemy.attackMode = mode;
  enemy.attackTimer = mode === 'telegraph' ? BOSS_TELEGRAPH : 0.6;
  enemy.aimX = data.player.x;
  enemy.aimZ = data.player.z;
  enemy.vx = enemy.vz = 0;
  sounds.push('warning');
}

function fireBoss(data: AdventureData, enemy: Enemy, sounds: SoundName[]): void {
  const angle = Math.atan2(enemy.aimZ - enemy.z, enemy.aimX - enemy.x);
  const offsets = enemy.phase === 2 ? [-0.22, 0, 0.22] : [0];
  for (const offset of offsets) {
    const direction = facingVector(angle + offset);
    data.projectiles.push({
      id: `projectile-${data.nextId++}`, ownerId: enemy.id,
      x: enemy.x + direction.x * 0.9, z: enemy.z + direction.z * 0.9,
      vx: direction.x * 6, vz: direction.z * 6, age: 0, duration: 3, radius: 0.22,
    });
  }
  enemy.lastAttack = Math.max(0, enemy.lastAttack) + 1;
  enemy.rangedCooldown = enemy.phase === 2 ? 1.5 : 2;
  enemy.attackMode = 'fire';
  enemy.attackTimer = 0.2;
  sounds.push('fire');
}

function bossMotion(data: AdventureData, enemy: Enemy, dt: number, steering: { x: number; z: number; reachable: boolean }, sounds: SoundName[]): { x: number; z: number; speed: number } {
  if (enemy.phase === 1 && enemy.hp <= enemy.maxHp / 2) {
    enemy.phase = 2;
    enemy.rangedCooldown = Math.min(enemy.rangedCooldown, 0.4);
    addEffect(data, 'sparkle', enemy.x, enemy.z, 0.8);
    data.notice = { title: 'The embers flare.', body: 'The Warden’s glow splits into three. Keep moving across its aim.', time: 3.5 };
  }
  enemy.rangedCooldown = Math.max(0, enemy.rangedCooldown - dt);
  enemy.attackTimer = Math.max(0, enemy.attackTimer - dt);
  if (enemy.attackMode === 'telegraph') {
    if (enemy.attackTimer <= 0) fireBoss(data, enemy, sounds);
    return { x: 0, z: 0, speed: 0 };
  }
  if (enemy.attackMode === 'fire') {
    if (enemy.attackTimer <= 0) {
      // Alternate ranged pressure and a deliberately aimed, avoidable lunge.
      if (steering.reachable && enemy.lastAttack % 2 === 0 && distance(enemy, data.player) < 8) beginBossTell(data, enemy, 'chargeTelegraph', sounds);
      else { enemy.attackMode = 'recover'; enemy.attackTimer = 0.28; }
    }
    return { x: 0, z: 0, speed: 0 };
  }
  if (enemy.attackMode === 'chargeTelegraph') {
    if (enemy.attackTimer <= 0) {
      enemy.attackMode = 'charge';
      enemy.attackTimer = 0.42;
      enemy.wanderAngle = Math.atan2(enemy.aimZ - enemy.z, enemy.aimX - enemy.x);
      sounds.push('fire');
    }
    return { x: 0, z: 0, speed: 0 };
  }
  if (enemy.attackMode === 'charge') {
    if (enemy.attackTimer <= 0) { enemy.attackMode = 'recover'; enemy.attackTimer = 0.48; return { x: 0, z: 0, speed: 0 }; }
    const direction = facingVector(enemy.wanderAngle);
    return { ...direction, speed: 6.7 };
  }
  if (enemy.attackMode === 'recover') {
    if (enemy.attackTimer <= 0) enemy.attackMode = 'pursue';
    return { x: 0, z: 0, speed: 0 };
  }
  if (enemy.rangedCooldown <= 0 || !steering.reachable && enemy.navigation.stuck > 0.8 && enemy.rangedCooldown < 0.85) {
    beginBossTell(data, enemy, 'telegraph', sounds);
    return { x: 0, z: 0, speed: 0 };
  }
  return { ...steering, speed: enemy.phase === 2 ? 2.9 : 2.45 };
}

function enemyAI(data: AdventureData, enemy: Enemy, dt: number, sounds: SoundName[]): void {
  enemy.contactCooldown = Math.max(0, enemy.contactCooldown - dt);
  enemy.damageCooldown = Math.max(0, enemy.damageCooldown - dt);
  enemy.flash = Math.max(0, enemy.flash - dt);
  if (!enemy.alive) {
    if (data.zone !== 'overworld') return;
    enemy.respawn -= dt;
    if (enemy.respawn <= 0 && distance(data.player, { x: enemy.homeX, z: enemy.homeZ }) > 3) {
      Object.assign(enemy, { alive: true, hp: enemy.maxHp, x: enemy.homeX, z: enemy.homeZ, vx: 0, vz: 0, hitstun: 0, flash: 0.3 });
      enemy.navigation = { path: [], index: 0, repath: 0, targetX: enemy.x, targetZ: enemy.z, stuck: 0, chasing: false };
      addEffect(data, 'poof', enemy.x, enemy.z, 0.6);
    }
    return;
  }
  if (enemy.hitstun > 0 && !enemy.boss) {
    enemy.hitstun = Math.max(0, enemy.hitstun - dt);
    move(data, enemy, enemy.vx * dt, enemy.vz * dt, radius(enemy), enemy);
    enemy.vx *= Math.exp(-8 * dt);
    enemy.vz *= Math.exp(-8 * dt);
    return;
  }
  // An opened arena stays active after engagement, including at its doorway.
  if (enemy.boss && (!data.quest.gate || !enemy.navigation.chasing && data.player.z < 18.5)) {
    enemy.vx = enemy.vz = 0;
    return;
  }
  const playerDistance = distance(enemy, data.player);
  const playerSafe = data.zone === 'overworld' && distance(data.player, OVERWORLD_SPAWN) < SPAWN_SAFE_RADIUS;
  const homeDistance = distance(enemy, { x: enemy.homeX, z: enemy.homeZ });
  const nav = enemy.navigation;
  if (enemy.boss || !playerSafe && playerDistance < 8) nav.chasing = true;
  if (playerSafe || !enemy.boss && nav.stuck > 15 && playerDistance > 10) nav.chasing = false;
  let targetX = 0;
  let targetZ = 0;
  let speed = 0.55;
  if (nav.chasing) {
    const steering = navigate(data, enemy, data.player, dt);
    if (enemy.boss) {
      const motion = bossMotion(data, enemy, dt, steering, sounds);
      targetX = motion.x;
      targetZ = motion.z;
      speed = motion.speed;
    } else { targetX = steering.x; targetZ = steering.z; speed = 1.85; }
  } else if (homeDistance > 2.4 || playerSafe && homeDistance > 1.2) {
    const steering = navigate(data, enemy, { x: enemy.homeX, z: enemy.homeZ }, dt);
    targetX = steering.x;
    targetZ = steering.z;
    speed = 1.25;
  } else {
    nav.path = [];
    enemy.wanderTime -= dt;
    if (enemy.wanderTime <= 0) {
      enemy.wanderAngle = random(data) * Math.PI * 2;
      enemy.wanderTime = 1 + random(data) * 2;
    }
    targetX = Math.cos(enemy.wanderAngle);
    targetZ = Math.sin(enemy.wanderAngle);
  }
  const blend = 1 - Math.exp(-12 * dt);
  enemy.vx += (targetX * speed - enemy.vx) * blend;
  enemy.vz += (targetZ * speed - enemy.vz) * blend;
  const oldX = enemy.x;
  const oldZ = enemy.z;
  move(data, enemy, enemy.vx * dt, enemy.vz * dt, radius(enemy), enemy);
  if (nav.chasing && speed > 0.5) {
    const progressed = distance(enemy, { x: oldX, z: oldZ }) > dt * speed * 0.15;
    nav.stuck = progressed ? Math.max(0, nav.stuck - dt * 3) : nav.stuck + dt;
  }
  if (!nav.chasing && speed > 0.5 && distance(enemy, { x: oldX, z: oldZ }) < dt * speed * 0.2) enemy.wanderAngle += Math.PI / 2;
}

/** Ember magic passes through cover; its fixed aim and audible tell give time to dodge. */
function updateProjectiles(data: AdventureData, dt: number, sounds: SoundName[]): void {
  data.projectiles = data.projectiles.filter(projectile => {
    if (!data.enemies.some(enemy => enemy.id === projectile.ownerId && enemy.alive)) return false;
    projectile.age += dt;
    if (projectile.age >= projectile.duration) return false;
    const oldX = projectile.x;
    const oldZ = projectile.z;
    projectile.x += projectile.vx * dt;
    projectile.z += projectile.vz * dt;
    const dx = projectile.x - oldX;
    const dz = projectile.z - oldZ;
    const along = clamp(((data.player.x - oldX) * dx + (data.player.z - oldZ) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    if (Math.hypot(data.player.x - oldX - dx * along, data.player.z - oldZ - dz * along) > PLAYER_RADIUS + projectile.radius) return true;
    if (data.player.invulnerable <= 0) {
      data.player.hp = Math.max(0, data.player.hp - 1);
      data.player.invulnerable = 1.25;
      const speed = Math.hypot(projectile.vx, projectile.vz) || 1;
      data.player.vx = projectile.vx / speed * 6;
      data.player.vz = projectile.vz / speed * 6;
      data.shake = 0.22;
      data.hurtFlash = 0.4;
      addEffect(data, 'hit', data.player.x, data.player.z, 0.3);
      sounds.push('hurt');
      if (data.player.hp <= 0) data.status = 'gameover';
    }
    return false;
  });
}

function separate(data: AdventureData, sounds: SoundName[]): void {
  const alive = data.enemies.filter(enemy => enemy.alive);
  // Iterating a few times resolves a crowd without allowing three bodies to stack.
  for (let pass = 0; pass < 4; pass++) {
    for (const enemy of alive) {
      const dx = enemy.x - data.player.x;
      const dz = enemy.z - data.player.z;
      const length = Math.hypot(dx, dz);
      const minimum = radius(enemy) + PLAYER_RADIUS;
      if (length >= minimum) continue;
      if (pass === 0) hurtPlayer(data, enemy, sounds);
      const nx = length > 0.0001 ? dx / length : 1;
      const nz = length > 0.0001 ? dz / length : 0;
      const overlap = minimum - length + 0.002;
      const enemyShare = enemy.boss ? 0.3 : 0.55;
      move(data, enemy, nx * overlap * enemyShare, nz * overlap * enemyShare, radius(enemy), enemy);
      move(data, data.player, -nx * overlap * (1 - enemyShare), -nz * overlap * (1 - enemyShare), PLAYER_RADIUS);
      // If a wall prevents one body's movement, the other absorbs the correction.
      const remaining = minimum - distance(data.player, enemy);
      if (remaining > 0.001) {
        move(data, enemy, nx * (remaining + 0.002), nz * (remaining + 0.002), radius(enemy), enemy);
        const last = minimum - distance(data.player, enemy);
        if (last > 0) move(data, data.player, -nx * (last + 0.002), -nz * (last + 0.002), PLAYER_RADIUS);
      }
    }
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        const minimum = radius(a) + radius(b);
        if (length >= minimum) continue;
        const nx = length > 0.0001 ? dx / length : 1;
        const nz = length > 0.0001 ? dz / length : 0;
        const correction = (minimum - length + 0.002) / 2;
        move(data, a, -nx * correction, -nz * correction, radius(a), a);
        move(data, b, nx * correction, nz * correction, radius(b), b);
      }
    }
  }
}

function collectPickups(data: AdventureData, dt: number, sounds: SoundName[]): void {
  const kept: Pickup[] = [];
  for (const pickup of data.pickups) {
    pickup.age += dt;
    const dx = data.player.x - pickup.x;
    const dz = data.player.z - pickup.z;
    const length = Math.hypot(dx, dz);
    if (length < (pickup.kind === 'key' ? 0.95 : 0.62)) {
      if (pickup.kind === 'rupee') {
        data.rupees++;
        sounds.push('rupee');
      } else if (pickup.kind === 'heart') {
        data.player.hp = Math.min(3, data.player.hp + 1);
        sounds.push('rupee');
      } else {
        data.quest.key = true;
        data.notice = { title: 'You found the brass key!', body: 'Bring it to the north gate. The brass key will open the lock as you approach.', time: 5 };
        sounds.push('key');
      }
      addEffect(data, 'sparkle', pickup.x, pickup.z, 0.4);
      continue;
    }
    if (length < 1.8 && length > 0) {
      const travel = Math.min(length, dt * 6.5);
      pickup.x += dx / length * travel;
      pickup.z += dz / length * travel;
    }
    kept.push(pickup);
  }
  data.pickups = kept;
}

/** Pure fixed-step gameplay. No clocks, browser calls, or unseeded randomness. */
export function stepGame(previous: AdventureData, requestedDt: number, input: GameInput): GameStep {
  if (previous.status !== 'playing') return { data: previous, sounds: [] };
  const dt = clamp(Number.isFinite(requestedDt) ? requestedDt : 0, 0, 0.05);
  if (dt <= 0) return { data: previous, sounds: [] };
  const data = cloneData(previous);
  const sounds: SoundName[] = [];
  const player = data.player;
  data.elapsed += dt;
  data.shake = Math.max(0, data.shake - dt * 0.85);
  data.hurtFlash = Math.max(0, data.hurtFlash - dt);
  if (data.notice) {
    data.notice.time -= dt;
    if (data.notice.time <= 0) data.notice = null;
  }
  data.effects = data.effects.filter(effect => (effect.age += dt) < effect.duration);
  player.invulnerable = Math.max(0, player.invulnerable - dt);
  player.attackCooldown = Math.max(0, player.attackCooldown - dt);
  player.attackTime = Math.max(0, player.attackTime - dt);

  const inputLength = Math.hypot(input.x, input.z);
  const ix = inputLength > 0 ? input.x / Math.max(1, inputLength) : 0;
  const iz = inputLength > 0 ? input.z / Math.max(1, inputLength) : 0;
  if (inputLength > 0.05) player.facing = Math.round(Math.atan2(iz, ix) / (Math.PI / 4)) * (Math.PI / 4);
  // The first beat of a hit belongs to the knockback; then control returns.
  if (player.invulnerable > 1) {
    player.vx *= Math.exp(-5 * dt);
    player.vz *= Math.exp(-5 * dt);
  } else {
    const blend = 1 - Math.exp(-(inputLength > 0.05 ? 18 : 14) * dt);
    const speed = player.attackTime > 0 ? 3.15 : 4.2;
    player.vx += (ix * speed - player.vx) * blend;
    player.vz += (iz * speed - player.vz) * blend;
  }
  move(data, player, player.vx * dt, player.vz * dt, PLAYER_RADIUS);

  // A moving hero carries the visible sweep with them throughout the attack.
  for (const effect of data.effects) {
    if (effect.kind !== 'swing') continue;
    effect.x = player.x;
    effect.z = player.z;
    effect.angle = player.facing;
  }

  if (input.attack && player.attackCooldown <= 0 && player.invulnerable <= 1) {
    player.attackTime = 0.24;
    player.attackCooldown = SWORD_COOLDOWN;
    data.attackHitIds = [];
    addEffect(data, 'swing', player.x, player.z, 0.24, player.facing);
    sounds.push('swing');
  }
  sword(data, sounds);
  openGate(data, sounds);
  for (const enemy of data.enemies) enemyAI(data, enemy, dt, sounds);
  updateProjectiles(data, dt, sounds);
  separate(data, sounds);
  if (data.status === 'playing') {
    collectPickups(data, dt, sounds);
    openGate(data, sounds);
  }
  const pressedInteract = input.interact && !data.inputLatch.interact;
  data.inputLatch.interact = input.interact;
  if (data.status === 'playing' && pressedInteract) interact(data, sounds);
  data.area = areaName(data.zone, player.x, player.z);
  return { data, sounds };
}
