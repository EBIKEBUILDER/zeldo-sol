import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PATHFINDING_SEARCHES_PER_TICK,
  createInitialData,
  isBlocked,
  setTileKind,
  stepGame,
} from '../game/simulation';
import { createEnemies } from '../game/world';
import { FIXED_STEP, type Enemy, type GameInput, type Zone } from '../game/types';

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

function monsterAt(zone: Zone, id: string, x: number, z: number, homeX: number, homeZ: number): Enemy {
  const source = createEnemies(zone)[0];
  return {
    ...source, id, x, z, homeX, homeZ,
    navigation: { ...source.navigation, path: [], targetX: x, targetZ: z, chasing: true },
  };
}

function tick(data: Data): Data {
  data.player.invulnerable = 0.75;
  return stepGame(data, FIXED_STEP, idle).data;
}

function homeDistance(enemy: Enemy): number {
  return Math.hypot(enemy.x - enemy.homeX, enemy.z - enemy.homeZ);
}

function assertFacesMovement(before: Enemy, after: Enemy): void {
  const dx = after.x - before.x;
  const dz = after.z - before.z;
  const moved = Math.hypot(dx, dz);
  if (moved < 1e-8) return;
  const alignment = (Math.cos(after.facing) * dx + Math.sin(after.facing) * dz) / moved;
  assert.ok(alignment > 1 - 1e-7, `Facing ${after.facing} must follow actual movement (${dx}, ${dz})`);
}

test('a released pursuer walks around an obstacle and across a chunk seam all the way home', () => {
  let data = quietWorld();
  Object.assign(data.player, { x: 8, z: 5 });
  data.enemies = [monsterAt('overworld', 'returning-seam', 21, 5, 14, 5)];
  data.breakables = [{ id: 'return-route-pot', kind: 'pot', x: 17, z: 5, alive: true }];
  let sawReturnPath = false;
  let crossedSeam = false;
  let detoured = false;
  let arrived = false;
  for (let frame = 0; frame < 720; frame++) {
    const before = data.enemies[0];
    data = tick(data);
    const enemy = data.enemies[0];
    assert.equal(enemy.navigation.chasing, false, 'Willow Home remains a safe area');
    assert.equal(isBlocked(data, enemy.x, enemy.z, 0.46), false);
    assert.ok(Math.hypot(enemy.x - before.x, enemy.z - before.z) < 0.05, 'Returning must walk instead of teleporting');
    assertFacesMovement(before, enemy);
    sawReturnPath ||= !!enemy.navigation.returning && enemy.navigation.path.length > 0;
    crossedSeam ||= enemy.x < 16;
    detoured ||= Math.abs(enemy.z - 5) > 0.7;
    if (!enemy.navigation.returning && homeDistance(enemy) < 0.21) {
      arrived = true;
      break;
    }
  }
  assert.ok(sawReturnPath, 'A released pursuit needs a home route');
  assert.ok(detoured, 'The home route must go around the intact pot');
  assert.ok(crossedSeam, 'Returning uses the continuous grid across x=16');
  assert.ok(arrived, 'Return mode must reach the spawn before resuming wandering');
});

test('an unreachable chase returns around a dungeon pillar and finishes at the real spawn', () => {
  let data = quietWorld('dungeon');
  Object.assign(data.player, { x: 12, z: 20 });
  data.enemies = [monsterAt('dungeon', 'returning-pillar', 4, 15, 4, 11)];
  let returned = false;
  let detoured = false;
  let arrived = false;
  for (let frame = 0; frame < 600; frame++) {
    const before = data.enemies[0];
    data = tick(data);
    const enemy = data.enemies[0];
    assert.equal(isBlocked(data, enemy.x, enemy.z, 0.46), false);
    assertFacesMovement(before, enemy);
    returned ||= !!enemy.navigation.returning;
    detoured ||= Math.abs(enemy.x - 4) > 1;
    if (!enemy.navigation.returning && homeDistance(enemy) < 0.21) {
      arrived = true;
      break;
    }
  }
  assert.ok(returned, 'The closed gate must release pursuit into return mode');
  assert.ok(detoured, 'Returning must navigate around the pillar at (4,13)');
  assert.ok(arrived, 'A home route must finish at spawn instead of stopping 2.4 tiles away');
});

test('an unreachable home falls back to safe movement while searches keep their cooldown', () => {
  let data = quietWorld('dungeon');
  Object.assign(data.player, { x: 20, z: 30 });
  for (let x = 1; x < 23; x++) data = setTileKind(data, 'dungeon', x, 12, 'water');
  const enemy = monsterAt('dungeon', 'sealed-home', 8, 15, 8, 10);
  enemy.wanderAngle = 0;
  enemy.wanderTime = 100;
  data.enemies = [enemy];
  const start = { x: enemy.x, z: enemy.z };
  let noPath = false;
  let cooldownTicks = 0;
  for (let frame = 0; frame < 240; frame++) {
    const before = data.enemies[0];
    data = tick(data);
    const returning = data.enemies[0];
    assert.equal(returning.navigation.chasing, false);
    assert.equal(isBlocked(data, returning.x, returning.z, 0.46), false);
    assert.ok(returning.z > 12.5, 'Fallback cannot pass through the sealed row');
    assertFacesMovement(before, returning);
    noPath ||= !!returning.navigation.noPath;
    if (data.navigationStats.searches === 0) cooldownTicks++;
  }
  assert.ok(noPath, 'An inaccessible home must be handled as a failed route');
  assert.ok(cooldownTicks > 200, 'A failed return must not search on every tick');
  assert.ok(Math.hypot(data.enemies[0].x - start.x, data.enemies[0].z - start.z) > 0.5, 'The monster must keep moving safely instead of freezing or vibrating at a wall');
});

test('a fractional spawn blocked by body clearance does not strand the monster at its last waypoint', () => {
  let data = quietWorld('dungeon');
  Object.assign(data.player, { x: 12, z: 25 });
  const enemy = monsterAt('dungeon', 'blocked-fractional-home', 8, 8, 4.4, 5.8);
  enemy.navigation.chasing = false;
  enemy.navigation.returning = true;
  enemy.wanderAngle = Math.PI / 2;
  enemy.wanderTime = 100;
  data.enemies = [enemy];
  assert.equal(isBlocked(data, enemy.homeX, enemy.homeZ, 0.035), false, 'The small target point is visible beside the rock');
  assert.equal(isBlocked(data, enemy.homeX, enemy.homeZ, 0.46), true, 'The regular monster cannot fit at that spawn');
  let approached = false;
  let movementAfterApproach = 0;
  let cooldownTicks = 0;
  for (let frame = 0; frame < 600; frame++) {
    const before = data.enemies[0];
    data = tick(data);
    const returning = data.enemies[0];
    assert.equal(isBlocked(data, returning.x, returning.z, 0.46), false);
    assert.equal(returning.navigation.chasing, false);
    assertFacesMovement(before, returning);
    if (approached) movementAfterApproach += Math.hypot(returning.x - before.x, returning.z - before.z);
    approached ||= Math.hypot(returning.x - 5, returning.z - 6) < 0.25;
    if (data.navigationStats.searches === 0) cooldownTicks++;
  }
  assert.ok(approached, 'A visible approach waypoint should still be reachable');
  assert.ok(movementAfterApproach > 1, 'A short home route must fall back to safe movement instead of freezing at its endpoint');
  assert.ok(cooldownTicks > 500, 'A blocked final approach must keep a repath cooldown');
});

test('returning discards stale pursuit momentum and route even when its home search is deferred', () => {
  let data = quietWorld();
  Object.assign(data.player, { x: 25, z: 5 });
  data.enemies = [monsterAt('overworld', 'deferred-returner', 21, 5, 14, 5)];
  data = tick(data);
  const pursuer = data.enemies[0];
  assert.ok(pursuer.navigation.path.length > 0);
  assert.equal(pursuer.navigation.chasing, true);
  pursuer.vx = 1.85;
  pursuer.vz = 0;
  const before = { x: pursuer.x, z: pursuer.z };
  data.enemies = [
    monsterAt('overworld', 'first-home-search', 22, 5, 30, 5),
    monsterAt('overworld', 'second-home-search', 25, 7, 30, 7),
    pursuer,
  ];
  data.navigationCursor = 0;
  Object.assign(data.player, { x: 8, z: 5 });
  data = tick(data);
  const waiting = data.enemies.find(enemy => enemy.id === pursuer.id)!;
  assert.equal(data.navigationStats.searches, PATHFINDING_SEARCHES_PER_TICK);
  assert.ok(data.navigationStats.deferred > 0);
  assert.equal(waiting.navigation.chasing, false);
  assert.equal(waiting.navigation.returning, true);
  assert.equal(waiting.navigation.path.length, 0, 'The previous player route must be discarded before the deferred home search');
  assert.equal(waiting.vx, 0, 'The old chase cannot keep carrying the monster toward the player');
  assert.equal(waiting.vz, 0);
  assert.equal(waiting.x, before.x);
  assert.equal(waiting.z, before.z);
});

test('a returning monster faces its collision slide instead of its blocked velocity', () => {
  let data = quietWorld('dungeon');
  Object.assign(data.player, { x: 12, z: 20 });
  data = setTileKind(data, 'dungeon', 12, 8, 'water');
  const enemy = monsterAt('dungeon', 'sliding-returner', 11.035, 8, 12, 11);
  enemy.navigation.chasing = false;
  enemy.navigation.returning = true;
  data.enemies = [enemy];
  data = tick(data);
  assert.ok(data.enemies[0].navigation.path.length > 0);
  Object.assign(data.enemies[0], { x: 11.035, z: 8, vx: 1.85, vz: 0.5 });
  const before = data.enemies[0];
  data = tick(data);
  const sliding = data.enemies[0];
  assert.ok(sliding.vx > 0, 'This fixture retains momentum pressing into the water edge');
  assert.equal(sliding.x, before.x, 'Collision must block the horizontal component');
  assert.ok(sliding.z > before.z, 'The unblocked axis must still slide along the edge');
  assert.equal(isBlocked(data, sliding.x, sliding.z, 0.46), false);
  assertFacesMovement(before, sliding);
  assert.ok(Math.abs(sliding.facing - Math.PI / 2) < 1e-7);
});

test('return routes and movement facing replay identically after JSON round-trips', () => {
  let first = quietWorld();
  Object.assign(first.player, { x: 8, z: 5 });
  first.enemies = [monsterAt('overworld', 'replayed-returner', 21, 5, 14, 5)];
  first.breakables = [{ id: 'replayed-return-pot', kind: 'pot', x: 17, z: 5, alive: true }];
  let second = JSON.parse(JSON.stringify(first)) as Data;
  let sawReturn = false;
  let arrived = false;
  for (let frame = 0; frame < 720; frame++) {
    first = tick(first);
    second = tick(second);
    if (frame % 37 === 0) second = JSON.parse(JSON.stringify(second)) as Data;
    assert.deepEqual(first, second, `Replay diverged at return tick ${frame}`);
    sawReturn ||= !!first.enemies[0].navigation.returning;
    arrived ||= sawReturn && !first.enemies[0].navigation.returning && homeDistance(first.enemies[0]) < 0.21;
  }
  assert.ok(arrived, 'Replay must include the completion of a return route');
});
