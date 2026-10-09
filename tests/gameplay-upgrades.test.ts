import assert from 'node:assert/strict';
import test from 'node:test';
import { BOSS_DAMAGE_COOLDOWN, BOSS_TELEGRAPH, createInitialData, isBlocked, stepGame } from '../game/simulation';
import { createEnemies } from '../game/world';
import { FIXED_STEP, GATE_POSITION, KEY_POSITION, type GameInput } from '../game/types';

const idle: GameInput = { x: 0, z: 0, attack: false, interact: false };
type Data = ReturnType<typeof createInitialData>;
function dungeon(): Data {
  const data = createInitialData('playing');
  data.zone = 'dungeon';
  data.player.x = 12;
  data.player.z = 21;
  data.player.invulnerable = 0.75;
  data.enemies = [];
  data.breakables = [];
  data.pickups = [];
  return data;
}
function advance(data: Data, seconds: number, input: Partial<GameInput> = {}): Data {
  for (let tick = 0; tick < Math.round(seconds / FIXED_STEP); tick++) data = stepGame(data, FIXED_STEP, { ...idle, ...input }).data;
  return data;
}
function bossArena(): Data {
  const data = dungeon();
  data.quest.gate = true;
  data.enemies = createEnemies('dungeon').filter(enemy => enemy.boss);
  return data;
}

test('living pots and the key altar block bodies; a broken pot frees its floor', () => {
  let data = dungeon();
  data.player.x = 10;
  data.player.z = 10;
  data.breakables = [{ id: 'solid-pot', kind: 'pot', x: 12, z: 10, alive: true }];
  assert.equal(isBlocked(data, 12, 10), true);
  data = advance(data, 1, { x: 1 });
  assert.ok(data.player.x <= 11.3, 'The player must stop at the intact pot');
  data = advance(data, 0.28, { attack: true });
  assert.equal(data.breakables[0].alive, false);
  assert.equal(isBlocked(data, 12, 10), false);
  data = advance(data, 0.7, { x: 1 });
  assert.ok(data.player.x > 12.5);
  assert.equal(isBlocked(data, KEY_POSITION.x, KEY_POSITION.z), true);
});

test('the solid pedestal key magnetizes from its edge and the gate opens without interact', () => {
  let data = dungeon();
  data.player.x = KEY_POSITION.x;
  data.player.z = KEY_POSITION.z - 1.15;
  data.pickups = [{ id: 'key-on-altar', kind: 'key', ...KEY_POSITION, age: 0 }];
  data = advance(data, 0.3);
  assert.equal(data.quest.key, true);
  data.player.x = GATE_POSITION.x;
  data.player.z = GATE_POSITION.z - 2.5;
  const result = stepGame(data, FIXED_STEP, idle);
  assert.equal(result.data.quest.gate, true);
  assert.ok(result.sounds.includes('gate'));
  assert.equal(result.data.inputLatch.interact, false);
});

test('regular pursuit routes around a pillar and stays engaged beyond the old home leash', () => {
  let data = dungeon();
  data.player.x = 4;
  data.player.z = 25;
  const enemy = createEnemies('dungeon')[0];
  data.enemies = [{ ...enemy, x: 4, z: 21, homeX: 4, homeZ: 21 }];
  let widestDetour = 0;
  for (let tick = 0; tick < 360; tick++) {
    data.player.invulnerable = 0.75;
    data = stepGame(data, FIXED_STEP, idle).data;
    widestDetour = Math.max(widestDetour, Math.abs(data.enemies[0].x - 4));
    assert.equal(isBlocked(data, data.enemies[0].x, data.enemies[0].z, 0.46), false);
  }
  assert.ok(widestDetour >= 1, 'The monster should navigate around the pillar');
  assert.ok(Math.hypot(data.enemies[0].x - data.player.x, data.enemies[0].z - data.player.z) < 1.5);
  data = dungeon();
  data.player.x = 14;
  data.player.z = 25;
  data.enemies = [{ ...enemy, x: 8, z: 25, homeX: 8, homeZ: 25 }];
  data = advance(data, 5, { x: 1 });
  assert.ok(data.enemies[0].x - data.enemies[0].homeX > 7.5);
  assert.equal(data.enemies[0].navigation.chasing, true);
  assert.ok(data.enemies[0].vx > 0);
});

test('the boss navigates with its body radius around a pillar', () => {
  let data = bossArena();
  data.player.x = 4;
  data.player.z = 26;
  data.enemies[0].x = 4;
  data.enemies[0].z = 20;
  let closest = Infinity;
  let widestDetour = 0;
  for (let tick = 0; tick < 720; tick++) {
    data.player.invulnerable = 0.75;
    data = stepGame(data, FIXED_STEP, idle).data;
    const boss = data.enemies[0];
    closest = Math.min(closest, Math.hypot(boss.x - data.player.x, boss.z - data.player.z));
    widestDetour = Math.max(widestDetour, Math.abs(boss.x - 4));
    assert.equal(isBlocked(data, boss.x, boss.z, 0.83), false);
  }
  assert.ok(widestDetour > 1.4, 'Boss navigation must use larger clearance than regular monsters');
  assert.ok(closest < 1.8, `Boss never reached the player: ${closest}`);
});

test('boss projectiles have a fixed half-second visual/audio tell and a faster half-health fan', () => {
  let data = bossArena();
  data.enemies[0].rangedCooldown = 0;
  let result = stepGame(data, FIXED_STEP, idle);
  data = result.data;
  assert.equal(data.enemies[0].attackMode, 'telegraph');
  assert.equal(data.enemies[0].attackTimer, BOSS_TELEGRAPH);
  assert.ok(result.sounds.includes('warning'));
  const aim = { x: data.enemies[0].aimX, z: data.enemies[0].aimZ };
  data = advance(data, 0.4, { x: 1 });
  assert.equal(data.projectiles.length, 0);
  assert.deepEqual({ x: data.enemies[0].aimX, z: data.enemies[0].aimZ }, aim);
  data = advance(data, 0.2, { x: 1 });
  assert.equal(data.projectiles.length, 1);
  const before = data.projectiles[0];
  assert.ok(Math.abs(before.vx) < 0.001 && before.vz < 0, 'The projectile aims at the original player position');
  data.enemies[0].hp = data.enemies[0].maxHp / 2;
  data.enemies[0].attackMode = 'pursue';
  data.enemies[0].rangedCooldown = 0;
  data.projectiles = [];
  result = stepGame(data, FIXED_STEP, idle);
  data = advance(result.data, 0.6);
  assert.equal(data.enemies[0].phase, 2);
  assert.equal(data.projectiles.length, 3);
  assert.ok(data.enemies[0].rangedCooldown <= 1.5);
});

test('boss melee cannot interrupt its tell, knock it away, or chain damage every swing', () => {
  let data = bossArena();
  data.player.x = 10;
  data.player.z = 27;
  data.player.facing = 0;
  data.enemies[0].rangedCooldown = 0;
  data = stepGame(data, FIXED_STEP, { ...idle, attack: true }).data;
  assert.equal(data.enemies[0].hp, 11);
  assert.equal(data.enemies[0].hitstun, 0);
  assert.equal(data.enemies[0].attackMode, 'chargeTelegraph');
  assert.equal(data.enemies[0].vx, 0);
  assert.equal(data.enemies[0].vz, 0);
  assert.ok(data.enemies[0].damageCooldown > BOSS_DAMAGE_COOLDOWN - 0.02);
  data = advance(data, 0.45, { attack: true });
  assert.equal(data.enemies[0].hp, 11, 'A second rapid swing must respect the boss damage immunity');
  data = advance(data, 0.15, { attack: true });
  assert.equal(data.enemies[0].attackMode, 'charge', 'The nearby boss must still lunge while the player spams sword swings');
});

test('an engaged boss pressures the doorway and unreachable targets with magic through cover', () => {
  let data = bossArena();
  data.player.z = 20;
  data = advance(data, FIXED_STEP);
  assert.equal(data.enemies[0].navigation.chasing, true);
  data.player.x = 6;
  data.player.z = 16;
  data.enemies[0].rangedCooldown = 0;
  const result = stepGame(data, FIXED_STEP, idle);
  assert.equal(result.data.enemies[0].attackMode, 'telegraph');
  data = advance(result.data, 0.6);
  assert.ok(data.projectiles.length > 0);
  // A known projectile crosses the closed wall line: terrain is not a safe spot.
  data.projectiles = [{ id: 'cover-test', ownerId: data.enemies[0].id, x: 6, z: 18, vx: 0, vz: -6, radius: 0.22, age: 0, duration: 3 }];
  data.player.invulnerable = 0;
  data = advance(data, 0.45);
  assert.equal(data.player.hp, 2);
});

test('boss death and zone transitions clear live missiles and replay remains serializable', () => {
  let first = bossArena();
  first.enemies[0].rangedCooldown = 0;
  first = advance(first, 0.7);
  assert.ok(first.projectiles.length > 0);
  let second = JSON.parse(JSON.stringify(first)) as Data;
  for (let frame = 0; frame < 120; frame++) {
    first = stepGame(first, FIXED_STEP, { ...idle, x: 0.4 }).data;
    second = stepGame(second, FIXED_STEP, { ...idle, x: 0.4 }).data;
  }
  assert.deepEqual(first, second);
  first.enemies[0].hp = 1;
  first.enemies[0].damageCooldown = 0;
  first.player.x = first.enemies[0].x - 2;
  first.player.z = first.enemies[0].z;
  first.player.facing = 0;
  first.player.attackCooldown = 0;
  first.player.invulnerable = 0.75;
  first = stepGame(first, FIXED_STEP, { ...idle, attack: true }).data;
  assert.equal(first.quest.boss, true);
  assert.equal(first.projectiles.length, 0);
  first = bossArena();
  first.projectiles = [{ id: 'leaving-missile', ownerId: first.enemies[0].id, x: 12, z: 27, vx: 0, vz: -6, radius: 0.22, age: 0, duration: 3 }];
  first.player.x = 12;
  first.player.z = 2;
  first = stepGame(first, FIXED_STEP, { ...idle, interact: true }).data;
  assert.equal(first.zone, 'overworld');
  assert.equal(first.projectiles.length, 0);
});

test('partial joystick input produces proportionally slower movement', () => {
  const base = dungeon();
  const slow = advance(base, 0.5, { x: 0.35 });
  const fast = advance(base, 0.5, { x: 1 });
  assert.ok(Math.abs(slow.player.vx / fast.player.vx - 0.35) < 0.01);
});
