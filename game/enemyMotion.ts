import type { Enemy } from './types';

type EnemyHeading = Pick<Enemy, 'x' | 'z' | 'facing' | 'boss' | 'navigation' | 'attackMode' | 'aimX' | 'aimZ'>;

/** Monster eyes face local -Z; simulation headings use world cos/sin. */
export function getEnemyYaw(enemy: EnemyHeading): number {
  let facing = enemy.facing;
  const aiming = enemy.boss && enemy.navigation.chasing && (
    enemy.attackMode === 'telegraph' || enemy.attackMode === 'fire' || enemy.attackMode === 'chargeTelegraph'
  );
  if (aiming) {
    const dx = enemy.aimX - enemy.x, dz = enemy.aimZ - enemy.z;
    if (Math.hypot(dx, dz) > 0.000001) facing = Math.atan2(dz, dx);
  }
  return Math.PI * 1.5 - facing;
}
