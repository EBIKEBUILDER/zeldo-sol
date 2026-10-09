import assert from 'node:assert/strict';
import test from 'node:test';
import { createNavigationGraph, createNavigationGrid, findPath, findWorldPath, type NavigationChunk, type NavigationGrid, type NavigationPortal } from '../game/pathfinding';

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

function openGrid(width: number, height: number, blocked = (_x: number, _z: number) => false): NavigationGrid {
  return createNavigationGrid(width, height, (x, z) => x < -0.5 || z < -0.5 || x > width - 0.5 || z > height - 0.5 || blocked(x, z));
}

function chunk(id: string, region: string, width = 5, height = 5): NavigationChunk {
  return { id, region, origin: { x: 0, z: 0 }, width, height };
}

function entrance(traversableByAI = false): NavigationPortal {
  return { id: 'entrance', fromChunk: 'outside', fromTile: { x: 4, z: 2 }, toChunk: 'inside', toTile: { x: 1, z: 2 }, traversalCost: 2, traversableByAI };
}

test('the entire 3 by 2 overworld routes across chunk seams using ordinary neighboring tiles', () => {
  const grid = openGrid(48, 32);
  const chunks = Array.from({ length: 6 }, (_, index) => ({
    id: `chunk-${index}`, region: 'overworld', origin: { x: index % 3 * 16, z: Math.floor(index / 3) * 16 }, width: 16, height: 16,
  }));
  const graph = createNavigationGraph([{ id: 'overworld', grid }], chunks, []);
  const result = findWorldPath(graph, { region: 'overworld', x: 2, z: 2 }, { region: 'overworld', x: 45, z: 29 }, { goalRadius: 0 });
  assert.equal(result.status, 'found');
  for (const boundary of [16, 32]) assert.ok(result.path.some(point => point.x === boundary - 1) && result.path.some(point => point.x === boundary), `No wall at horizontal seam ${boundary}`);
  assert.ok(result.path.some(point => point.z === 15) && result.path.some(point => point.z === 16));
  for (let index = 1; index < result.path.length; index++) {
    assert.ok(grid.canTravel(result.path[index - 1], result.path[index]));
    assert.equal(result.path[index].portalId, undefined);
  }
  assert.deepEqual(result.path.at(-1), { region: 'overworld', x: 45, z: 29 });
});

test('portal edges connect regions in their declared direction and mark arrival waypoints', () => {
  const graph = createNavigationGraph([{ id: 'overworld', grid: openGrid(5, 5) }, { id: 'dungeon', grid: openGrid(5, 5) }], [chunk('outside', 'overworld'), chunk('inside', 'dungeon')], [entrance()]);
  const from = { region: 'overworld', x: 1, z: 2 };
  const target = { region: 'dungeon', x: 3, z: 2 };
  const result = findWorldPath(graph, from, target, { goalRadius: 0 });
  assert.equal(result.status, 'found');
  const arrivalIndex = result.path.findIndex(point => point.portalId === 'entrance');
  assert.ok(arrivalIndex > 0);
  assert.deepEqual(result.path[arrivalIndex - 1], { region: 'overworld', x: 4, z: 2 });
  assert.deepEqual(result.path[arrivalIndex], { region: 'dungeon', x: 1, z: 2, portalId: 'entrance' });
  assert.equal(findWorldPath(graph, target, from, { goalRadius: 0 }).status, 'no-path');
});

test('AI respects entrance leashing and can follow through portals explicitly enabled for it', () => {
  const regions = [{ id: 'overworld', grid: openGrid(5, 5) }, { id: 'dungeon', grid: openGrid(5, 5) }];
  const chunks = [chunk('outside', 'overworld'), chunk('inside', 'dungeon')];
  const from = { region: 'overworld', x: 1, z: 2 };
  const target = { region: 'dungeon', x: 3, z: 2 };
  const leashed = createNavigationGraph(regions, chunks, [entrance(false)]);
  assert.equal(findWorldPath(leashed, from, target, { traversableByAI: true }).status, 'no-path');
  assert.equal(findWorldPath(leashed, from, target).status, 'found', 'Player requests can traverse a dungeon entrance');
  const chase = createNavigationGraph(regions, chunks, [entrance(true)]);
  assert.equal(findWorldPath(chase, from, target, { traversableByAI: true }).status, 'found');
});

test('cheap distant portals stay optimal even when reaching their source moves away from the target', () => {
  const grid = openGrid(20, 3);
  const chunks = [chunk('field', 'overworld', 20, 3)];
  const portal: NavigationPortal = { id: 'shortcut', fromChunk: 'field', fromTile: { x: 0, z: 1 }, toChunk: 'field', toTile: { x: 19, z: 1 }, traversalCost: 0, traversableByAI: true };
  const from = { region: 'overworld', x: 3, z: 1 };
  const target = { region: 'overworld', x: 19, z: 1 };
  const cheap = findWorldPath(createNavigationGraph([{ id: 'overworld', grid }], chunks, [portal]), from, target, { goalRadius: 0 });
  assert.equal(cheap.status, 'found');
  assert.equal(cheap.path.at(-1)?.portalId, 'shortcut');
  assert.ok(cheap.path.some(point => point.x === 0));
  const expensive = findWorldPath(createNavigationGraph([{ id: 'overworld', grid }], chunks, [{ ...portal, traversalCost: 100 }]), from, target, { goalRadius: 0 });
  assert.equal(expensive.status, 'found');
  assert.ok(expensive.path.every(point => point.portalId === undefined), 'An expensive warp should lose to ordinary walking');
});

test('portal costs select the cheaper route across different chunks and regions', () => {
  const regions = [{ id: 'overworld', grid: openGrid(10, 3) }, { id: 'dungeon', grid: openGrid(5, 3) }];
  const chunks = [{ ...chunk('outside', 'overworld', 5, 3), origin: { x: 5, z: 0 } }, chunk('inside', 'dungeon', 5, 3)];
  const costly: NavigationPortal = { id: 'costly', fromChunk: 'outside', fromTile: { x: 0, z: 1 }, toChunk: 'inside', toTile: { x: 1, z: 1 }, traversalCost: 20, traversableByAI: true };
  const cheap: NavigationPortal = { ...costly, id: 'cheap', fromTile: { x: 4, z: 1 }, traversalCost: 1 };
  const result = findWorldPath(createNavigationGraph(regions, chunks, [costly, cheap]), { region: 'overworld', x: 5, z: 1 }, { region: 'dungeon', x: 3, z: 1 }, { goalRadius: 0 });
  assert.equal(result.status, 'found');
  const arrivalIndex = result.path.findIndex(point => point.portalId === 'cheap');
  assert.ok(arrivalIndex > 0);
  assert.equal(result.path[arrivalIndex - 1].x, 9, 'A local portal tile must include its chunk origin');
  assert.ok(result.path.every(point => point.portalId !== 'costly'));
});

test('blocked portal endpoints disable traversal and graph rebuilds restore changed tiles', () => {
  const chunks = [chunk('outside', 'overworld'), chunk('inside', 'dungeon')];
  const from = { region: 'overworld', x: 1, z: 2 };
  const target = { region: 'dungeon', x: 3, z: 2 };
  const blocksTile = (tileX: number, tileZ: number) => (x: number, z: number) => Math.abs(x - tileX) <= 0.5 && Math.abs(z - tileZ) <= 0.5;
  for (const blockedEnd of ['source', 'destination']) {
    const regions = [
      { id: 'overworld', grid: openGrid(5, 5, blockedEnd === 'source' ? blocksTile(4, 2) : undefined) },
      { id: 'dungeon', grid: openGrid(5, 5, blockedEnd === 'destination' ? blocksTile(1, 2) : undefined) },
    ];
    assert.equal(findWorldPath(createNavigationGraph(regions, chunks, [entrance(true)]), from, target).status, 'no-path');
  }
  const rebuilt = createNavigationGraph([{ id: 'overworld', grid: openGrid(5, 5) }, { id: 'dungeon', grid: openGrid(5, 5) }], chunks, [entrance(true)]);
  assert.equal(findWorldPath(rebuilt, from, target).status, 'found');
});

test('world navigation rejects blocked endpoints, diagonal wall corners, and a goal behind a sealed wall', () => {
  const blocked = (x: number, z: number) => Math.abs(x - 1) <= 0.5 && Math.abs(z) <= 0.5 || Math.abs(x) <= 0.5 && Math.abs(z - 1) <= 0.5;
  const grid = createNavigationGrid(4, 4, blocked);
  const graph = createNavigationGraph([{ id: 'room', grid }], [chunk('room', 'room', 4, 4)], []);
  assert.equal(findWorldPath(graph, { region: 'room', x: 0, z: 0 }, { region: 'room', x: 2, z: 2 }, { goalRadius: 0.1 }).status, 'no-path');
  assert.equal(findWorldPath(graph, { region: 'room', x: 1, z: 0 }, { region: 'room', x: 2, z: 2 }).status, 'no-path');
  assert.equal(findWorldPath(graph, { region: 'room', x: 2, z: 2 }, { region: 'room', x: 1, z: 0 }).status, 'no-path');
  const wall = createNavigationGrid(7, 7, (x, z) => x > 3.25 && x < 3.6 && z >= 0 && z <= 6);
  const sealed = createNavigationGraph([{ id: 'room', grid: wall }], [chunk('room', 'room', 7, 7)], []);
  assert.equal(findWorldPath(sealed, { region: 'room', x: 2, z: 3 }, { region: 'room', x: 3.8, z: 3 }).status, 'no-path');
});

test('world paths leave a large body at a visible accessible goal instead of appending a blocked target', () => {
  const wall = (x: number) => x < 1;
  const grid = createNavigationGrid(8, 8, (x, z) => wall(x - 0.8) || z < 1, (x, z) => wall(x - 0.035) || z < 0.035);
  const graph = createNavigationGraph([{ id: 'room', grid }], [chunk('room', 'room', 8, 8)], []);
  const target = { region: 'room', x: 1.4, z: 4 };
  const result = findWorldPath(graph, { region: 'room', x: 5, z: 4 }, target, { goalRadius: 1.8 });
  assert.equal(result.status, 'found');
  assert.ok(result.path.at(-1)!.x >= 2);
  assert.ok(grid.canSeeTarget(result.path.at(-1)!, target));
  assert.ok(result.path.every(point => grid.canTravel(point, point)));
});

test('a bounded search distinguishes exhausted work from a proven missing path', () => {
  const graph = createNavigationGraph([{ id: 'room', grid: openGrid(50, 50) }], [chunk('room', 'room', 50, 50)], []);
  const from = { region: 'room', x: 0, z: 0 };
  const target = { region: 'room', x: 49, z: 49 };
  const limited = findWorldPath(graph, from, target, { goalRadius: 0, maxExpansions: 10 });
  assert.deepEqual(limited, { status: 'budget-exhausted', path: [], expansions: 10 });
  assert.deepEqual(findWorldPath(graph, from, target, { maxExpansions: 0 }), { status: 'budget-exhausted', path: [], expansions: 0 });
  assert.equal(findWorldPath(graph, from, target, { goalRadius: 0, maxExpansions: 2500 }).status, 'found');
  const disconnected = createNavigationGraph([{ id: 'room', grid: openGrid(5, 3, (x) => Math.abs(x - 2) <= 0.5) }], [chunk('room', 'room', 5, 3)], []);
  const absent = findWorldPath(disconnected, { region: 'room', x: 0, z: 1 }, { region: 'room', x: 4, z: 1 }, { goalRadius: 0, maxExpansions: 100 });
  assert.equal(absent.status, 'no-path');
  assert.ok(absent.expansions > 0 && absent.expansions < 100);
});

test('invalid portal data is rejected instead of silently creating unsafe navigation edges', () => {
  const regions = [{ id: 'overworld', grid: openGrid(5, 5) }, { id: 'dungeon', grid: openGrid(5, 5) }];
  const chunks = [chunk('outside', 'overworld'), chunk('inside', 'dungeon')];
  for (const invalid of [
    { ...entrance(), fromChunk: 'missing' },
    { ...entrance(), fromTile: { x: 5, z: 2 } },
    { ...entrance(), toTile: { x: 1.5, z: 2 } },
    { ...entrance(), traversalCost: -1 },
    { ...entrance(), traversalCost: Infinity },
  ]) assert.throws(() => createNavigationGraph(regions, chunks, [invalid]), /Invalid or duplicate navigation portal/);
  assert.throws(() => createNavigationGraph(regions, chunks, [entrance(), entrance()]), /duplicate navigation portal/);
});
