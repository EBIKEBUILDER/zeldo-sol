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

export interface NavigationLocation extends NavigationPoint { region: string; }
/** A portal id belongs to the destination waypoint of that directed edge. */
export interface NavigationWaypoint extends NavigationLocation { portalId?: string; }
export interface NavigationChunk {
  id: string;
  region: string;
  origin: NavigationPoint;
  width: number;
  height: number;
}
export interface NavigationPortal {
  id: string;
  fromChunk: string;
  fromTile: NavigationPoint;
  toChunk: string;
  toTile: NavigationPoint;
  traversalCost: number;
  traversableByAI: boolean;
  activationRadius?: number;
}

interface IndexedNavigationRegion { id: string; grid: NavigationGrid; offset: number; }
interface NavigationPortalEdge { destination: number; portal: NavigationPortal; }
export interface NavigationGraph {
  readonly regions: ReadonlyMap<string, NavigationGrid>;
  readonly chunks: ReadonlyMap<string, NavigationChunk>;
  readonly portals: readonly NavigationPortal[];
  readonly nodeCount: number;
  readonly indexedRegions: readonly IndexedNavigationRegion[];
  readonly regionById: ReadonlyMap<string, IndexedNavigationRegion>;
  readonly portalEdges: ReadonlyMap<number, readonly NavigationPortalEdge[]>;
}
export interface WorldPathOptions {
  goalRadius?: number;
  /** Omit for player navigation; true excludes portals that leash monsters. */
  traversableByAI?: boolean;
  maxExpansions?: number;
}
export interface WorldPathResult {
  status: 'found' | 'no-path' | 'budget-exhausted';
  path: NavigationWaypoint[];
  expansions: number;
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

function tileInBounds(point: NavigationPoint, width: number, height: number): boolean {
  return Number.isInteger(point.x) && Number.isInteger(point.z) && point.x >= 0 && point.z >= 0 && point.x < width && point.z < height;
}

/**
 * Chunks locate portal endpoints inside a region. Ordinary tile edges span the
 * entire region grid, so adjoining chunks have no artificial boundary walls.
 * Recreate this graph after rebuilding a grid when terrain changes.
 */
export function createNavigationGraph(
  regions: ReadonlyArray<{ id: string; grid: NavigationGrid }>,
  chunks: readonly NavigationChunk[],
  portals: readonly NavigationPortal[],
): NavigationGraph {
  const grids = new Map<string, NavigationGrid>();
  const indexedRegions: IndexedNavigationRegion[] = [];
  const regionById = new Map<string, IndexedNavigationRegion>();
  let nodeCount = 0;
  for (const { id, grid } of regions) {
    if (!id || grids.has(id)) throw new Error(`Invalid or duplicate navigation region: ${id}`);
    if (!Number.isInteger(grid.width) || !Number.isInteger(grid.height) || grid.width <= 0 || grid.height <= 0 || grid.blocked.length !== grid.width * grid.height || grid.edges.length !== grid.width * grid.height) {
      throw new Error(`Invalid navigation grid: ${id}`);
    }
    const indexed = { id, grid, offset: nodeCount };
    grids.set(id, grid);
    indexedRegions.push(indexed);
    regionById.set(id, indexed);
    nodeCount += grid.width * grid.height;
  }

  const indexedChunks = new Map<string, NavigationChunk>();
  for (const chunk of chunks) {
    const region = regionById.get(chunk.region);
    if (!chunk.id || indexedChunks.has(chunk.id) || !region || !Number.isInteger(chunk.width) || !Number.isInteger(chunk.height) || chunk.width <= 0 || chunk.height <= 0 || !tileInBounds(chunk.origin, region.grid.width, region.grid.height) || chunk.origin.x + chunk.width > region.grid.width || chunk.origin.z + chunk.height > region.grid.height) {
      throw new Error(`Invalid or duplicate navigation chunk: ${chunk.id}`);
    }
    indexedChunks.set(chunk.id, { ...chunk, origin: { ...chunk.origin } });
  }

  const indexedPortals: NavigationPortal[] = [];
  const portalIds = new Set<string>();
  const portalEdges = new Map<number, NavigationPortalEdge[]>();
  for (const portal of portals) {
    const source = indexedChunks.get(portal.fromChunk);
    const destination = indexedChunks.get(portal.toChunk);
    if (!portal.id || portalIds.has(portal.id) || !source || !destination || !tileInBounds(portal.fromTile, source.width, source.height) || !tileInBounds(portal.toTile, destination.width, destination.height) || !Number.isFinite(portal.traversalCost) || portal.traversalCost < 0 || typeof portal.traversableByAI !== 'boolean' || portal.activationRadius !== undefined && (!Number.isFinite(portal.activationRadius) || portal.activationRadius <= 0)) {
      throw new Error(`Invalid or duplicate navigation portal: ${portal.id}`);
    }
    portalIds.add(portal.id);
    const copy = { ...portal, fromTile: { ...portal.fromTile }, toTile: { ...portal.toTile } };
    indexedPortals.push(copy);
    const sourceRegion = regionById.get(source.region)!;
    const destinationRegion = regionById.get(destination.region)!;
    const sourcePoint = { x: source.origin.x + portal.fromTile.x, z: source.origin.z + portal.fromTile.z };
    const destinationPoint = { x: destination.origin.x + portal.toTile.x, z: destination.origin.z + portal.toTile.z };
    const sourceLocal = sourcePoint.z * sourceRegion.grid.width + sourcePoint.x;
    const destinationLocal = destinationPoint.z * destinationRegion.grid.width + destinationPoint.x;
    // A shut door or solid arrival tile disables the edge until the next rebuild.
    if (sourceRegion.grid.blocked[sourceLocal] || destinationRegion.grid.blocked[destinationLocal]) continue;
    const sourceNode = sourceRegion.offset + sourceLocal;
    const edges = portalEdges.get(sourceNode) ?? [];
    edges.push({ destination: destinationRegion.offset + destinationLocal, portal: copy });
    portalEdges.set(sourceNode, edges);
  }
  return { regions: grids, chunks: indexedChunks, portals: indexedPortals, nodeCount, indexedRegions, regionById, portalEdges };
}

function regionForNode(graph: NavigationGraph, node: number): IndexedNavigationRegion {
  let low = 0;
  let high = graph.indexedRegions.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (graph.indexedRegions[middle].offset <= node) low = middle;
    else high = middle - 1;
  }
  return graph.indexedRegions[low];
}

function locationForNode(graph: NavigationGraph, node: number): NavigationLocation {
  const region = regionForNode(graph, node);
  const local = node - region.offset;
  return { region: region.id, x: local % region.grid.width, z: Math.floor(local / region.grid.width) };
}

function pointInGrid(grid: NavigationGrid, point: NavigationPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.z) && point.x >= 0 && point.z >= 0 && point.x <= grid.width - 1 && point.z <= grid.height - 1;
}

/** A* over region grids and directed, costed portal edges, with a hard work cap. */
export function findWorldPath(graph: NavigationGraph, from: NavigationLocation, target: NavigationLocation, options: WorldPathOptions = {}): WorldPathResult {
  const goalRadius = options.goalRadius ?? 1.5;
  const maxExpansions = options.maxExpansions ?? Infinity;
  if (!Number.isFinite(goalRadius) || goalRadius < 0 || !(maxExpansions === Infinity || Number.isInteger(maxExpansions) && maxExpansions >= 0)) throw new Error('Invalid world path search limits');
  const source = graph.regionById.get(from.region);
  const destination = graph.regionById.get(target.region);
  const noPath: WorldPathResult = { status: 'no-path', path: [], expansions: 0 };
  if (!source || !destination || !pointInGrid(source.grid, from) || !pointInGrid(destination.grid, target) || !source.grid.canTravel(from, from) || !destination.grid.canSeeTarget(target, target)) return noPath;
  const starts = nearbyCells(source.grid, from, 1.8, true);
  const goals = nearbyCells(destination.grid, target, goalRadius, false).filter(index => destination.grid.canSeeTarget({ x: index % destination.grid.width, z: Math.floor(index / destination.grid.width) }, target));
  if (!starts.length || !goals.length) return noPath;
  const nearest = goals[0];
  const nearestDistance = Math.hypot(nearest % destination.grid.width - target.x, Math.floor(nearest / destination.grid.width) - target.z);
  const goalSet = new Set(goals.filter(index => Math.hypot(index % destination.grid.width - target.x, Math.floor(index / destination.grid.width) - target.z) <= nearestDistance + 0.35).map(index => destination.offset + index));
  const costs = new Float64Array(graph.nodeCount).fill(Infinity);
  const parents = new Int32Array(graph.nodeCount).fill(-1);
  const incomingPortals: (string | undefined)[] = new Array(graph.nodeCount);
  const visited = new Uint8Array(graph.nodeCount);
  const open = new OpenQueue();
  // A geometric estimate can overestimate a cheap distant warp. Dijkstra's
  // zero estimate keeps those routes optimal, including same-region portals.
  const hasPortals = [...graph.portalEdges.values()].some(edges => edges.some(edge => !options.traversableByAI || edge.portal.traversableByAI));
  const heuristic = (node: number) => {
    if (hasPortals || source !== destination) return 0;
    const local = node - destination.offset;
    return Math.max(0, Math.hypot(local % destination.grid.width - target.x, Math.floor(local / destination.grid.width) - target.z) - goalRadius);
  };
  for (const local of starts) {
    const node = source.offset + local;
    costs[node] = Math.hypot(local % source.grid.width - from.x, Math.floor(local / source.grid.width) - from.z);
    open.push(node, costs[node] + heuristic(node));
  }
  let expansions = 0;
  while (open.length) {
    const current = open.pop();
    if (visited[current]) continue;
    if (expansions >= maxExpansions) return { status: 'budget-exhausted', path: [], expansions };
    visited[current] = 1;
    expansions++;
    if (goalSet.has(current)) {
      const path: NavigationWaypoint[] = [];
      for (let cursor = current; cursor !== -1; cursor = parents[cursor]) {
        const waypoint: NavigationWaypoint = locationForNode(graph, cursor);
        if (incomingPortals[cursor] !== undefined) waypoint.portalId = incomingPortals[cursor];
        path.push(waypoint);
      }
      path.reverse();
      const last = path[path.length - 1];
      if ((last.x !== target.x || last.z !== target.z) && destination.grid.canTravel(last, target)) path.push({ x: target.x, z: target.z, region: target.region });
      return { status: 'found', path, expansions };
    }
    const region = regionForNode(graph, current);
    const local = current - region.offset;
    for (let direction = 0; direction < directions.length; direction++) {
      if (!(region.grid.edges[local] & (1 << direction))) continue;
      const [dx, dz] = directions[direction];
      const next = current + dz * region.grid.width + dx;
      const cost = costs[current] + (dx && dz ? Math.SQRT2 : 1);
      if (cost >= costs[next]) continue;
      costs[next] = cost;
      parents[next] = current;
      incomingPortals[next] = undefined;
      open.push(next, cost + heuristic(next));
    }
    for (const edge of graph.portalEdges.get(current) ?? []) {
      if (options.traversableByAI && !edge.portal.traversableByAI) continue;
      const cost = costs[current] + edge.portal.traversalCost;
      if (cost >= costs[edge.destination]) continue;
      costs[edge.destination] = cost;
      parents[edge.destination] = current;
      incomingPortals[edge.destination] = edge.portal.id;
      open.push(edge.destination, cost + heuristic(edge.destination));
    }
  }
  return { status: 'no-path', path: [], expansions };
}
