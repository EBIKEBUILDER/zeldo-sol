import type { SoundName } from './audio';
import {
  CHEST_POSITION,
  GATE_POSITION,
  KEY_POSITION,
  OVERWORLD_SPAWN,
  type Effect,
  type Enemy,
  type GameData,
  type GameInput,
  type Pickup,
  type Status,
  type TileKind,
  type Zone,
} from './types';
import { areaName, createBreakables, createEnemies, getWorld, worldPortals } from './world';
import { createNavigationGraph, createNavigationGrid, findWorldPath, type NavigationGraph, type NavigationLocation, type NavigationPortal } from './pathfinding';

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
  /** Arrival-overlapping portals rearm once the hero walks clear of their doorway. */
  portalArrivalLocks?: string[];
  nextId: number;
  navigationCursor: number;
  navigationStats: { searches: number; expansions: number; deferred: number };
}

export interface GameStep { data: AdventureData; sounds: SoundName[] }

export const PLAYER_RADIUS = 0.36;
export const SPAWN_SAFE_RADIUS = 5;
export const SWORD_RANGE = 1.65;
export const SWORD_COOLDOWN = 0.38;
export const POT_RADIUS = 0.36;
export const BOSS_TELEGRAPH = 0.55;
export const BOSS_DAMAGE_COOLDOWN = 0.72;
export const BOSS_CHARGE_TELEGRAPH = 0.6;
export const BOSS_CHARGE_DURATION = 0.42;
export const BOSS_CHARGE_SPEED = 6.7;
export const BOSS_CHARGE_RANGE = 4.8;
export const BOSS_BLAST_RADIUS = 1.2;
export const BOSS_BLAST_SPREAD = 1.4;
export const BOSS_EMBER_DURATION = 1.8;
export const HOME_ARRIVAL_DISTANCE = 0.18;
export const PATHFINDING_SEARCHES_PER_TICK = 2;
// Two complete searches of today's unified overworld+dungeon fit this limit.
// A deterministic work limit preserves replay behavior on different machines.
export const PATHFINDING_EXPANSIONS_PER_TICK = 4800;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const radius = (enemy: Enemy) => enemy.boss ? 0.83 : 0.46;
const facingVector = (angle: number) => ({ x: Math.cos(angle), z: Math.sin(angle) });

export function createInitialData(status: Status = 'title', muted = false): AdventureData {
  return {
    status, zone: 'overworld',
    player: { ...OVERWORLD_SPAWN, vx: 0, vz: 0, facing: 0, hp: 3, invulnerable: 0, attackTime: 0, attackCooldown: 0 },
    enemies: createEnemies('overworld'), breakables: createBreakables('overworld'), pickups: [], projectiles: [], hazards: [], effects: [],
    quest: { key: false, gate: false, boss: false, treasure: false },
    elapsed: 0, rupees: 0, muted, area: 'Willow Home', shake: 0, hurtFlash: 0,
    notice: status === 'playing' ? { title: 'The lantern has gone quiet.', body: 'Follow the old path across the creek. Find the Hollow Crown.', time: 7 } : null,
    seed: 0x6d6f7373, zoneMemory: {}, attackHitIds: [], inputLatch: { interact: false }, portalArrivalLocks: [], nextId: 1,
    tileOverrides: {}, portals: worldPortals.map(portal => ({ ...portal, fromTile: { ...portal.fromTile }, toTile: { ...portal.toTile } })),
    navigationCursor: 0, navigationStats: { searches: 0, expansions: 0, deferred: 0 },
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
    hazards: (previous.hazards ?? []).map(hazard => ({ ...hazard })),
    notice: previous.notice ? { ...previous.notice } : null,
    zoneMemory: Object.fromEntries(Object.entries(previous.zoneMemory).map(([zone, saved]) => [zone, {
      enemies: saved.enemies.map(enemy => ({ ...enemy, navigation: { ...enemy.navigation, path: enemy.navigation.path } })),
      breakables: saved.breakables, pickups: saved.pickups,
    }])),
    navigationStats: { searches: 0, expansions: 0, deferred: 0 },
    attackHitIds: [...previous.attackHitIds], inputLatch: { ...previous.inputLatch },
    portalArrivalLocks: [...previous.portalArrivalLocks ?? []],
  };
}

/** Immutable tile edits update physics, navigation and the rendered floor together. */
export function setTileKind(previous: AdventureData, zone: Zone, x: number, z: number, kind: TileKind): AdventureData {
  const world = getWorld(zone);
  if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0 || x >= world.width || z >= world.height) throw new RangeError('Tile is outside the world');
  const base = world.tiles[z * world.width + x].kind;
  const key = `${x},${z}`;
  if ((previous.tileOverrides[zone]?.[key] ?? base) === kind) return previous;
  if (kind === 'water') {
    const enemies = zone === previous.zone ? previous.enemies : previous.zoneMemory[zone]?.enemies ?? [];
    const occupied = zone === previous.zone && circleTouchesBox(previous.player.x, previous.player.z, PLAYER_RADIUS, x, z, 1, 1)
      || enemies.some(enemy => enemy.alive && circleTouchesBox(enemy.x, enemy.z, radius(enemy), x, z, 1, 1));
    if (occupied) throw new RangeError('Cannot make an occupied tile impassable');
  }
  const changes = { ...previous.tileOverrides[zone] };
  if (kind === base) delete changes[key];
  else changes[key] = kind;
  return { ...previous, tileOverrides: { ...previous.tileOverrides, [zone]: changes } };
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
const zones: Zone[] = ['overworld', 'dungeon'];

function circleTouchesBox(x: number, z: number, r: number, cx: number, cz: number, w: number, d: number): boolean {
  const nearX = clamp(x, cx - w / 2, cx + w / 2);
  const nearZ = clamp(z, cz - d / 2, cz + d / 2);
  return (x - nearX) ** 2 + (z - nearZ) ** 2 < r * r;
}

/** Collision includes tile water, static solids, living pots, and the unopened gate. */
export function isBlocked(data: Pick<GameData, 'zone' | 'quest'> & Partial<Pick<GameData, 'breakables' | 'tileOverrides'>>, x: number, z: number, r = PLAYER_RADIUS): boolean {
  const world = getWorld(data.zone);
  if (x < r + 0.05 || z < r + 0.05 || x > world.width - 1 - r - 0.05 || z > world.height - 1 - r - 0.05) return true;
  for (let tz = Math.floor(z - r + 0.5); tz <= Math.floor(z + r + 0.5); tz++) {
    for (let tx = Math.floor(x - r + 0.5); tx <= Math.floor(x + r + 0.5); tx++) {
      const kind = data.tileOverrides?.[data.zone]?.[`${tx},${tz}`] ?? world.tiles[tz * world.width + tx]?.kind;
      if (kind === 'water' && circleTouchesBox(x, z, r, tx, tz, 1, 1)) return true;
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
  if (enemy?.boss && data.zone === 'dungeon' && z < 18.6) return false;
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

function portalEndpoints(portal: NavigationPortal): { from: NavigationLocation; to: NavigationLocation } | null {
  const chunks = zones.flatMap(zone => getWorld(zone).chunks);
  const source = chunks.find(chunk => chunk.id === portal.fromChunk);
  const destination = chunks.find(chunk => chunk.id === portal.toChunk);
  if (!source || !destination) return null;
  return {
    from: { region: source.region, x: source.origin.x + portal.fromTile.x, z: source.origin.z + portal.fromTile.z },
    to: { region: destination.region, x: destination.origin.x + portal.toTile.x, z: destination.origin.z + portal.toTile.z },
  };
}

function hasAIConnection(data: AdventureData, from: Zone, to: Zone): boolean {
  const reachable = new Set<string>([from]);
  for (let pass = 0; pass < zones.length; pass++) {
    for (const portal of data.portals) {
      const endpoints = portalEndpoints(portal);
      if (portal.traversableByAI && endpoints && reachable.has(endpoints.from.region)) reachable.add(endpoints.to.region);
    }
  }
  return reachable.has(to);
}

function clearTravel(data: AdventureData, from: { x: number; z: number }, to: { x: number; z: number }, r: number, enemy?: Enemy): boolean {
  const steps = Math.max(1, Math.ceil(distance(from, to) / 0.15));
  for (let step = 1; step <= steps; step++) {
    if (!allowed(data, from.x + (to.x - from.x) * step / steps, from.z + (to.z - from.z) * step / steps, r, enemy)) return false;
  }
  return true;
}

/** Discard pursuit steering before a budgeted route home can start. */
function beginReturnHome(enemy: Enemy): void {
  Object.assign(enemy.navigation, {
    chasing: false, returning: true, path: [], index: 0, repath: 0,
    targetX: enemy.homeX, targetZ: enemy.homeZ, targetRegion: enemy.homeZone,
    noPath: false, pending: false, stuck: 0,
  });
  enemy.vx = enemy.vz = 0;
}

function switchZone(data: AdventureData, portal: NavigationPortal): void {
  const endpoints = portalEndpoints(portal)!;
  const zone = endpoints.to.region as Zone;
  const follows = hasAIConnection(data, data.zone, zone);
  for (const enemy of data.enemies) {
    const returning = enemy.navigation.returning || enemy.navigation.chasing && !follows;
    enemy.navigation = { ...enemy.navigation, path: [], index: 0, repath: 0, revision: undefined,
      chasing: follows && enemy.navigation.chasing, returning, targetRegion: zone, retry: 0, noPath: false, pending: false, stuck: 0 };
    enemy.vx = enemy.vz = 0;
  }
  data.zoneMemory[data.zone] = { enemies: data.enemies, breakables: data.breakables, pickups: data.pickups };
  const saved = data.zoneMemory[zone];
  delete data.zoneMemory[zone];
  data.zone = zone;
  data.enemies = saved ? saved.enemies.map(enemy => ({ ...enemy, navigation: { ...enemy.navigation, path: [], index: 0, repath: 0, revision: undefined }, attackMode: 'pursue', attackTimer: 0, rangedCooldown: 1.15 })) : createEnemies(zone);
  data.breakables = saved ? saved.breakables.map(item => ({ ...item })) : createBreakables(zone);
  data.pickups = saved ? saved.pickups.map(item => ({ ...item })) : [];
  if (zone === 'dungeon' && !data.quest.key && !data.pickups.some(item => item.kind === 'key')) {
    addPickup(data, 'key', KEY_POSITION.x, KEY_POSITION.z);
  }
  Object.assign(data.player, { x: endpoints.to.x, z: endpoints.to.z }, { vx: 0, vz: 0, attackTime: 0, attackCooldown: 0, invulnerable: 1, facing: zone === 'dungeon' ? Math.PI / 2 : -Math.PI / 2 });
  data.effects = [];
  data.projectiles = [];
  data.hazards = [];
  data.attackHitIds = [];
  data.area = areaName(zone, data.player.x, data.player.z);
  data.notice = zone === 'dungeon'
    ? { title: 'Lantern Hall', body: 'A brass key glints on the western pedestal. Approach the key and its gate; interact with the chest.', time: 5 }
    : { title: 'The daylight welcomes you.', body: 'The old path leads safely back to Willow Home.', time: 3 };
}

// Interacting can reach an arch from nearby; walking activates its actual doorway.
// Both normal return landings are two tiles away, outside this automatic radius.
const automaticPortalRadius = (portal: NavigationPortal) => Math.min(portal.activationRadius ?? 1.65, 1.25);

function lockArrivalPortals(data: AdventureData): void {
  data.portalArrivalLocks = data.portals.filter(portal => {
    const endpoints = portalEndpoints(portal);
    return endpoints?.from.region === data.zone && distance(data.player, endpoints.from) < automaticPortalRadius(portal) + 0.25;
  }).map(portal => portal.id);
}

function traversePlayerPortal(data: AdventureData, portal: NavigationPortal, sounds: SoundName[]): boolean {
  const endpoints = portalEndpoints(portal);
  if (!endpoints || endpoints.from.region !== data.zone) return false;
  const zone = endpoints.to.region as Zone;
  const obstacles = { ...data, zone, breakables: zone === data.zone ? data.breakables : data.zoneMemory[zone]?.breakables ?? createBreakables(zone) };
  if (!clearTravel(data, data.player, endpoints.from, PLAYER_RADIUS) || isBlocked(obstacles, endpoints.to.x, endpoints.to.z)) return false;
  if (zone === data.zone) {
    Object.assign(data.player, { x: endpoints.to.x, z: endpoints.to.z, vx: 0, vz: 0 });
  } else switchZone(data, portal);
  lockArrivalPortals(data);
  sounds.push('gate');
  return true;
}

function walkThroughPortal(data: AdventureData, sounds: SoundName[]): boolean {
  data.portalArrivalLocks = (data.portalArrivalLocks ?? []).filter(id => {
    const portal = data.portals.find(item => item.id === id);
    const endpoints = portal && portalEndpoints(portal);
    return portal && endpoints?.from.region === data.zone && distance(data.player, endpoints.from) < automaticPortalRadius(portal) + 0.25;
  });
  for (const portal of data.portals) {
    const endpoints = portalEndpoints(portal);
    if (!endpoints || endpoints.from.region !== data.zone || data.portalArrivalLocks.includes(portal.id)) continue;
    if (distance(data.player, endpoints.from) < automaticPortalRadius(portal) && traversePlayerPortal(data, portal, sounds)) return true;
  }
  return false;
}

function interact(data: AdventureData, sounds: SoundName[]): boolean {
  const player = data.player;
  for (const portal of data.portals) {
    const endpoints = portalEndpoints(portal);
    if (!endpoints || endpoints.from.region !== data.zone || distance(player, endpoints.from) >= (portal.activationRadius ?? 1.65)) continue;
    if (traversePlayerPortal(data, portal, sounds)) return true;
  }
  if (data.zone === 'overworld') {
    const sign = getWorld('overworld').objects.find(object => object.kind === 'sign' && distance(player, object) < 2);
    if (sign) {
      const messages: Record<string, { title: string; body: string }> = {
        'sign-home': { title: 'A note from the lantern keeper', body: 'The Hollow Crown waits beyond the creek. Cut grass for hearts. Follow the gold path east.' },
        'sign-crossing': { title: 'The old crossing', body: 'The creek runs deep. This wooden bridge is the only way across. Turn east on the far bank.' },
        'sign-dungeon': { title: 'Emberstone Hollow', body: 'A key, a gate, a sleeping guardian. Bring the Hollow Crown home. Walk through the stone arch to enter.' },
      };
      data.notice = { ...messages[sign.id], time: 7 };
    }
  } else {
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
  enemy.respawn = enemy.homeZone === 'overworld' ? 20 : 0;
  addEffect(data, 'poof', enemy.x, enemy.z, enemy.boss ? 1 : 0.6);
  addPickup(data, 'rupee', enemy.x, enemy.z);
  if (enemy.boss) {
    data.quest.boss = true;
    data.projectiles = data.projectiles.filter(projectile => projectile.ownerId !== enemy.id);
    data.hazards = data.hazards.filter(hazard => hazard.ownerId !== enemy.id);
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
    if (enemy.boss && (!data.quest.gate || enemy.attackMode === 'charge') || !swordLineClear(data, enemy)) continue;
    data.attackHitIds.push(enemy.id);
    if (enemy.boss && enemy.damageCooldown > 0) continue;
    enemy.hp--;
    if (!enemy.navigation.chasing) {
      enemy.navigation.path = []; enemy.navigation.index = 0; enemy.navigation.repath = 0;
      enemy.navigation.noPath = false; enemy.navigation.pending = false;
    }
    enemy.navigation.chasing = true;
    enemy.navigation.returning = false;
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

interface NavigationTick {
  revision: string;
  graphs: Map<boolean, NavigationGraph>;
  stats: AdventureData['navigationStats'];
}
const navigationGraphs = new Map<string, NavigationGraph>();
const defaultBreakables = { overworld: createBreakables('overworld'), dungeon: createBreakables('dungeon') };

function breakablesIn(data: AdventureData, zone: Zone) {
  return data.zone === zone ? data.breakables : data.zoneMemory[zone]?.breakables ?? defaultBreakables[zone];
}

function beginNavigationTick(data: AdventureData): NavigationTick {
  const layouts = zones.map(zone => ({ zone,
    tiles: Object.entries(data.tileOverrides[zone] ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    pots: breakablesIn(data, zone).filter(item => item.alive && item.kind === 'pot').map(item => [item.x, item.z]).sort(([ax, az], [bx, bz]) => ax - bx || az - bz),
  }));
  return { revision: JSON.stringify([data.quest.gate, layouts, data.portals]), graphs: new Map(), stats: data.navigationStats };
}

/** Graph callbacks capture immutable obstacles, so caches never change under a path. */
function navigationGraph(data: AdventureData, enemy: Enemy, tick: NavigationTick): NavigationGraph {
  const local = tick.graphs.get(enemy.boss);
  if (local) return local;
  const r = radius(enemy);
  const boss = enemy.boss;
  const key = `${r}:${tick.revision}`;
  let graph = navigationGraphs.get(key);
  if (!graph) {
    const regions = zones.map(zone => {
      const world = getWorld(zone);
      const obstacles = { zone, quest: { ...data.quest }, tileOverrides: Object.fromEntries(zones.map(region => [region, { ...data.tileOverrides[region] }])),
        breakables: breakablesIn(data, zone).filter(item => item.alive && item.kind === 'pot').map(item => ({ ...item })) };
      const grid = createNavigationGrid(world.width, world.height, (x, z) => {
        if (isBlocked(obstacles, x, z, r)) return true;
        if (zone === 'overworld' && distance({ x, z }, OVERWORLD_SPAWN) < SPAWN_SAFE_RADIUS + r) return true;
        return boss && zone === 'dungeon' && z < 18.6;
      }, (x, z) => isBlocked(obstacles, x, z, 0.035));
      return { id: zone, grid };
    });
    graph = createNavigationGraph(regions, zones.flatMap(zone => getWorld(zone).chunks), data.portals);
    if (navigationGraphs.size >= 16) navigationGraphs.delete(navigationGraphs.keys().next().value!);
    navigationGraphs.set(key, graph);
  }
  tick.graphs.set(enemy.boss, graph);
  return graph;
}

function navigate(data: AdventureData, enemy: Enemy, target: NavigationLocation, dt: number, tick: NavigationTick, goalRadius = enemy.boss ? 1.8 : 1.3): { x: number; z: number; reachable: boolean } {
  const nav = enemy.navigation;
  nav.repath -= dt;
  const graph = navigationGraph(data, enemy, tick);
  const grid = graph.regions.get(data.zone)!;
  const changed = target.region !== nav.targetRegion || Math.hypot(target.x - nav.targetX, target.z - nav.targetZ) > 0.8;
  if (nav.revision !== tick.revision) {
    nav.path = []; nav.index = 0; nav.repath = 0; nav.noPath = false;
    nav.revision = tick.revision;
    enemy.vx = enemy.vz = 0;
  }
  if (nav.repath <= 0 || changed && !nav.noPath) {
    if (tick.stats.searches < PATHFINDING_SEARCHES_PER_TICK && tick.stats.expansions < PATHFINDING_EXPANSIONS_PER_TICK) {
      const result = findWorldPath(graph, { x: enemy.x, z: enemy.z, region: data.zone }, target, {
        goalRadius, traversableByAI: true,
        maxExpansions: PATHFINDING_EXPANSIONS_PER_TICK - tick.stats.expansions,
      });
      tick.stats.searches++;
      tick.stats.expansions += result.expansions;
      nav.pending = result.status === 'budget-exhausted';
      if (!nav.pending) {
        nav.path = result.path;
        nav.index = 0;
        nav.targetX = target.x;
        nav.targetZ = target.z;
        nav.targetRegion = target.region;
        nav.noPath = result.status === 'no-path';
        nav.repath = nav.noPath ? 1.2 : enemy.boss ? 0.42 : 0.6;
      } else tick.stats.deferred++;
    } else { nav.pending = true; tick.stats.deferred++; }
  }
  while (nav.index < nav.path.length) {
    const point = nav.path[nav.index];
    // A portal destination must be consumed by traversal, never by proximity.
    if (point.portalId || point.region !== data.zone || distance(enemy, point) >= 0.18) break;
    const following = nav.path[nav.index + 1];
    // Close to a corner is not necessarily far enough around it. Finish the
    // approach before skipping a waypoint whose next segment clips the wall.
    if (following && !following.portalId && following.region === data.zone && !grid.canTravel(enemy, following) && distance(enemy, point) > 0.025) break;
    nav.index++;
  }
  // Smooth walking segments, stopping at the source of every portal edge.
  let furthest = nav.index;
  for (let next = nav.index; next <= Math.min(nav.index + 3, nav.path.length - 1); next++) {
    if (nav.path[next].portalId || nav.path[next].region !== data.zone) break;
    furthest = next;
  }
  for (let next = furthest; next > nav.index; next--) {
    if (grid.canTravel(enemy, nav.path[next])) { nav.index = next; break; }
  }
  const point = nav.path[nav.index];
  if (!point) return { x: 0, z: 0, reachable: nav.path.length > 0 };
  if (point.portalId) return { x: 0, z: 0, reachable: true };
  if (point.region !== data.zone || !grid.canTravel(enemy, point)) {
    nav.path = []; nav.index = 0; nav.repath = 0; nav.pending = true;
    enemy.vx = enemy.vz = 0;
    return { x: 0, z: 0, reachable: false };
  }
  const dx = point.x - enemy.x;
  const dz = point.z - enemy.z;
  const length = Math.hypot(dx, dz) || 1;
  return { x: dx / length, z: dz / length, reachable: true };
}

function viewInZone(data: AdventureData, zone: Zone): AdventureData {
  if (zone === data.zone) return data;
  const saved = data.zoneMemory[zone];
  return { ...data, zone,
    enemies: saved?.enemies ?? [], breakables: saved?.breakables ?? defaultBreakables[zone], pickups: saved?.pickups ?? [],
    zoneMemory: { ...data.zoneMemory, [data.zone]: { enemies: data.enemies, breakables: data.breakables, pickups: data.pickups } },
  };
}

function transferEnemy(data: AdventureData, from: Zone, to: Zone, enemy: Enemy): void {
  if (from === to) return;
  if (from === data.zone) data.enemies = data.enemies.filter(item => item.id !== enemy.id);
  else data.zoneMemory[from]!.enemies = data.zoneMemory[from]!.enemies.filter(item => item.id !== enemy.id);
  if (to === data.zone) data.enemies.push(enemy);
  else {
    data.zoneMemory[to] ??= { enemies: createEnemies(to), breakables: createBreakables(to), pickups: [] };
    data.zoneMemory[to]!.enemies.push(enemy);
  }
}

function traverseEnemyPortal(root: AdventureData, data: AdventureData, enemy: Enemy): boolean {
  const nav = enemy.navigation;
  const waypoint = nav.path[nav.index];
  if (!waypoint?.portalId) return false;
  const portal = root.portals.find(item => item.id === waypoint.portalId);
  const endpoints = portal && portalEndpoints(portal);
  if (!portal?.traversableByAI || !endpoints || endpoints.from.region !== data.zone || distance(enemy, endpoints.from) > 0.22) return false;
  const destination = endpoints.to.region as Zone;
  const target = viewInZone(root, destination);
  if (!clearTravel(data, enemy, endpoints.from, radius(enemy), enemy) || !allowed(target, endpoints.to.x, endpoints.to.z, radius(enemy), enemy)) {
    nav.path = []; nav.index = 0; nav.repath = 0; nav.pending = true;
    enemy.vx = enemy.vz = 0;
    return false;
  }
  Object.assign(enemy, { x: endpoints.to.x, z: endpoints.to.z, vx: 0, vz: 0 });
  nav.index++;
  transferEnemy(root, data.zone, destination, enemy);
  return true;
}

/** Choose a clear local segment before moving, rather than pushing against a wall. */
function wanderSteering(data: AdventureData, enemy: Enemy, dt: number): { x: number; z: number } {
  enemy.wanderTime -= dt;
  if (enemy.wanderTime <= 0) {
    enemy.wanderAngle = random(data) * Math.PI * 2;
    enemy.wanderTime = 1 + random(data) * 2;
  }
  for (let turn = 0; turn < 8; turn++) {
    const angle = enemy.wanderAngle + turn * Math.PI / 4;
    const direction = facingVector(angle);
    if (!clearTravel(data, enemy, { x: enemy.x + direction.x * 0.65, z: enemy.z + direction.z * 0.65 }, radius(enemy), enemy)) continue;
    enemy.wanderAngle = angle;
    return direction;
  }
  enemy.vx = enemy.vz = 0;
  return { x: 0, z: 0 };
}

function beginBossTell(data: AdventureData, enemy: Enemy, mode: 'telegraph' | 'chargeTelegraph', sounds: SoundName[]): void {
  enemy.attackMode = mode;
  enemy.attackTimer = mode === 'telegraph' ? BOSS_TELEGRAPH : BOSS_CHARGE_TELEGRAPH;
  enemy.aimX = data.player.x;
  enemy.aimZ = data.player.z;
  enemy.vx = enemy.vz = 0;
  sounds.push('warning');
}

function fireBoss(data: AdventureData, enemy: Enemy, sounds: SoundName[]): void {
  const angle = Math.atan2(enemy.aimZ - enemy.z, enemy.aimX - enemy.x);
  const direction = facingVector(angle);
  const offsets = enemy.phase === 2 ? [-BOSS_BLAST_SPREAD, 0, BOSS_BLAST_SPREAD] : [0];
  for (const offset of offsets) {
    const startX = enemy.x + direction.x * 0.9;
    const startZ = enemy.z + direction.z * 0.9;
    const targetX = enemy.aimX - direction.z * offset;
    const targetZ = enemy.aimZ + direction.x * offset;
    const flightTime = clamp(Math.hypot(targetX - startX, targetZ - startZ) / 6, 0.45, 1.1);
    data.projectiles.push({
      id: `projectile-${data.nextId++}`, ownerId: enemy.id,
      x: startX, z: startZ, startX, startZ, targetX, targetZ, flightTime,
      vx: (targetX - startX) / flightTime, vz: (targetZ - startZ) / flightTime, age: 0, duration: 3, radius: 0.22,
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
      enemy.attackMode = 'recover';
      enemy.attackTimer = 0.28;
    }
    return { x: 0, z: 0, speed: 0 };
  }
  if (enemy.attackMode === 'chargeTelegraph') {
    if (enemy.attackTimer <= 0) {
      enemy.attackMode = 'charge';
      enemy.attackTimer = BOSS_CHARGE_DURATION;
      enemy.rangedCooldown = enemy.phase === 2 ? 1.5 : 2;
      enemy.lastAttack = Math.max(0, enemy.lastAttack) + 1;
      enemy.wanderAngle = Math.atan2(enemy.aimZ - enemy.z, enemy.aimX - enemy.x);
      enemy.hitstun = 0;
      sounds.push('fire');
    }
    return { x: 0, z: 0, speed: 0 };
  }
  if (enemy.attackMode === 'charge') {
    if (enemy.attackTimer <= 0) { enemy.attackMode = 'recover'; enemy.attackTimer = 0.48; return { x: 0, z: 0, speed: 0 }; }
    const direction = facingVector(enemy.wanderAngle);
    return { ...direction, speed: BOSS_CHARGE_SPEED };
  }
  if (enemy.attackMode === 'recover') {
    if (enemy.attackTimer <= 0) enemy.attackMode = 'pursue';
    return { x: 0, z: 0, speed: 0 };
  }
  if (enemy.rangedCooldown <= 0 || !steering.reachable && enemy.navigation.stuck > 0.8 && enemy.rangedCooldown < 0.85) {
    const canCharge = steering.reachable && distance(enemy, data.player) <= BOSS_CHARGE_RANGE && clearTravel(data, enemy, data.player, radius(enemy), enemy);
    const mode = canCharge ? 'chargeTelegraph' : 'telegraph';
    beginBossTell(data, enemy, mode, sounds);
    return { x: 0, z: 0, speed: 0 };
  }
  return { ...steering, speed: enemy.phase === 2 ? 2.9 : 2.45 };
}

function enemyAI(data: AdventureData, enemy: Enemy, dt: number, sounds: SoundName[], tick: NavigationTick, root = data): void {
  enemy.contactCooldown = Math.max(0, enemy.contactCooldown - dt);
  enemy.damageCooldown = Math.max(0, enemy.damageCooldown - dt);
  enemy.flash = Math.max(0, enemy.flash - dt);
  if (enemy.boss && enemy.attackMode === 'charge') enemy.hitstun = 0;
  if (!enemy.alive) {
    if (enemy.homeZone !== 'overworld') return;
    enemy.respawn -= dt;
    if (enemy.respawn <= 0 && distance(data.player, { x: enemy.homeX, z: enemy.homeZ }) > 3) {
      Object.assign(enemy, { alive: true, hp: enemy.maxHp, x: enemy.homeX, z: enemy.homeZ, vx: 0, vz: 0, facing: -Math.PI / 2, hitstun: 0, flash: 0.3 });
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
  const sameZone = root.zone === data.zone;
  if (enemy.boss && data.zone === 'dungeon' && (!data.quest.gate || !enemy.navigation.chasing && sameZone && data.player.z < 18.5)) {
    enemy.vx = enemy.vz = 0;
    return;
  }
  const playerDistance = sameZone ? distance(enemy, data.player) : Infinity;
  const playerSafe = sameZone && data.zone === 'overworld' && distance(data.player, OVERWORLD_SPAWN) < SPAWN_SAFE_RADIUS;
  const homeDistance = distance(enemy, { x: enemy.homeX, z: enemy.homeZ });
  const nav = enemy.navigation;
  nav.retry = Math.max(0, (nav.retry ?? 0) - dt);
  if (nav.revision !== tick.revision) nav.retry = 0;
  if (sameZone && (enemy.boss || !playerSafe && playerDistance < 8 && nav.retry <= 0) && !nav.chasing) {
    nav.chasing = true;
    nav.returning = false;
    nav.path = []; nav.index = 0; nav.repath = 0; nav.noPath = false; nav.pending = false;
    enemy.vx = enemy.vz = 0;
  }
  if (nav.chasing && (playerSafe || !enemy.boss && nav.stuck > 15 && playerDistance > 10)) beginReturnHome(enemy);
  if (!nav.chasing && !nav.returning && (homeDistance > 2.4 || enemy.homeZone !== data.zone || playerSafe && homeDistance > 1.2)) beginReturnHome(enemy);
  let targetX = 0;
  let targetZ = 0;
  let speed = 0.55;
  if (nav.chasing) {
    const steering = navigate(data, enemy, { x: data.player.x, z: data.player.z, region: root.zone }, dt, tick);
    if (traverseEnemyPortal(root, data, enemy)) return;
    if (enemy.boss && sameZone) {
      const motion = bossMotion(data, enemy, dt, steering, sounds);
      targetX = motion.x;
      targetZ = motion.z;
      speed = motion.speed;
    } else {
      targetX = steering.x; targetZ = steering.z; speed = 1.85;
      if (!steering.reachable && nav.noPath && !nav.pending) {
        nav.failures = Math.min(4, (nav.failures ?? 0) + 1);
        nav.retry = 1.2 * nav.failures;
        beginReturnHome(enemy);
      } else if (steering.reachable) nav.failures = 0;
    }
  } else if (nav.returning && enemy.homeZone === data.zone && homeDistance <= HOME_ARRIVAL_DISTANCE) {
    nav.returning = false;
    nav.path = []; nav.index = 0; nav.repath = 0; nav.noPath = false; nav.pending = false;
    enemy.vx = enemy.vz = 0;
    speed = 0;
  } else if (nav.returning) {
    // A small goal neighborhood supports fractional spawn coordinates. The
    // navigator appends the actual home point when its floor is accessible.
    const steering = navigate(data, enemy, { x: enemy.homeX, z: enemy.homeZ, region: enemy.homeZone }, dt, tick, 0.75);
    if (traverseEnemyPortal(root, data, enemy)) return;
    targetX = steering.x;
    targetZ = steering.z;
    speed = 1.25;
    const stoppedShort = nav.path.length > 0 && nav.index >= nav.path.length && enemy.homeZone === data.zone && homeDistance > HOME_ARRIVAL_DISTANCE;
    if (stoppedShort) {
      // Seeing a spawn beside a solid object is not enough room to stand on it.
      // Keep the same safe fallback as a failed search rather than idling there.
      nav.path = []; nav.index = 0; nav.noPath = true; nav.repath = 1.2;
    }
    if ((!steering.reachable || stoppedShort) && nav.noPath && !nav.pending) {
      const wander = wanderSteering(data, enemy, dt);
      targetX = wander.x; targetZ = wander.z; speed = 0.55;
    }
  } else {
    nav.path = [];
    nav.repath = 0;
    const wander = wanderSteering(data, enemy, dt);
    targetX = wander.x;
    targetZ = wander.z;
  }
  const blend = 1 - Math.exp(-12 * dt);
  enemy.vx += (targetX * speed - enemy.vx) * blend;
  enemy.vz += (targetZ * speed - enemy.vz) * blend;
  const oldX = enemy.x;
  const oldZ = enemy.z;
  move(data, enemy, enemy.vx * dt, enemy.vz * dt, radius(enemy), enemy);
  const dx = enemy.x - oldX;
  const dz = enemy.z - oldZ;
  if (Math.hypot(dx, dz) > 0.00001) enemy.facing = Math.atan2(dz, dx);
  if (nav.chasing && speed > 0.5) {
    const progressed = distance(enemy, { x: oldX, z: oldZ }) > dt * speed * 0.15;
    nav.stuck = progressed ? Math.max(0, nav.stuck - dt * 3) : nav.stuck + dt;
  }
  if (nav.chasing && nav.stuck > 0.6 && (targetX || targetZ)) {
    nav.path = []; nav.index = 0; nav.repath = 0;
    enemy.vx = enemy.vz = 0;
  }
}

function updateEnemies(data: AdventureData, dt: number, sounds: SoundName[]): void {
  const tick = beginNavigationTick(data);
  const jobs = zones.flatMap(zone => {
    const enemies = zone === data.zone ? data.enemies : data.zoneMemory[zone]?.enemies ?? [];
    return enemies.filter(enemy => zone === data.zone || enemy.alive && (enemy.navigation.chasing || enemy.navigation.returning)).map(enemy => ({ zone, enemy }));
  });
  if (!jobs.length) return;
  const cursor = data.navigationCursor % jobs.length;
  // Snapshot the turn list so arrivals never receive a second update this tick.
  for (let offset = 0; offset < jobs.length; offset++) {
    const { zone, enemy } = jobs[(cursor + offset) % jobs.length];
    if (!enemy.alive && enemy.respawn > 0 && zone !== enemy.homeZone) {
      transferEnemy(data, zone, enemy.homeZone, enemy);
      continue;
    }
    const view = viewInZone(data, zone);
    enemyAI(view, enemy, dt, sounds, tick, data);
    // Offscreen wander/respawn use the same seeded stream as visible actors.
    if (view !== data) data.seed = view.seed;
  }
  data.navigationCursor = (cursor + 1) % jobs.length;
}

function hurtByEmber(data: AdventureData, dx: number, dz: number, sounds: SoundName[]): void {
  if (data.player.invulnerable > 0) return;
  data.player.hp = Math.max(0, data.player.hp - 1);
  data.player.invulnerable = 1.25;
  const length = Math.hypot(dx, dz) || 1;
  data.player.vx = dx / length * 6;
  data.player.vz = dz / length * 6;
  data.shake = 0.22;
  data.hurtFlash = 0.4;
  addEffect(data, 'hit', data.player.x, data.player.z, 0.3);
  sounds.push('hurt');
  if (data.player.hp <= 0) data.status = 'gameover';
}

/** Boss lobs fly over cover and bodies, exploding only at their locked landing. */
function updateProjectiles(data: AdventureData, dt: number, sounds: SoundName[]): void {
  data.projectiles = data.projectiles.filter(projectile => {
    if (!data.enemies.some(enemy => enemy.id === projectile.ownerId && enemy.alive)) return false;
    const oldAge = projectile.age;
    projectile.age += dt;
    if (projectile.targetX !== undefined && projectile.targetZ !== undefined && projectile.flightTime !== undefined && projectile.flightTime > 0) {
      const startX = projectile.startX ?? projectile.x - projectile.vx * oldAge;
      const startZ = projectile.startZ ?? projectile.z - projectile.vz * oldAge;
      const progress = clamp(projectile.age / projectile.flightTime, 0, 1);
      projectile.x = startX + (projectile.targetX - startX) * progress;
      projectile.z = startZ + (projectile.targetZ - startZ) * progress;
      if (projectile.age < projectile.flightTime) return projectile.age < projectile.duration;
      data.hazards.push({ id: `hazard-${data.nextId++}`, ownerId: projectile.ownerId, x: projectile.targetX, z: projectile.targetZ, age: 0, duration: BOSS_EMBER_DURATION, radius: BOSS_BLAST_RADIUS });
      addEffect(data, 'blast', projectile.targetX, projectile.targetZ, 0.5);
      data.shake = Math.max(data.shake, 0.09);
      sounds.push('blast');
      return false;
    }
    // Older untargeted projectiles retain their straight-line collision behavior.
    if (projectile.age >= projectile.duration) return false;
    const oldX = projectile.x;
    const oldZ = projectile.z;
    projectile.x += projectile.vx * dt;
    projectile.z += projectile.vz * dt;
    const dx = projectile.x - oldX;
    const dz = projectile.z - oldZ;
    const along = clamp(((data.player.x - oldX) * dx + (data.player.z - oldZ) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    if (Math.hypot(data.player.x - oldX - dx * along, data.player.z - oldZ - dz * along) > PLAYER_RADIUS + projectile.radius) return true;
    hurtByEmber(data, projectile.vx, projectile.vz, sounds);
    return false;
  });
}

function updateHazards(data: AdventureData, dt: number, sounds: SoundName[]): void {
  data.hazards = data.hazards.filter(hazard => {
    const owner = data.enemies.find(enemy => enemy.id === hazard.ownerId && enemy.alive);
    if (!owner) return false;
    hazard.age += dt;
    if (hazard.age >= hazard.duration) return false;
    const dx = data.player.x - hazard.x;
    const dz = data.player.z - hazard.z;
    if (Math.hypot(dx, dz) <= hazard.radius + PLAYER_RADIUS) {
      const centered = Math.hypot(dx, dz) < 0.001;
      hurtByEmber(data, centered ? data.player.x - owner.x || 1 : dx, centered ? data.player.z - owner.z : dz, sounds);
    }
    return true;
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
      const charging = enemy.boss && enemy.attackMode === 'charge';
      const enemyShare = charging ? 0 : enemy.boss ? 0.3 : 0.55;
      move(data, enemy, nx * overlap * enemyShare, nz * overlap * enemyShare, radius(enemy), enemy);
      move(data, data.player, -nx * overlap * (1 - enemyShare), -nz * overlap * (1 - enemyShare), PLAYER_RADIUS);
      // If a wall prevents one body's movement, the other absorbs the correction.
      const remaining = minimum - distance(data.player, enemy);
      if (remaining > 0.001) {
        if (!charging) move(data, enemy, nx * (remaining + 0.002), nz * (remaining + 0.002), radius(enemy), enemy);
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
        const aCharging = a.boss && a.attackMode === 'charge';
        const bCharging = b.boss && b.attackMode === 'charge';
        const overlap = minimum - length + 0.002;
        if (!aCharging) move(data, a, -nx * overlap * (bCharging ? 1 : 0.5), -nz * overlap * (bCharging ? 1 : 0.5), radius(a), a);
        if (!bCharging) move(data, b, nx * overlap * (aCharging ? 1 : 0.5), nz * overlap * (aCharging ? 1 : 0.5), radius(b), b);
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
  updateEnemies(data, dt, sounds);
  updateProjectiles(data, dt, sounds);
  updateHazards(data, dt, sounds);
  separate(data, sounds);
  if (data.status === 'playing') {
    collectPickups(data, dt, sounds);
    openGate(data, sounds);
  }
  const pressedInteract = input.interact && !data.inputLatch.interact;
  data.inputLatch.interact = input.interact;
  if (data.status === 'playing') {
    const traversed = pressedInteract && interact(data, sounds);
    if (data.status === 'playing' && !traversed) walkThroughPortal(data, sounds);
  }
  data.area = areaName(data.zone, player.x, player.z);
  return { data, sounds };
}
