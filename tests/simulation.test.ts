import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialData, stepGame } from '../game/simulation';
import { createBreakables, createEnemies } from '../game/world';
import { CHEST_POSITION, DUNGEON_ENTRANCE, FIXED_STEP, GATE_POSITION, KEY_POSITION, OVERWORLD_SPAWN, type GameInput } from '../game/types';

type Data = ReturnType<typeof createInitialData>;
const idle: GameInput = { x: 0, z: 0, attack: false, interact: false };

function advance(data: Data, seconds: number, input: Partial<GameInput> = {}): Data {
  const controls = { ...idle, ...input };
  for (let i = 0; i < Math.round(seconds / FIXED_STEP); i++) data = stepGame(data, FIXED_STEP, controls).data;
  return data;
}

function quietWorld(): Data {
  const data = createInitialData('playing');
  data.enemies = [];
  data.breakables = [];
  data.pickups = [];
  return data;
}

function dungeon(): Data {
  let data = quietWorld();
  data.player.x = DUNGEON_ENTRANCE.x;
  data.player.z = DUNGEON_ENTRANCE.z;
  data = stepGame(data, FIXED_STEP, { ...idle, interact: true }).data;
  data.enemies = [];
  data.breakables = [];
  return data;
}

test('standing at home remains safe even after monsters have wandered for a minute', () => {
  const data = advance(createInitialData('playing'), 60);
  assert.equal(data.player.hp, 3);
  assert.equal(data.status, 'playing');
  assert.equal(data.player.x, OVERWORLD_SPAWN.x);
  assert.equal(data.player.z, OVERWORLD_SPAWN.z);
  for (const enemy of data.enemies.filter(enemy => enemy.alive)) {
    assert.ok(Math.hypot(enemy.x - data.player.x, enemy.z - data.player.z) > 3.5, enemy.id);
  }
});

test('movement accelerates, comes to rest, and cannot tunnel through water', () => {
  let data = quietWorld();
  data.player.x = 20;
  data.player.z = 10.5;
  data = advance(data, 0.1, { z: 1 });
  const earlySpeed = Math.hypot(data.player.vx, data.player.vz);
  assert.ok(earlySpeed > 0);
  data = advance(data, 0.4, { z: 1 });
  assert.ok(Math.hypot(data.player.vx, data.player.vz) >= earlySpeed);
  data = advance(data, 2, { z: 1 });
  assert.ok(data.player.z < 12.5, `The hero crossed the river at z=${data.player.z}`);
  data = advance(data, 0.8);
  assert.ok(Math.hypot(data.player.vx, data.player.vz) < 0.02);
});

test('a diagonal move slides along a stone wall while preserving separation', () => {
  let data = dungeon();
  data.player.x = 1.2;
  data.player.z = 7;
  data = advance(data, 1, { x: -1, z: 1 });
  assert.ok(data.player.x >= 0.8, `Wall penetration at x=${data.player.x}`);
  assert.ok(data.player.z > 9, `Wall sliding stopped movement at z=${data.player.z}`);
});

test('the overworld path and bridge lead to the dungeon entrance', () => {
  let data = quietWorld();
  const points = [{ x: 25, z: 5 }, { x: 25, z: 20 }, { x: 42, z: 20 }, { x: 42, z: 27 }];
  for (const point of points) {
    let count = 0;
    while (data.zone === 'overworld' && Math.hypot(point.x - data.player.x, point.z - data.player.z) > 0.25 && count++ < 1200) {
      const distance = Math.hypot(point.x - data.player.x, point.z - data.player.z);
      data = stepGame(data, FIXED_STEP, { ...idle, x: (point.x - data.player.x) / distance, z: (point.z - data.player.z) / distance }).data;
    }
    assert.ok(count < 1200, `The route is blocked near ${point.x}, ${point.z}`);
    if (data.zone === 'dungeon') break;
  }
  data = stepGame(data, FIXED_STEP, { ...idle, interact: true }).data;
  assert.equal(data.zone, 'dungeon');
  assert.ok(data.enemies.some(enemy => enemy.boss));
});

test('monsters remain solid and a sword damages each monster once per swing', () => {
  let data = quietWorld();
  data.player.x = 27;
  data.player.z = 7;
  data.player.facing = 0;
  data.player.invulnerable = 0.75;
  const enemy = createEnemies('overworld')[0];
  data.enemies = [{ ...enemy, x: 27.75, z: 7, homeX: 27.75, homeZ: 7, hitstun: 5 }];
  data = advance(data, FIXED_STEP);
  assert.ok(Math.hypot(data.enemies[0].x - data.player.x, data.enemies[0].z - data.player.z) >= 0.7);
  data = advance(data, FIXED_STEP, { attack: true });
  data = advance(data, 0.18);
  assert.equal(data.enemies[0].hp, 1);
  assert.ok(data.enemies[0].hitstun > 0);
  assert.ok(data.enemies[0].x > 27.75, 'The sword must knock its target away');
});

test('enemy death drops a gem and regular enemies respawn', () => {
  let data = quietWorld();
  data.player.x = 27;
  data.player.z = 7;
  data.player.facing = 0;
  const enemy = createEnemies('overworld')[0];
  data.enemies = [{ ...enemy, hp: 1, x: 28.1, z: 7, homeX: 33, homeZ: 7, hitstun: 5 }];
  data = advance(data, FIXED_STEP, { attack: true });
  data = advance(data, 0.12);
  assert.equal(data.enemies[0].alive, false);
  assert.ok(data.effects.some(effect => effect.kind === 'poof'));
  assert.ok(data.pickups.some(pickup => pickup.kind === 'rupee') || data.rupees > 0);
  data = advance(data, 21);
  assert.equal(data.enemies[0].alive, true);
  assert.equal(data.enemies[0].hp, data.enemies[0].maxHp);
});

test('contact damage knocks the hero back, grants immunity, and losing the final heart ends the run', () => {
  let data = quietWorld();
  data.player.x = 27;
  data.player.z = 7;
  const enemy = createEnemies('overworld')[0];
  data.enemies = [{ ...enemy, x: 27.75, z: 7, homeX: 27.75, homeZ: 7 }];
  data = advance(data, FIXED_STEP);
  assert.equal(data.player.hp, 2);
  assert.ok(data.player.vx < 0, 'Contact must knock the hero away from the monster');
  assert.ok(data.player.invulnerable > 1);
  assert.ok(data.hurtFlash > 0 && data.shake > 0);
  data.enemies[0].x = data.player.x + 0.5;
  data.enemies[0].z = data.player.z;
  data = advance(data, FIXED_STEP);
  assert.equal(data.player.hp, 2, 'Immunity prevents consecutive-frame contact damage');
  data.player.hp = 1;
  data.player.invulnerable = 0;
  data.player.vx = data.player.vz = 0;
  data.enemies[0].contactCooldown = 0;
  data.enemies[0].x = data.player.x + 0.5;
  data.enemies[0].z = data.player.z;
  data = advance(data, FIXED_STEP);
  assert.equal(data.player.hp, 0);
  assert.equal(data.status, 'gameover');
  const ended = JSON.stringify(data);
  data = advance(data, 1, { x: 1, attack: true });
  assert.equal(JSON.stringify(data), ended);
});

test('overlapping monsters resolve into separate solid bodies', () => {
  let data = quietWorld();
  data.player.x = 27;
  data.player.z = 7;
  data.player.invulnerable = 0.75;
  const enemy = createEnemies('overworld')[0];
  data.enemies = [
    { ...enemy, id: 'test-left', x: 27.6, z: 7, homeX: 27.6, homeZ: 7, hitstun: 5 },
    { ...enemy, id: 'test-right', x: 27.6, z: 7, homeX: 27.6, homeZ: 7, hitstun: 5 },
  ];
  data = advance(data, 0.1);
  for (const monster of data.enemies) assert.ok(Math.hypot(monster.x - data.player.x, monster.z - data.player.z) >= 0.81);
  assert.ok(Math.hypot(data.enemies[0].x - data.enemies[1].x, data.enemies[0].z - data.enemies[1].z) >= 0.91);
});

test('sword breaks grass and pots, gems magnetize, and hearts restore health', () => {
  let data = quietWorld();
  data.player.x = 27;
  data.player.z = 7;
  data.player.facing = 0;
  data.breakables = [
    { id: 'test-grass', x: 28, z: 7.25, kind: 'grass', alive: true },
    { id: 'test-pot', x: 28, z: 6.75, kind: 'pot', alive: true },
  ];
  data = advance(data, FIXED_STEP, { attack: true });
  data = advance(data, 0.12);
  assert.ok(data.breakables.every(object => !object.alive));
  assert.ok(data.effects.some(effect => effect.kind === 'grass'));
  assert.ok(data.effects.some(effect => effect.kind === 'pot'));
  const before = data.rupees;
  data.pickups = [{ id: 'test-gem', kind: 'rupee', x: data.player.x + 1.1, z: data.player.z, age: 1 }];
  data = advance(data, 0.6);
  assert.equal(data.rupees, before + 1);
  assert.equal(data.pickups.length, 0);
  data.player.hp = 2;
  data.pickups = [{ id: 'test-heart', kind: 'heart', x: data.player.x, z: data.player.z, age: 1 }];
  data = advance(data, FIXED_STEP);
  assert.equal(data.player.hp, 3);
});

test('the gate blocks entry; the key opens it; twelve separated sword hits unlock the treasure', () => {
  let data = dungeon();
  data.player.x = GATE_POSITION.x;
  data.player.z = GATE_POSITION.z - 2;
  data = advance(data, 1, { z: 1, interact: true });
  assert.equal(data.quest.gate, false);
  assert.ok(data.player.z < GATE_POSITION.z - 0.7);
  data.player.x = KEY_POSITION.x;
  data.player.z = KEY_POSITION.z - 1.15;
  data.player.vx = 0;
  data.player.vz = 0;
  data = advance(data, 0.3);
  assert.equal(data.quest.key, true);
  data = advance(data, FIXED_STEP);
  data.player.x = GATE_POSITION.x;
  data.player.z = GATE_POSITION.z - 1.3;
  data = advance(data, FIXED_STEP, { interact: true });
  assert.equal(data.quest.gate, true);
  data.enemies = createEnemies('dungeon').filter(enemy => enemy.boss);
  for (let strike = 0; strike < 12; strike++) {
    data.player.x = 10.6;
    data.player.z = 27;
    data.player.facing = 0;
    data.player.invulnerable = 0.75;
    data.player.vx = 0;
    data.player.vz = 0;
    data.enemies[0].x = 12;
    data.enemies[0].z = 27;
    data.enemies[0].vx = 0;
    data.enemies[0].vz = 0;
    data.enemies[0].attackMode = 'recover';
    data.enemies[0].attackTimer = 2;
    data = advance(data, FIXED_STEP, { attack: true });
    data = advance(data, 0.78);
    assert.equal(data.enemies[0].hp, Math.max(0, 11 - strike), `Sword strike ${strike + 1}`);
  }
  assert.equal(data.quest.boss, true);
  assert.equal(data.enemies[0].alive, false);
  data = advance(data, 25);
  assert.equal(data.enemies[0].alive, false, 'The boss must stay defeated');
  data.player.x = CHEST_POSITION.x;
  data.player.z = CHEST_POSITION.z - 1.3;
  data.player.vx = 0;
  data.player.vz = 0;
  data = advance(data, FIXED_STEP, { interact: true });
  assert.equal(data.quest.treasure, true);
  assert.equal(data.status, 'victory');
});

test('a locked chest cannot award victory and paused state freezes the adventure', () => {
  let data = dungeon();
  data.player.x = CHEST_POSITION.x;
  data.player.z = CHEST_POSITION.z - 1.3;
  data = advance(data, FIXED_STEP, { interact: true });
  assert.equal(data.status, 'playing');
  assert.equal(data.quest.treasure, false);
  data.status = 'paused';
  const snapshot = JSON.stringify(data);
  data = advance(data, 1, { x: 1, attack: true, interact: true });
  assert.equal(JSON.stringify(data), snapshot);
});

test('leaving and returning preserves dungeon loot, broken pots, and defeated enemies', () => {
  let data = dungeon();
  data.player.x = KEY_POSITION.x;
  data.player.z = KEY_POSITION.z - 1.15;
  data = advance(data, 0.3);
  assert.equal(data.quest.key, true);
  data.breakables = createBreakables('dungeon');
  data.breakables[0].alive = false;
  const brokenId = data.breakables[0].id;
  data.enemies = createEnemies('dungeon');
  data.enemies[0].alive = false;
  data.enemies[0].hp = 0;
  const defeatedId = data.enemies[0].id;
  data.player.x = 12;
  data.player.z = 2;
  data.player.vx = data.player.vz = 0;
  data = advance(data, FIXED_STEP, { interact: true });
  assert.equal(data.zone, 'overworld');
  data = advance(data, FIXED_STEP);
  data.player.x = DUNGEON_ENTRANCE.x;
  data.player.z = DUNGEON_ENTRANCE.z;
  data = advance(data, FIXED_STEP, { interact: true });
  assert.equal(data.zone, 'dungeon');
  assert.equal(data.quest.key, true);
  assert.ok(data.pickups.every(pickup => pickup.kind !== 'key'));
  assert.equal(data.breakables.find(item => item.id === brokenId)?.alive, false);
  assert.equal(data.enemies.find(item => item.id === defeatedId)?.alive, false);
});

test('simulation leaves its input snapshot intact and discards invalid frame times', () => {
  const data = createInitialData('playing');
  const snapshot = JSON.stringify(data);
  const result = stepGame(data, FIXED_STEP, { ...idle, x: 1, attack: true });
  assert.notEqual(result.data, data);
  assert.equal(JSON.stringify(data), snapshot);
  for (const invalidTime of [0, -1, NaN, Infinity]) {
    assert.equal(stepGame(data, invalidTime, { ...idle, x: 1 }).data, data);
  }
  const limited = stepGame(data, 5, { ...idle, x: 1 }).data;
  assert.ok(limited.elapsed <= 0.05, 'A tab suspension must not become a huge physics step');
});

test('fixed ticks replay identically after serializing all mutable game state', () => {
  let first = createInitialData('playing');
  let second = JSON.parse(JSON.stringify(first)) as Data;
  for (let tick = 0; tick < 900; tick++) {
    const input = { ...idle, x: tick < 240 ? 1 : 0, z: tick >= 240 && tick < 480 ? 1 : 0, attack: tick % 47 === 0 };
    first = stepGame(first, FIXED_STEP, input).data;
    second = stepGame(second, FIXED_STEP, input).data;
  }
  assert.deepEqual(first, second);
  assert.equal(JSON.parse(JSON.stringify(first)).elapsed, first.elapsed);
});

test('normal movement and combat inputs complete the live adventure from home to the crown', () => {
  let data = createInitialData('playing');
  let ticks = 0;
  const describe = () => `${data.zone} at ${data.player.x.toFixed(2)}, ${data.player.z.toFixed(2)} with ${data.player.hp} hearts`;
  const tick = (input: GameInput) => {
    assert.ok(++ticks <= 18000, `Playthrough exceeded its step limit: ${describe()}`);
    data = stepGame(data, FIXED_STEP, input).data;
    assert.notEqual(data.status, 'gameover', `The hero died during normal gameplay: ${describe()}`);
  };
  const walk = (x: number, z: number) => {
    const startingZone = data.zone;
    for (let attempt = 0; attempt < 3000; attempt++) {
      const dx = x - data.player.x;
      const dz = z - data.player.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.16) return;
      tick({
        x: Math.abs(dx) < 0.035 ? 0 : dx / length,
        z: Math.abs(dz) < 0.035 ? 0 : dz / length,
        attack: true,
        interact: false,
      });
      if (data.zone !== startingZone) return;
    }
    assert.fail(`The live route to ${x}, ${z} is blocked: ${describe()}`);
  };
  const interact = () => {
    tick({ ...idle, interact: true });
    tick(idle);
  };
  const clearRoom = () => {
    for (let attempt = 0; attempt < 5000; attempt++) {
      const targets = data.enemies.filter(enemy => enemy.alive && (data.quest.gate || enemy.z < GATE_POSITION.z));
      targets.sort((a, b) => Math.hypot(a.x - data.player.x, a.z - data.player.z) - Math.hypot(b.x - data.player.x, b.z - data.player.z));
      const target = targets[0];
      if (!target) return;
      const dx = target.x - data.player.x;
      const dz = target.z - data.player.z;
      const length = Math.hypot(dx, dz);
      const boss = data.enemies.find(enemy => enemy.boss && enemy.alive);
      const bossTelling = boss && ['telegraph', 'chargeTelegraph', 'charge'].includes(boss.attackMode);
      const projectileThreat = data.projectiles.some(projectile => {
        const px = data.player.x - projectile.x;
        const pz = data.player.z - projectile.z;
        const time = (px * projectile.vx + pz * projectile.vz) / (projectile.vx ** 2 + projectile.vz ** 2);
        return time > 0 && time < 0.7 && Math.hypot(px - projectile.vx * time, pz - projectile.vz * time) < 1.1;
      });
      if (boss && (bossTelling || projectileThreat)) {
        const bx = data.player.x - boss.x;
        const bz = data.player.z - boss.z;
        const radius = Math.hypot(bx, bz) || 1;
        const sign = data.player.x < 5 || data.player.z > 32 ? -1 : 1;
        tick({ x: -bz / radius * sign, z: bx / radius * sign, attack: false, interact: false });
      } else if (target.boss) {
        // Close for one swing, then make space while the Warden resists damage.
        const retreat = target.damageCooldown > 0.12 && data.player.attackTime <= 0;
        const approach = length > 2.15 ? 1 : length < 1.7 || retreat ? -1 : data.player.attackCooldown <= 0 ? 0.15 : 0;
        tick({ x: dx / (length || 1) * approach, z: dz / (length || 1) * approach, attack: !retreat, interact: false });
      } else {
        const approach = length > 1.95 ? 1 : data.player.attackCooldown <= 0 ? 0.12 : 0;
        tick({ x: dx / (length || 1) * approach, z: dz / (length || 1) * approach, attack: true, interact: false });
      }
    }
    assert.fail(`Combat did not finish: ${describe()}`);
  };

  // This test changes state only through normal inputs: no entity fixtures,
  // teleports, health edits, or quest shortcuts are used during the adventure.
  for (const [x, z] of [[25, 5], [25, 20], [42, 20], [42, 27]]) walk(x, z);
  assert.equal(data.zone, 'dungeon');
  const guardian = data.enemies.find(enemy => enemy.boss);
  assert.equal(guardian?.maxHp, 12);
  assert.equal(guardian?.hp, 12);
  walk(KEY_POSITION.x, KEY_POSITION.z - 1.15);
  for (let frame = 0; frame < 20; frame++) tick(idle);
  assert.equal(data.quest.key, true);
  clearRoom();
  walk(12, 14);
  walk(12, 14.5);
  interact();
  assert.equal(data.quest.gate, true);
  walk(12, 20.5);
  clearRoom();
  assert.equal(data.quest.boss, true);
  assert.equal(data.enemies.find(enemy => enemy.boss)?.alive, false);
  assert.equal(data.enemies.find(enemy => enemy.boss)?.hp, 0);
  walk(12, 30.5);
  interact();
  assert.equal(data.status, 'victory');
  assert.deepEqual(data.quest, { key: true, gate: true, boss: true, treasure: true });
  assert.ok(data.player.hp > 0);
  assert.ok(Number.isFinite(data.elapsed) && data.elapsed > 0);
  assert.ok(data.rupees > 0, 'Normal sword combat must provide collectable loot');
});
