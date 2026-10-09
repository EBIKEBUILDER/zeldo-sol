import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { getEnemyYaw } from '../game/enemyMotion';
import { createEnemies } from '../game/world';
import type { BossAttackMode, Enemy } from '../game/types';

const close = (actual: number, expected: number, label: string) => {
  assert.ok(Math.abs(actual - expected) < 0.000002, `${label}: expected ${expected}, received ${actual}`);
};

function assertFront(enemy: Enemy, x: number, z: number): void {
  // Monster eyes and pupils are authored on the body's local -Z side.
  const front = Vector3.TransformNormal(new Vector3(0, 0, -1), Matrix.RotationY(getEnemyYaw(enemy)));
  close(front.x, x, 'Monster front X');
  close(front.z, z, 'Monster front Z');
  close(front.y, 0, 'Monster front stays horizontal');
}

for (let direction = 0; direction < 8; direction++) {
  const facing = direction * Math.PI / 4;
  test(`the monster mesh faces its movement heading at ${direction * 45}°`, () => {
    const enemy = createEnemies('overworld')[0];
    enemy.facing = facing;
    assertFront(enemy, Math.cos(facing), Math.sin(facing));
  });
}

test('a returning monster faces away from the player despite a stale attack aim', () => {
  const enemy = createEnemies('overworld')[0];
  Object.assign(enemy, { x: 10, z: 10, facing: Math.PI, vx: -2, vz: 0, aimX: 15, aimZ: 10 });
  enemy.navigation.chasing = false;
  for (const attackMode of ['pursue', 'telegraph', 'fire', 'chargeTelegraph', 'charge', 'recover'] as BossAttackMode[]) {
    enemy.attackMode = attackMode;
    assertFront(enemy, -1, 0);
  }
});

test('a leashing boss uses its return heading instead of a stale stationary attack aim', () => {
  const enemy = createEnemies('dungeon').find(enemy => enemy.boss)!;
  Object.assign(enemy, { x: 10, z: 10, facing: -Math.PI / 2, vx: 0, vz: -2, aimX: 10, aimZ: 15 });
  enemy.navigation.chasing = false;
  for (const attackMode of ['telegraph', 'fire', 'chargeTelegraph'] as BossAttackMode[]) {
    enemy.attackMode = attackMode;
    assertFront(enemy, 0, -1);
  }
});

test('stationary boss attack tells face the locked aim', () => {
  const enemy = createEnemies('dungeon').find(enemy => enemy.boss)!;
  Object.assign(enemy, { x: 10, z: 10, facing: Math.PI, vx: 0, vz: 0, aimX: 12, aimZ: 12 });
  enemy.navigation.chasing = true;
  for (const attackMode of ['telegraph', 'fire', 'chargeTelegraph'] as BossAttackMode[]) {
    enemy.attackMode = attackMode;
    assertFront(enemy, Math.SQRT1_2, Math.SQRT1_2);
  }
});

test('a charging boss keeps facing forward after overshooting its locked aim', () => {
  const enemy = createEnemies('dungeon').find(enemy => enemy.boss)!;
  Object.assign(enemy, { x: 14, z: 10, facing: 0, vx: 9, vz: 0, aimX: 12, aimZ: 10, attackMode: 'charge' });
  enemy.navigation.chasing = true;
  assertFront(enemy, 1, 0);
});

test('a stationary monster keeps its saved heading when its visual is recreated', () => {
  const enemy = createEnemies('overworld')[0];
  Object.assign(enemy, { facing: Math.PI / 4, vx: 0, vz: 0 });
  assertFront(enemy, Math.SQRT1_2, Math.SQRT1_2);
});

test('a boss whose locked aim coincides with its position keeps its saved heading', () => {
  const enemy = createEnemies('dungeon').find(enemy => enemy.boss)!;
  Object.assign(enemy, { aimX: enemy.x, aimZ: enemy.z, facing: Math.PI, attackMode: 'telegraph' });
  enemy.navigation.chasing = true;
  assertFront(enemy, -1, 0);
});
