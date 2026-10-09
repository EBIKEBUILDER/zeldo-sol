import assert from 'node:assert/strict';
import test from 'node:test';
import { BOSS_BLAST_RADIUS, BOSS_CHARGE_DURATION, BOSS_CHARGE_TELEGRAPH, BOSS_EMBER_DURATION, BOSS_TELEGRAPH, createInitialData, isBlocked, stepGame } from '../game/simulation';
import { createEnemies } from '../game/world';
import { FIXED_STEP, type GameInput, type Projectile } from '../game/types';

type Data = ReturnType<typeof createInitialData>;
const idle: GameInput = { x: 0, z: 0, attack: false, interact: false };

function bossArena(): Data {
  const data = createInitialData('playing');
  data.zone = 'dungeon';
  data.quest.gate = true;
  data.enemies = createEnemies('dungeon').filter(enemy => enemy.boss);
  data.enemies[0].navigation.chasing = true;
  data.breakables = [];
  data.pickups = [];
  Object.assign(data.player, { x: 12, z: 21 });
  return data;
}

function tick(data: Data, input: Partial<GameInput> = {}): Data {
  return stepGame(data, FIXED_STEP, { ...idle, ...input }).data;
}

function advance(data: Data, seconds: number, input: Partial<GameInput> = {}): Data {
  for (let frame = 0; frame < Math.round(seconds / FIXED_STEP); frame++) data = tick(data, input);
  return data;
}

function lob(data: Data, age = 0): Projectile {
  const boss = data.enemies[0];
  boss.attackMode = 'recover';
  boss.attackTimer = 10;
  boss.rangedCooldown = 10;
  return { id: 'test-lob', ownerId: boss.id, x: 12, z: 27, startX: 12, startZ: 27, targetX: 12, targetZ: 21, vx: 0, vz: -12, age, duration: 3, flightTime: 0.5, radius: 0.22 };
}

test('the actual lunge ignores sword damage and stun while remaining solid without being pushed', () => {
  let data = bossArena();
  const boss = data.enemies[0];
  boss.attackMode = 'charge';
  boss.attackTimer = BOSS_CHARGE_DURATION;
  boss.wanderAngle = Math.PI / 2;
  boss.hitstun = 2;
  boss.damageCooldown = 0;
  Object.assign(data.player, { x: 10, z: 27, facing: 0, invulnerable: 0.75 });
  const control = tick(JSON.parse(JSON.stringify(data)) as Data);
  data = tick(data, { attack: true });
  assert.equal(data.enemies[0].hp, 12);
  assert.equal(data.enemies[0].hitstun, 0);
  assert.equal(data.enemies[0].attackMode, 'charge');
  assert.equal(data.enemies[0].x, control.enemies[0].x);
  assert.equal(data.enemies[0].z, control.enemies[0].z);
  assert.equal(data.enemies[0].vx, control.enemies[0].vx);
  assert.equal(data.enemies[0].vz, control.enemies[0].vz);
  assert.equal(data.enemies[0].damageCooldown, 0);

  // Even overlapping body separation moves the hero, rather than shoving the lunge.
  data = bossArena();
  data.enemies[0].attackMode = 'charge';
  data.enemies[0].attackTimer = BOSS_CHARGE_DURATION;
  data.enemies[0].wanderAngle = Math.PI / 2;
  Object.assign(data.player, { x: 12, z: 26.4, invulnerable: 0.75 });
  data = tick(data);
  assert.equal(data.enemies[0].x, 12);
  assert.ok(data.enemies[0].z > 27, 'The lunge keeps advancing along its locked direction');
  assert.ok(data.player.z < 26.0, 'The hero absorbs body separation');
  assert.ok(Math.hypot(data.player.x - data.enemies[0].x, data.player.z - data.enemies[0].z) >= 1.19);
});

test('a close charge locks its aim and waits through an uninterruptible warning before moving', () => {
  let data = bossArena();
  Object.assign(data.player, { x: 10, z: 27, facing: 0, invulnerable: 0.75 });
  data.enemies[0].rangedCooldown = 0;
  const first = stepGame(data, FIXED_STEP, { ...idle, attack: true });
  data = first.data;
  assert.equal(data.enemies[0].hp, 11, 'Windup remains damageable');
  assert.equal(data.enemies[0].attackMode, 'chargeTelegraph');
  assert.equal(data.enemies[0].attackTimer, BOSS_CHARGE_TELEGRAPH);
  assert.ok(first.sounds.includes('warning'));
  data = advance(data, 0.4, { z: -1, attack: true });
  assert.equal(data.enemies[0].attackMode, 'chargeTelegraph');
  assert.equal(data.enemies[0].x, 12);
  assert.equal(data.enemies[0].z, 27);
  assert.equal(data.enemies[0].aimX, 10);
  assert.equal(data.enemies[0].aimZ, 27);
  assert.equal(data.projectiles.length, 0);
  assert.equal(data.hazards.length, 0);
  data = advance(data, 0.25, { z: -1, attack: true });
  assert.equal(data.enemies[0].attackMode, 'charge');
  assert.ok(data.enemies[0].vx < 0);
  assert.ok(Math.abs(data.enemies[0].vz) < 0.001, 'The charge goes toward the original aim, not the moved hero');
});

test('distance, unreachable paths and blocked lunge corridors choose a warned ranged attack', () => {
  let data = bossArena();
  data.enemies[0].rangedCooldown = 0;
  data = tick(data);
  assert.equal(data.enemies[0].attackMode, 'telegraph');
  assert.equal(data.enemies[0].attackTimer, BOSS_TELEGRAPH);

  data = bossArena();
  data.enemies[0].rangedCooldown = 0;
  Object.assign(data.enemies[0], { x: 4, z: 21 });
  Object.assign(data.player, { x: 4, z: 25 });
  data = tick(data);
  assert.equal(data.enemies[0].attackMode, 'telegraph', 'A pillar on the direct lunge corridor selects magic');

  data = bossArena();
  Object.assign(data.player, { x: 6, z: 16 });
  data.enemies[0].rangedCooldown = 0;
  data = tick(data);
  assert.equal(data.enemies[0].navigation.chasing, true);
  assert.equal(data.enemies[0].attackMode, 'telegraph', 'An engaged boss still attacks unreachable targets through cover');
});

test('ranged windup locks landing positions and phase two preserves a three-shot fan', () => {
  let data = bossArena();
  data.enemies[0].rangedCooldown = 0;
  data = tick(data);
  data = advance(data, 0.4, { x: 1 });
  assert.equal(data.projectiles.length, 0);
  assert.equal(data.enemies[0].aimX, 12);
  assert.equal(data.enemies[0].aimZ, 21);
  data = advance(data, 0.2, { x: 1 });
  assert.equal(data.projectiles.length, 1);
  assert.equal(data.projectiles[0].targetX, 12);
  assert.equal(data.projectiles[0].targetZ, 21);
  assert.ok(data.projectiles[0].flightTime! >= 0.45 && data.projectiles[0].flightTime! <= 1.1);
  assert.ok(data.projectiles[0].startX !== undefined && data.projectiles[0].startZ !== undefined);

  data = bossArena();
  data.enemies[0].hp = 6;
  data.enemies[0].rangedCooldown = 0;
  data = tick(data);
  data = advance(data, 0.6, { x: 1 });
  assert.equal(data.projectiles.length, 3);
  assert.deepEqual(data.projectiles.map(projectile => Number(projectile.targetX!.toFixed(1))).sort((a, b) => a - b), [10.6, 12, 13.4]);
  assert.ok(data.projectiles.every(projectile => projectile.targetZ === 21));
  assert.ok(data.enemies[0].rangedCooldown <= 1.5);
});

test('lobs pass above the hero and explode at the landing with a temporary damaging area', () => {
  let data = bossArena();
  Object.assign(data.player, { x: 12, z: 24, invulnerable: 0 });
  data.projectiles = [lob(data)];
  data = advance(data, 0.4);
  assert.equal(data.player.hp, 3, 'Passing beneath an airborne lob is safe');
  assert.equal(data.projectiles.length, 1);
  assert.equal(data.hazards.length, 0);
  let impactSounds: string[] = [];
  for (let frame = 0; frame < 12; frame++) {
    const result = stepGame(data, FIXED_STEP, idle);
    data = result.data;
    impactSounds = impactSounds.concat(result.sounds);
  }
  assert.equal(data.projectiles.length, 0);
  assert.equal(data.hazards.length, 1);
  assert.equal(data.hazards[0].x, 12);
  assert.equal(data.hazards[0].z, 21);
  assert.equal(data.hazards[0].radius, BOSS_BLAST_RADIUS);
  assert.equal(data.hazards[0].duration, BOSS_EMBER_DURATION);
  assert.ok(data.effects.some(effect => effect.kind === 'blast'));
  assert.ok(impactSounds.includes('blast'));
  assert.equal(data.player.hp, 3);
  Object.assign(data.player, { x: 12, z: 21, vx: 0, vz: 0, invulnerable: 0 });
  data = tick(data);
  assert.equal(data.player.hp, 2, 'Entering the lingering circle costs one heart');
  Object.assign(data.player, { x: 17, z: 21, vx: 0, vz: 0 });
  data = advance(data, BOSS_EMBER_DURATION);
  assert.equal(data.hazards.length, 0);
  Object.assign(data.player, { x: 12, z: 21, vx: 0, vz: 0, invulnerable: 0 });
  data = tick(data);
  assert.equal(data.player.hp, 2, 'Expired flames cannot hurt the hero');
});

test('overlapping impacts deal one heart and share the existing player invulnerability window', () => {
  let data = bossArena();
  data.player.invulnerable = 0;
  const shot = lob(data, 0.49);
  data.projectiles = [shot, { ...shot, id: 'second-lob' }];
  const impact = stepGame(data, FIXED_STEP, idle);
  data = impact.data;
  assert.equal(data.player.hp, 2);
  assert.equal(data.player.invulnerable, 1.25);
  assert.equal(impact.sounds.filter(sound => sound === 'hurt').length, 1);
  assert.equal(data.hazards.length, 2);
  assert.equal(data.projectiles.length, 0);
  Object.assign(data.player, { x: 12, z: 21, vx: 0, vz: 0 });
  data = tick(data);
  assert.equal(data.player.hp, 2);
  Object.assign(data.player, { x: 17, z: 21, vx: 0, vz: 0, invulnerable: 0 });
  data = tick(data);
  assert.equal(data.player.hp, 2, 'Moving beyond the circle is safe');
});

test('boss death and doorway travel clear airborne shots and lingering flames', () => {
  let data = bossArena();
  const boss = data.enemies[0];
  data.projectiles = [lob(data)];
  data.hazards = [{ id: 'old-fire', ownerId: boss.id, x: 12, z: 21, age: 0, duration: 1.8, radius: 1.2 }];
  boss.hp = 1;
  boss.damageCooldown = 0;
  Object.assign(data.player, { x: 10, z: 27, facing: 0, invulnerable: 0.75 });
  data = tick(data, { attack: true });
  assert.equal(data.quest.boss, true);
  assert.deepEqual(data.projectiles, []);
  assert.deepEqual(data.hazards, []);

  data = bossArena();
  data.projectiles = [lob(data)];
  data.hazards = [{ id: 'leaving-fire', ownerId: data.enemies[0].id, x: 12, z: 21, age: 0, duration: 1.8, radius: 1.2 }];
  Object.assign(data.player, { x: 12, z: 2 });
  data = tick(data);
  assert.equal(data.zone, 'overworld');
  assert.deepEqual(data.projectiles, []);
  assert.deepEqual(data.hazards, []);
});

test('flight, blast and flame updates replay after serialization without mutating the input', () => {
  let first = bossArena();
  first.projectiles = [lob(first)];
  Object.assign(first.player, { x: 16, z: 21 });
  let second = JSON.parse(JSON.stringify(first)) as Data;
  const snapshot = JSON.stringify(first);
  const next = tick(first);
  assert.equal(JSON.stringify(first), snapshot);
  first = next;
  second = tick(second);
  for (let frame = 0; frame < 150; frame++) {
    first = tick(first);
    second = tick(second);
    assert.deepEqual(first, second);
  }
  assert.equal(first.hazards.length, 0);
  const oldSave = bossArena();
  delete (oldSave as Partial<Data>).hazards;
  assert.deepEqual(tick(oldSave).hazards, [], 'Old serialized adventures acquire an empty hazard list');
});

test('ranged tells finish beside dungeon walls while the hero remains movable on valid floor', () => {
  for (const placement of [
    { px: 0.92, pz: 27, bx: 2.2, bz: 27, x: 0, z: 1 },
    { px: 22.08, pz: 27, bx: 20.8, bz: 27, x: 0, z: 1 },
    { px: 8, pz: 34.08, bx: 8, bz: 32.7, x: 1, z: 0 },
    // Deep overlap covers the player being pressed against the side wall.
    { px: 0.92, pz: 27, bx: 1.45, bz: 27, x: 0, z: 1 },
  ]) {
    let data = bossArena();
    Object.assign(data.player, { x: placement.px, z: placement.pz });
    Object.assign(data.enemies[0], { x: placement.bx, z: placement.bz, attackMode: 'telegraph', attackTimer: BOSS_TELEGRAPH, aimX: placement.px, aimZ: placement.pz, rangedCooldown: 0 });
    let fired = false;
    let exploded = false;
    for (let frame = 0; frame < 90; frame++) {
      // Isolate attack clocks and wall movement from the separate damage system.
      data.player.invulnerable = 0.75;
      const result = stepGame(data, FIXED_STEP, { ...idle, x: placement.x, z: placement.z });
      data = result.data;
      fired ||= result.sounds.includes('fire');
      exploded ||= result.sounds.includes('blast');
      assert.equal(data.status, 'playing');
      assert.ok(Math.abs(data.elapsed - (frame + 1) * FIXED_STEP) < 0.00001);
      assert.equal(isBlocked(data, data.player.x, data.player.z), false, JSON.stringify(placement));
      assert.equal(isBlocked(data, data.enemies[0].x, data.enemies[0].z, 0.83), false, JSON.stringify(placement));
      if (frame >= Math.ceil(BOSS_TELEGRAPH / FIXED_STEP)) assert.ok(fired, 'The first ranged tell cannot remain stuck at a wall');
    }
    assert.ok(exploded, 'The launched projectile reaches its locked wall-adjacent landing');
    assert.ok(Math.hypot(data.player.x - placement.px, data.player.z - placement.pz) > 3, 'The hero can walk along the wall while the attack resolves');
  }
});

test('a lunge pressing the hero against a side wall ends and allows escape along the wall', () => {
  let data = bossArena();
  Object.assign(data.player, { x: 0.92, z: 27, invulnerable: 0 });
  Object.assign(data.enemies[0], { x: 1.45, z: 27, attackMode: 'charge', attackTimer: BOSS_CHARGE_DURATION, wanderAngle: Math.PI, rangedCooldown: 2 });
  data = advance(data, 0.75, { z: 1 });
  assert.equal(data.status, 'playing');
  assert.equal(data.player.hp, 2, 'The existing contact hit grants enough invulnerability to escape');
  assert.notEqual(data.enemies[0].attackMode, 'charge');
  assert.ok(data.player.z > 28, 'Movement returns after the initial knockback even when the wall blocks that knockback');
  assert.equal(isBlocked(data, data.player.x, data.player.z), false);
  assert.equal(isBlocked(data, data.enemies[0].x, data.enemies[0].z, 0.83), false);
});
