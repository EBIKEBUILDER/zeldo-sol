import assert from 'node:assert/strict';
import test from 'node:test';
import { createNavigationGrid, findPath } from '../game/pathfinding';

test('A* routes around a wall and validates every segment against collision', () => {
  const blocked = (x: number, z: number) => x < 0 || z < 0 || x > 8 || z > 8 || Math.abs(x - 4) < 0.7 && z < 6.4;
  const grid = createNavigationGrid(9, 9, blocked);
  const path = findPath(grid, { x: 2, z: 2 }, { x: 6, z: 2 });
  assert.ok(path);
  assert.ok(path.some(point => point.z >= 7), 'The wall requires a route through the southern opening');
  for (let index = 1; index < path.length; index++) assert.ok(grid.canTravel(path[index - 1], path[index]));
  assert.deepEqual(path[path.length - 1], { x: 6, z: 2 });
});

test('A* does not cut diagonally through adjacent blocked tile corners', () => {
  const grid = createNavigationGrid(4, 4, (x, z) => Math.abs(x - 1) <= 0.5 && Math.abs(z) <= 0.5 || Math.abs(x) <= 0.5 && Math.abs(z - 1) <= 0.5);
  assert.equal(findPath(grid, { x: 0, z: 0 }, { x: 2, z: 2 }, 0.1), null);
});

test('A* cannot claim an adjacent goal through a thin sealed wall', () => {
  // The player stands just beyond a narrow wall. Large-body navigation nodes
  // may approach the wall, but that far side must never count as the goal.
  const wall = (x: number, z: number) => x > 3.25 && x < 3.6 && z >= 0 && z <= 6;
  const grid = createNavigationGrid(7, 7, wall);
  assert.equal(findPath(grid, { x: 2, z: 3 }, { x: 3.8, z: 3 }, 1.5), null);
});

test('large-body A* clearance selects an accessible approach beside a narrow player position', () => {
  const wall = (x: number) => x < 1;
  const grid = createNavigationGrid(8, 8, (x, z) => wall(x - 0.8) || z < 1, (x, z) => wall(x - 0.035) || z < 0.035);
  const target = { x: 1.4, z: 4 };
  const path = findPath(grid, { x: 5, z: 4 }, target, 1.8);
  assert.ok(path);
  assert.ok(path[path.length - 1].x >= 2, 'The large body should stay outside the wall clearance');
  assert.ok(grid.canSeeTarget(path[path.length - 1], target));
});
