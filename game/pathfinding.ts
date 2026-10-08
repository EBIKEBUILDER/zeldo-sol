import type { NavigationPoint } from './types';

const directions = [
  [1, 0], [0, 1], [-1, 0], [0, -1],
  [1, 1], [-1, 1], [-1, -1], [1, -1],
] as const;

export interface NavigationGrid {
  width: number;
  height: number;
  blocked: Uint8Array;
  edges: Uint8Array;
  canTravel: (from: NavigationPoint, to: NavigationPoint) => boolean;
  canSeeTarget: (from: NavigationPoint, to: NavigationPoint) => boolean;
}

/** The same radius-aware collision query drives both navigation and physics. */
export function createNavigationGrid(width: number, height: number, isBlocked: (x: number, z: number) => boolean, isPointBlocked = isBlocked): NavigationGrid {
  const blocked = new Uint8Array(width * height);
  const edges = new Uint8Array(width * height);
  const line = (from: NavigationPoint, to: NavigationPoint, query: typeof isBlocked) => {
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.ceil(length / 0.2));
    for (let step = 1; step <= steps; step++) {
      if (query(from.x + (to.x - from.x) * step / steps, from.z + (to.z - from.z) * step / steps)) return false;
    }
    return true;
  };
  const canTravel = (from: NavigationPoint, to: NavigationPoint) => line(from, to, isBlocked);
  const canSeeTarget = (from: NavigationPoint, to: NavigationPoint) => line(from, to, isPointBlocked);
  for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) blocked[z * width + x] = Number(isBlocked(x, z));
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      const index = z * width + x;
      if (blocked[index]) continue;
      for (let direction = 0; direction < directions.length; direction++) {
        const [dx, dz] = directions[direction];
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= width || nz >= height || blocked[nz * width + nx]) continue;
        // Prevent a diagonal from cutting a wall/pot corner.
        if (dx && dz && (blocked[z * width + nx] || blocked[nz * width + x])) continue;
        if (canTravel({ x, z }, { x: nx, z: nz })) edges[index] |= 1 << direction;
      }
    }
  }
  return { width, height, blocked, edges, canTravel, canSeeTarget };
}

class OpenQueue {
  private heap: { index: number; score: number }[] = [];
  get length() { return this.heap.length; }
  push(index: number, score: number) {
    const entry = { index, score };
    let child = this.heap.length;
    this.heap.push(entry);
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.heap[parent].score <= score) break;
      this.heap[child] = this.heap[parent];
      child = parent;
    }
    this.heap[child] = entry;
  }
  pop(): number {
    const root = this.heap[0].index;
    const last = this.heap.pop()!;
    if (this.heap.length) {
      let parent = 0;
      while (parent * 2 + 1 < this.heap.length) {
        let child = parent * 2 + 1;
        if (child + 1 < this.heap.length && this.heap[child + 1].score < this.heap[child].score) child++;
        if (last.score <= this.heap[child].score) break;
        this.heap[parent] = this.heap[child];
        parent = child;
      }
      this.heap[parent] = last;
    }
    return root;
  }
}

function nearbyCells(grid: NavigationGrid, point: NavigationPoint, radius: number, requireTravel: boolean): number[] {
  const candidates: number[] = [];
  for (let z = Math.max(0, Math.floor(point.z - radius)); z <= Math.min(grid.height - 1, Math.ceil(point.z + radius)); z++) {
    for (let x = Math.max(0, Math.floor(point.x - radius)); x <= Math.min(grid.width - 1, Math.ceil(point.x + radius)); x++) {
      const index = z * grid.width + x;
      if (grid.blocked[index] || Math.hypot(x - point.x, z - point.z) > radius) continue;
      if (requireTravel && !grid.canTravel(point, { x, z })) continue;
      candidates.push(index);
    }
  }
  return candidates.sort((a, b) => Math.hypot(a % grid.width - point.x, Math.floor(a / grid.width) - point.z) - Math.hypot(b % grid.width - point.x, Math.floor(b / grid.width) - point.z));
}

/** A* on tile centers; a reachable adjacent goal allows large bodies to approach small players. */
export function findPath(grid: NavigationGrid, from: NavigationPoint, target: NavigationPoint, goalRadius = 1.5): NavigationPoint[] | null {
  const starts = nearbyCells(grid, from, 1.8, true);
  const goals = nearbyCells(grid, target, goalRadius, false).filter(index => grid.canSeeTarget({ x: index % grid.width, z: Math.floor(index / grid.width) }, target));
  if (!starts.length || !goals.length) return null;
  // A tile near the player must be connected to their position; otherwise a
  // wall's far side would incorrectly count as a successful destination.
  const nearest = goals[0];
  const nearestDistance = Math.hypot(nearest % grid.width - target.x, Math.floor(nearest / grid.width) - target.z);
  const goalSet = new Set(goals.filter(index => Math.hypot(index % grid.width - target.x, Math.floor(index / grid.width) - target.z) <= nearestDistance + 0.35));
  const length = grid.width * grid.height;
  const costs = new Float64Array(length).fill(Infinity);
  const parents = new Int32Array(length).fill(-1);
  const visited = new Uint8Array(length);
  const open = new OpenQueue();
  const heuristic = (index: number) => Math.max(0, Math.hypot(index % grid.width - target.x, Math.floor(index / grid.width) - target.z) - goalRadius);
  for (const start of starts) {
    costs[start] = Math.hypot(start % grid.width - from.x, Math.floor(start / grid.width) - from.z);
    open.push(start, costs[start] + heuristic(start));
  }
  while (open.length) {
    const current = open.pop();
    if (visited[current]) continue;
    visited[current] = 1;
    if (goalSet.has(current)) {
      const path: NavigationPoint[] = [];
      for (let cursor = current; cursor !== -1; cursor = parents[cursor]) path.push({ x: cursor % grid.width, z: Math.floor(cursor / grid.width) });
      path.reverse();
      if (grid.canTravel(path[path.length - 1], target)) path.push({ ...target });
      return path;
    }
    for (let direction = 0; direction < directions.length; direction++) {
      if (!(grid.edges[current] & (1 << direction))) continue;
      const [dx, dz] = directions[direction];
      const next = current + dz * grid.width + dx;
      const cost = costs[current] + (dx && dz ? Math.SQRT2 : 1);
      if (cost >= costs[next]) continue;
      costs[next] = cost;
      parents[next] = current;
      open.push(next, cost + heuristic(next));
    }
  }
  return null;
}
