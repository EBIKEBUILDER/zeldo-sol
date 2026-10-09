import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialData, isBlocked, stepGame } from '../game/simulation';
import { CHEST_POSITION, DUNGEON_ENTRANCE, DUNGEON_SPAWN, FIXED_STEP, type GameInput, type Zone } from '../game/types';

type Data = ReturnType<typeof createInitialData>;
const idle: GameInput = { x: 0, z: 0, attack: false, interact: false };

function quietWorld(zone: Zone = 'overworld'): Data {
  const data = createInitialData('playing');
  data.zone = zone;
  data.enemies = [];
  data.breakables = [];
  data.pickups = [];
  return data;
}

function tick(data: Data, input: Partial<GameInput> = {}): Data {
  return stepGame(data, FIXED_STEP, { ...idle, ...input }).data;
}

function advance(data: Data, seconds: number, input: Partial<GameInput> = {}): Data {
  for (let frame = 0; frame < Math.round(seconds / FIXED_STEP); frame++) data = tick(data, input);
  return data;
}

test('walking into either stone doorway changes zone without interacting and uses its exact landing', () => {
  let data = quietWorld();
  Object.assign(data.player, { x: DUNGEON_ENTRANCE.x, z: DUNGEON_ENTRANCE.z - 3 });
  for (let frame = 0; frame < 120 && data.zone === 'overworld'; frame++) data = tick(data, { z: 1 });
  assert.equal(data.zone, 'dungeon');
  assert.equal(data.player.x, DUNGEON_SPAWN.x);
  assert.equal(data.player.z, DUNGEON_SPAWN.z);
  assert.equal(data.player.vx, 0);
  assert.equal(data.player.vz, 0);
  assert.equal(data.inputLatch.interact, false);
  assert.equal(isBlocked(data, data.player.x, data.player.z), false);
  assert.ok(data.pickups.some(item => item.kind === 'key'), 'Entry still creates the dungeon key');
  data.enemies = [];
  data = advance(data, 1);
  assert.equal(data.zone, 'dungeon', 'The dungeon landing must not bounce through the return arch');
  for (let frame = 0; frame < 120 && data.zone === 'dungeon'; frame++) data = tick(data, { z: -1 });
  assert.equal(data.zone, 'overworld');
  assert.equal(data.player.x, DUNGEON_ENTRANCE.x);
  assert.equal(data.player.z, DUNGEON_ENTRANCE.z - 2);
  assert.equal(data.inputLatch.interact, false);
  data = advance(data, 2);
  assert.equal(data.zone, 'overworld', 'The return landing must not immediately enter the dungeon again');
});

test('automatic entry waits for the doorway while E retains its nearby activation radius', () => {
  let data = quietWorld();
  Object.assign(data.player, { x: DUNGEON_ENTRANCE.x, z: DUNGEON_ENTRANCE.z - 2.1 });
  data = advance(data, 0.5);
  assert.equal(data.zone, 'overworld');
  const entry = stepGame(data, FIXED_STEP, { ...idle, interact: true });
  assert.equal(entry.data.zone, 'dungeon');
  assert.equal(entry.sounds.filter(sound => sound === 'gate').length, 1, 'E and proximity must not traverse twice in one tick');
});

test('automatic travel preserves dungeon state and clears projectiles just like manual travel', () => {
  let data = quietWorld();
  Object.assign(data.player, DUNGEON_ENTRANCE);
  data = tick(data);
  data.quest.key = true;
  data.quest.gate = true;
  data.quest.boss = true;
  data.enemies = [{ ...data.enemies[0], alive: false, hp: 0 }];
  const defeatedId = data.enemies[0].id;
  data.breakables = [{ id: 'broken-pot', kind: 'pot', x: 5, z: 8, alive: false }];
  data.pickups = [{ id: 'left-gem', kind: 'rupee', x: 8, z: 12, age: 0 }];
  data.projectiles = [{ id: 'departing-shot', x: 12, z: 27, vx: 0, vz: -6, radius: 0.22, age: 0, duration: 3, ownerId: 'warden' }];
  Object.assign(data.player, { x: 12, z: 2 });
  data = tick(data);
  assert.equal(data.zone, 'overworld');
  assert.equal(data.projectiles.length, 0);
  Object.assign(data.player, DUNGEON_ENTRANCE);
  data = tick(data);
  assert.equal(data.zone, 'dungeon');
  assert.equal(data.enemies.find(enemy => enemy.id === defeatedId)?.alive, false);
  assert.equal(data.breakables.find(item => item.id === 'broken-pot')?.alive, false);
  assert.ok(data.pickups.some(item => item.id === 'left-gem'));
  assert.ok(data.pickups.every(item => item.kind !== 'key'));
  assert.deepEqual(data.quest, { key: true, gate: true, boss: true, treasure: false });
});

test('automatic portals use mutable declarations and do not cross blocked source or destination geometry', () => {
  let data = quietWorld('dungeon');
  data.portals = [{ id: 'blocked-destination', fromChunk: 'dungeon', fromTile: { x: 12, z: 8 }, toChunk: 'dungeon', toTile: { x: 12, z: 17 }, traversalCost: 1, traversableByAI: false }];
  Object.assign(data.player, { x: 12, z: 8 });
  data = tick(data);
  assert.equal(data.player.z, 8, 'The locked quest gate blocks landing');
  data.quest.gate = true;
  data = tick(data);
  assert.equal(data.player.z, 17);

  data = quietWorld('dungeon');
  data.portals = [{ id: 'blocked-approach', fromChunk: 'dungeon', fromTile: { x: 12, z: 17.1 }, toChunk: 'dungeon', toTile: { x: 12, z: 22 }, traversalCost: 1, traversableByAI: false }];
  Object.assign(data.player, { x: 12, z: 16 });
  data = tick(data);
  assert.equal(data.player.z, 16, 'Being near a portal through a closed gate cannot bypass that gate');
  data.quest.gate = true;
  data = tick(data);
  assert.equal(data.player.z, 22);

  data = quietWorld();
  data.portals[0].toTile = { x: 13, z: 5 };
  Object.assign(data.player, DUNGEON_ENTRANCE);
  data = tick(data);
  assert.equal(data.zone, 'dungeon');
  assert.equal(data.player.x, 13);
  assert.equal(data.player.z, 5, 'Travel uses the declared landing instead of a hardcoded spawn');
});

test('overlapping reciprocal arrivals rearm after walking clear and survive JSON replay', () => {
  let first = quietWorld('dungeon');
  first.portals = [
    { id: 'outbound-warp', fromChunk: 'dungeon', fromTile: { x: 12, z: 8 }, toChunk: 'dungeon', toTile: { x: 12, z: 10 }, traversalCost: 1, traversableByAI: false },
    { id: 'return-warp', fromChunk: 'dungeon', fromTile: { x: 12, z: 10 }, toChunk: 'dungeon', toTile: { x: 12, z: 8 }, traversalCost: 1, traversableByAI: false },
  ];
  Object.assign(first.player, { x: 12, z: 8 });
  first = tick(first);
  assert.equal(first.player.z, 10);
  assert.deepEqual(first.portalArrivalLocks, ['return-warp']);
  first = advance(first, 1);
  assert.equal(first.player.z, 10, 'Standing on an overlapping arrival does not bounce');
  let second = JSON.parse(JSON.stringify(first)) as Data;
  for (let frame = 0; frame < 30; frame++) {
    first = tick(first, { x: 1 });
    second = tick(second, { x: 1 });
  }
  assert.deepEqual(first.portalArrivalLocks, []);
  assert.deepEqual(first, second);
  let returned = false;
  for (let frame = 0; frame < 120 && !returned; frame++) {
    first = tick(first, { x: -1 });
    second = tick(second, { x: -1 });
    returned = first.player.z === 8;
  }
  assert.ok(returned, 'Walking back to the rearmed portal should traverse it');
  assert.deepEqual(first, second);
  assert.deepEqual(first.portalArrivalLocks, ['outbound-warp']);
});

test('doorway automation keeps chest and sign interaction explicit', () => {
  let data = quietWorld('dungeon');
  data.quest.boss = data.quest.gate = true;
  Object.assign(data.player, { x: CHEST_POSITION.x, z: CHEST_POSITION.z - 1.3 });
  data = tick(data);
  assert.equal(data.quest.treasure, false);
  assert.equal(data.status, 'playing');
  data = tick(data, { interact: true });
  assert.equal(data.status, 'victory');

  data = quietWorld();
  data.notice = null;
  Object.assign(data.player, { x: 40, z: 21.8 });
  data = tick(data);
  assert.equal(data.notice, null);
  data = tick(data, { interact: true });
  assert.equal(data.notice?.title, 'Emberstone Hollow');
  assert.match(data.notice?.body ?? '', /Walk through the stone arch/);
});
