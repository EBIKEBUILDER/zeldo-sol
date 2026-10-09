import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PATHFINDING_EXPANSIONS_PER_TICK,
  PATHFINDING_SEARCHES_PER_TICK,
  createInitialData,
  isBlocked,
  setTileKind,
  stepGame,
} from '../game/simulation';
import { createEnemies, getWorld } from '../game/world';
import { DUNGEON_ENTRANCE, FIXED_STEP, type Enemy, type GameInput, type Zone } from '../game/types';

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

function monsterAt(zone: Zone, id: string, x: number, z: number): Enemy {
  const source = createEnemies(zone)[0];
  return {
    ...source, id, x, z, homeX: x, homeZ: z,
    navigation: { ...source.navigation, path: [], targetX: x, targetZ: z },
  };
}

function tick(data: Data, input: GameInput = idle): Data {
  data.player.invulnerable = 0.75;
  return stepGame(data, FIXED_STEP, input).data;
}

function allMonsters(data: Data): Enemy[] {
  return [...data.enemies, ...Object.values(data.zoneMemory).flatMap(saved => saved!.enemies)];
}

function portalPursuit(enabled: boolean): { data: Data; id: string; start: { x: number; z: number } } {
  let data = quietWorld();
  Object.assign(data.player, DUNGEON_ENTRANCE);
  const follower = monsterAt('overworld', 'portal-follower', 42, 23);
  follower.hp = 1;
  follower.navigation.chasing = true;
  follower.vz = 0.7;
  data.enemies = [follower];
  data.portals.find(portal => portal.id === 'dungeon-mouth')!.traversableByAI = enabled;
  data = tick(data, { ...idle, interact: true });
  assert.equal(data.zone, 'dungeon');
  // Keep the fixture focused on the monster following from the saved overworld.
  data.enemies = [];
  data.breakables = [];
  data.pickups = [];
  const saved = data.zoneMemory.overworld!.enemies[0];
  return { data, id: follower.id, start: { x: saved.x, z: saved.z } };
}

test('regular pursuit crosses an adjacent overworld chunk seam without stopping', () => {
  let data = quietWorld();
  Object.assign(data.player, { x: 20, z: 5 });
  data.enemies = [monsterAt('overworld', 'seam-follower', 15, 5)];
  let crossed = false;
  for (let frame = 0; frame < 240; frame++) {
    data = tick(data);
    const enemy = data.enemies[0];
    crossed ||= enemy.x > 16.5;
    assert.equal(isBlocked(data, enemy.x, enemy.z, 0.46), false);
  }
  assert.ok(crossed, 'The x=16 chunk boundary must be ordinary walkable floor');
  assert.ok(Math.hypot(data.enemies[0].x - data.player.x, data.enemies[0].z - data.player.z) < 1.5);
});

test('dungeon entrances leash monsters by default and clear their pursuit velocity', () => {
  const firstRun = createInitialData('playing');
  assert.ok(firstRun.portals.every(portal => !portal.traversableByAI));
  firstRun.portals[0].traversableByAI = true;
  assert.equal(createInitialData('playing').portals[0].traversableByAI, false, 'Portal flags belong to each run');
  let { data, id } = portalPursuit(false);
  data = tick(data);
  const saved = data.zoneMemory.overworld!.enemies.find(enemy => enemy.id === id)!;
  assert.equal(saved.navigation.chasing, false);
  assert.equal(saved.vx, 0);
  assert.equal(saved.vz, 0);
  for (let frame = 0; frame < 240; frame++) data = tick(data);
  assert.ok(data.enemies.every(enemy => enemy.id !== id));
  assert.equal(allMonsters(data).filter(enemy => enemy.id === id).length, 1);
});

test('an AI-enabled entrance walks a saved pursuer to its portal and migrates it exactly once', () => {
  let { data, id, start } = portalPursuit(true);
  let sawOffscreenMovement = false;
  let arrived = false;
  for (let frame = 0; frame < 360; frame++) {
    data = tick(data);
    assert.equal(allMonsters(data).filter(enemy => enemy.id === id).length, 1, 'A transfer must move the entity rather than duplicate it');
    const saved = data.zoneMemory.overworld?.enemies.find(enemy => enemy.id === id);
    if (saved && Math.hypot(saved.x - start.x, saved.z - start.z) > 0.25) sawOffscreenMovement = true;
    const active = data.enemies.find(enemy => enemy.id === id);
    if (active) {
      assert.equal(active.hp, 1);
      assert.equal(active.homeZone, 'overworld');
      assert.equal(isBlocked(data, active.x, active.z, 0.46), false);
      arrived = true;
      break;
    }
  }
  assert.ok(sawOffscreenMovement, 'The saved monster must walk to the entrance before transferring');
  assert.ok(arrived, 'Enabling the directed entrance should let the pursuer reach the dungeon');
});

test('portal pursuit and enemy migration replay identically after JSON round-trips', () => {
  let { data: first, id } = portalPursuit(true);
  let second = JSON.parse(JSON.stringify(first)) as Data;
  for (let frame = 0; frame < 360; frame++) {
    first = tick(first);
    second = tick(second);
    if (frame % 37 === 0) second = JSON.parse(JSON.stringify(second)) as Data;
    assert.deepEqual(first, second, `Replay diverged at migration tick ${frame}`);
  }
  assert.ok(first.enemies.some(enemy => enemy.id === id));
});

test('a same-region AI warp is traversed during pursuit without duplicating the monster', () => {
  let data = quietWorld('dungeon');
  Object.assign(data.player, { x: 12, z: 13 });
  const enemy = monsterAt('dungeon', 'warp-follower', 12, 6);
  enemy.hp = 1;
  data.enemies = [enemy];
  data.portals.push({
    id: 'hall-warp', fromChunk: 'dungeon', fromTile: { x: 12, z: 7 },
    toChunk: 'dungeon', toTile: { x: 12, z: 11 }, traversalCost: 0, traversableByAI: true,
  });
  let warped = false;
  for (let frame = 0; frame < 180; frame++) {
    const previousZ = data.enemies[0].z;
    data = tick(data);
    const monster = data.enemies[0];
    warped ||= previousZ < 7.3 && monster.z > 10.5;
    assert.equal(data.zone, 'dungeon');
    assert.equal(allMonsters(data).filter(item => item.id === enemy.id).length, 1);
    assert.equal(monster.id, enemy.id);
    assert.equal(monster.hp, 1);
    assert.equal(isBlocked(data, monster.x, monster.z, 0.46), false);
  }
  assert.ok(warped, 'Pursuit should cross the cheap warp edge instead of walking the intervening tiles');
  assert.ok(Math.hypot(data.enemies[0].x - data.player.x, data.enemies[0].z - data.player.z) < 1.5);
});

test('player interaction uses a same-region portal destination from mutable run data', () => {
  let data = quietWorld('dungeon');
  Object.assign(data.player, { x: 12, z: 7 });
  data.portals.push({
    id: 'player-hall-warp', fromChunk: 'dungeon', fromTile: { x: 12, z: 7 },
    toChunk: 'dungeon', toTile: { x: 17, z: 11 }, traversalCost: 1, traversableByAI: false,
  });
  data = tick(data, { ...idle, interact: true });
  assert.equal(data.zone, 'dungeon');
  assert.equal(data.player.x, 17);
  assert.equal(data.player.z, 11);
  assert.equal(data.player.vx, 0);
  assert.equal(data.player.vz, 0);
  assert.equal(data.enemies.length, 0);
  assert.equal(Object.keys(data.zoneMemory).length, 0);
});

test('twelve simultaneous repaths respect the per-tick work budget without starvation', () => {
  let data = quietWorld('dungeon');
  Object.assign(data.player, { x: 12, z: 12 });
  data.enemies = Array.from({ length: 12 }, (_, index) => {
    const enemy = monsterAt('dungeon', `budget-${index}`, 8 + index % 6 * 2, 6 + Math.floor(index / 6) * 2);
    enemy.navigation.chasing = true;
    return enemy;
  });
  const served = new Set<string>();
  let sawDeferred = false;
  for (let frame = 0; frame < 12; frame++) {
    // Continuous demand from earlier monsters must not starve the later ones.
    for (const enemy of data.enemies) enemy.navigation.repath = 0;
    data = tick(data);
    assert.ok(data.navigationStats.searches <= PATHFINDING_SEARCHES_PER_TICK);
    assert.ok(data.navigationStats.expansions <= PATHFINDING_EXPANSIONS_PER_TICK);
    sawDeferred ||= data.navigationStats.deferred > 0;
    for (const enemy of data.enemies) {
      if (enemy.navigation.repath > 0 && enemy.navigation.path.length > 0) served.add(enemy.id);
    }
  }
  assert.ok(sawDeferred, 'Crowd searches should be queued when the tick budget is full');
  assert.equal(served.size, 12, 'Every monster needs a turn even while all earlier monsters keep requesting paths');
});

test('water tile edits update collision immutably and rebuilding navigation routes around them', () => {
  let data = quietWorld('dungeon');
  Object.assign(data.player, { x: 12, z: 11 });
  data.enemies = [monsterAt('dungeon', 'tile-follower', 12, 7)];
  data = tick(data);
  assert.ok(data.enemies[0].navigation.path.length > 0);
  const before = data;
  const snapshot = JSON.stringify(before);
  data = setTileKind(data, 'dungeon', 12, 8, 'water');
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(isBlocked(before, 12, 8), false);
  assert.equal(isBlocked(data, 12, 8), true);
  assert.equal(isBlocked(data, 12, 8, 0.46), true);
  assert.equal(getWorld('dungeon', data.tileOverrides).tiles[8 * 24 + 12].kind, 'water');
  let detoured = false;
  for (let frame = 0; frame < 300; frame++) {
    data = tick(data);
    const enemy = data.enemies[0];
    detoured ||= Math.abs(enemy.x - 12) > 0.7;
    assert.equal(isBlocked(data, enemy.x, enemy.z, 0.46), false, 'AI must use current tile collision');
  }
  assert.ok(detoured, 'The cached direct route must rebuild after the next tile becomes water');
  assert.ok(Math.hypot(data.enemies[0].x - data.player.x, data.enemies[0].z - data.player.z) < 1.5);

  let playerData = quietWorld('dungeon');
  Object.assign(playerData.player, { x: 12, z: 7 });
  playerData = setTileKind(playerData, 'dungeon', 12, 8, 'water');
  for (let frame = 0; frame < 120; frame++) playerData = tick(playerData, { ...idle, z: 1 });
  assert.ok(playerData.player.z < 7.15, 'The player must collide with the same edited floor');
  playerData = setTileKind(playerData, 'dungeon', 12, 8, 'stone');
  assert.equal(isBlocked(playerData, 12, 8), false);
  for (let frame = 0; frame < 60; frame++) playerData = tick(playerData, { ...idle, z: 1 });
  assert.ok(playerData.player.z > 9, 'Restoring the floor must immediately restore player access');
});

test('impassable tile edits protect active and saved actors while preserving their input snapshot', () => {
  const data = quietWorld('dungeon');
  // These bodies overlap tile edges while their centres lie in neighbouring tiles.
  Object.assign(data.player, { x: 12.75, z: 7 });
  data.enemies = [monsterAt('dungeon', 'occupied-active', 12.9, 9)];
  data.zoneMemory.overworld = {
    enemies: [monsterAt('overworld', 'occupied-saved', 42.9, 23)], breakables: [], pickups: [],
  };
  const snapshot = JSON.stringify(data);
  const attempts = [
    { zone: 'dungeon' as const, x: 12, z: 7 },
    { zone: 'dungeon' as const, x: 12, z: 9 },
    { zone: 'overworld' as const, x: 42, z: 23 },
  ];
  for (const { zone, x, z } of attempts) {
    assert.throws(() => setTileKind(data, zone, x, z, 'water'), {
      name: 'RangeError', message: 'Cannot make an occupied tile impassable',
    });
    assert.equal(JSON.stringify(data), snapshot, 'A rejected edit must leave all actor and tile state untouched');
    assert.notEqual(getWorld(zone, data.tileOverrides).tiles[z * getWorld(zone).width + x].kind, 'water');
  }
});

test('opening a tile passage rebuilds a failed chase immediately instead of waiting for its retry timer', () => {
  let data = quietWorld('dungeon');
  data.quest.gate = true;
  Object.assign(data.player, { x: 12, z: 19 });
  data.enemies = [monsterAt('dungeon', 'reopened-follower', 12, 13)];
  for (let x = 1; x < 23; x++) data = setTileKind(data, 'dungeon', x, 15, 'water');
  data = tick(data);
  assert.equal(data.enemies[0].navigation.chasing, false);
  assert.ok((data.enemies[0].navigation.retry ?? 0) > 1);
  data = setTileKind(data, 'dungeon', 12, 15, 'bridge');
  data = tick(data);
  assert.equal(data.enemies[0].navigation.chasing, true, 'A changed floor should invalidate the previous no-path cooldown');
  assert.ok(data.enemies[0].navigation.path.length > 0);
  for (let frame = 0; frame < 180; frame++) {
    data = tick(data);
    assert.equal(isBlocked(data, data.enemies[0].x, data.enemies[0].z, 0.46), false);
  }
  assert.ok(data.enemies[0].z > 15.5, 'The new bridge should reconnect the two sides of the sealed row');
});

test('a blocked path segment stops immediately even while its replacement search is deferred', () => {
  let data = quietWorld('dungeon');
  Object.assign(data.player, { x: 12, z: 11 });
  data.enemies = [monsterAt('dungeon', 'deferred-follower', 12, 7)];
  data = tick(data);
  const follower = data.enemies[0];
  assert.ok(follower.navigation.path.length > 0);
  const waiting = [monsterAt('dungeon', 'first-search', 16, 7), monsterAt('dungeon', 'second-search', 18, 7)];
  waiting.forEach(enemy => { enemy.navigation.chasing = true; });
  data.enemies = [...waiting, follower];
  data.navigationCursor = 0;
  data = setTileKind(data, 'dungeon', 12, 8, 'water');
  data = tick(data);
  const stopped = data.enemies.find(enemy => enemy.id === follower.id)!;
  assert.equal(data.navigationStats.searches, PATHFINDING_SEARCHES_PER_TICK);
  assert.ok(data.navigationStats.deferred > 0);
  assert.equal(stopped.navigation.path.length, 0, 'A deferred search must discard its newly blocked old route');
  assert.equal(stopped.vx, 0);
  assert.equal(stopped.vz, 0);
  assert.equal(isBlocked(data, stopped.x, stopped.z, 0.46), false);
});

test('an unreachable regular target releases the chase and falls back to safe movement with a retry cooldown', () => {
  let data = quietWorld('dungeon');
  Object.assign(data.player, { x: 12, z: 20 });
  const enemy = monsterAt('dungeon', 'unreachable-follower', 12, 14);
  enemy.homeZ = 11;
  data.enemies = [enemy];
  data = tick(data);
  assert.equal(data.enemies[0].navigation.chasing, false, 'The closed gate makes this regular pursuit impossible');
  assert.ok((data.enemies[0].navigation.retry ?? 0) > FIXED_STEP, 'No path should enter a retry cooldown');
  const start = { x: data.enemies[0].x, z: data.enemies[0].z };
  let searchedDuringCooldown = false;
  for (let frame = 0; frame < 180; frame++) {
    data = tick(data);
    const monster = data.enemies[0];
    assert.equal(isBlocked(data, monster.x, monster.z, 0.46), false);
    assert.ok(monster.z < 16, 'Fallback must stay on its reachable side of the gate');
    if (frame < 15 && data.navigationStats.searches === 0) searchedDuringCooldown = true;
  }
  assert.ok(searchedDuringCooldown, 'A failed chase must not retry on every frame');
  assert.ok(Math.hypot(data.enemies[0].x - start.x, data.enemies[0].z - start.z) > 0.5, 'The monster should return home or wander safely instead of freezing at the gate');
});
