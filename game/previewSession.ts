import type { StoreApi, UseBoundStore } from 'zustand';
import { createInitialData, type AdventureData } from './simulation';
import type { AdventureStore } from './store';

type AdventureHook = UseBoundStore<StoreApi<AdventureStore>>;
type PreviewCache = {
  store: AdventureHook;
  state: AdventureData;
  restoredStores: WeakSet<AdventureHook>;
};
type PreviewWindow = Window & { __mosslightPreviewSessionV1?: PreviewCache };
const STORAGE_KEY = 'mosslight:preview-session:v1';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const zone = (value: unknown): boolean => value === 'overworld' || value === 'dungeon';
const position = (value: unknown): boolean => record(value) && finite(value.x) && finite(value.z);
const entities = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.every(item => record(item) && typeof item.id === 'string' && position(item));

function validEnemies(value: unknown): boolean {
  return entities(value) && value.every(enemy =>
    typeof enemy.alive === 'boolean' && typeof enemy.boss === 'boolean'
    && finite(enemy.hp) && finite(enemy.maxHp) && zone(enemy.homeZone)
    && record(enemy.navigation) && Array.isArray(enemy.navigation.path)
    && enemy.navigation.path.every(point => position(point) && record(point) && typeof point.region === 'string'));
}

/** Reject incomplete/corrupt runs before handing them to physics and rendering. */
function restoreData(value: unknown, defaults: AdventureData): AdventureData | null {
  if (!record(value)
    || !['title', 'playing', 'paused', 'gameover', 'victory'].includes(String(value.status))
    || !zone(value.zone) || !record(value.player) || !record(value.quest)) return null;
  if (Object.keys(defaults.player).some(key => !finite((value.player as Record<string, unknown>)[key]))
    || Object.keys(defaults.quest).some(key => typeof (value.quest as Record<string, unknown>)[key] !== 'boolean')) return null;
  if (!validEnemies(value.enemies) || !entities(value.breakables) || !entities(value.pickups)
    || !entities(value.projectiles) || !entities(value.effects)
    || (value.hazards !== undefined && (!entities(value.hazards) || value.hazards.some(hazard =>
      !finite(hazard.age) || hazard.age < 0 || !finite(hazard.duration) || hazard.duration <= 0
      || !finite(hazard.radius) || hazard.radius <= 0 || typeof hazard.ownerId !== 'string')))
    || !record(value.zoneMemory) || !record(value.tileOverrides)
    || !Array.isArray(value.portals) || !value.portals.every(portal => record(portal)
      && typeof portal.id === 'string' && position(portal.fromTile) && position(portal.toTile))) return null;
  for (const [region, saved] of Object.entries(value.zoneMemory)) {
    if (!zone(region) || !record(saved) || !validEnemies(saved.enemies)
      || !entities(saved.breakables) || !entities(saved.pickups)) return null;
  }
  for (const key of ['elapsed', 'rupees', 'shake', 'hurtFlash', 'seed', 'nextId']) {
    if (!finite(value[key])) return null;
  }
  if (typeof value.muted !== 'boolean' || typeof value.area !== 'string'
    || !Array.isArray(value.attackHitIds) || !value.attackHitIds.every(id => typeof id === 'string')
    || !record(value.inputLatch) || typeof value.inputLatch.interact !== 'boolean'
    || (value.portalArrivalLocks !== undefined && (!Array.isArray(value.portalArrivalLocks)
      || !value.portalArrivalLocks.every(id => typeof id === 'string')))
    || (value.notice !== null && (!record(value.notice) || typeof value.notice.title !== 'string'
      || typeof value.notice.body !== 'string' || !finite(value.notice.time)))) return null;
  const restored = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof AdventureData)[]) {
    if (value[key] !== undefined) Object.assign(restored, { [key]: value[key] });
  }
  restored.navigationStats = { ...defaults.navigationStats, ...restored.navigationStats };
  return restored;
}

function snapshot(state: AdventureStore, keys: (keyof AdventureData)[]): AdventureData {
  return Object.fromEntries(keys.map(key => [key, state[key]])) as unknown as AdventureData;
}

/** Seed replacement modules from live memory; cold reloads still restore after hydration. */
export function getPreviewSessionState(): AdventureData | null {
  if (process.env.NODE_ENV !== 'development' || typeof window === 'undefined') return null;
  const saved = (window as PreviewWindow).__mosslightPreviewSessionV1?.state;
  return saved ? restoreData(saved, createInitialData()) : null;
}

/** Keep the live localhost preview intact during edits. Published games have no saves. */
export function attachPreviewSession(store: AdventureHook): () => void {
  if (process.env.NODE_ENV !== 'development' || typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const previewWindow = window as PreviewWindow;
  const defaults = createInitialData();
  const keys = Object.keys(defaults) as (keyof AdventureData)[];
  const previous = previewWindow.__mosslightPreviewSessionV1;
  const restoredStores = previous?.restoredStores ?? new WeakSet<AdventureHook>();

  if (!restoredStores.has(store)) {
    let saved = previous?.state;
    if (!saved) {
      try {
        const text = window.sessionStorage.getItem(STORAGE_KEY);
        const envelope: unknown = text ? JSON.parse(text) : null;
        if (record(envelope) && envelope.version === 1) saved = envelope.state as AdventureData;
      } catch {
        // Privacy settings and stale development snapshots must not block play.
      }
    }
    const restored = restoreData(saved, defaults);
    if (restored) store.setState(restored);
    restoredStores.add(store);
  }

  const cache: PreviewCache = { store, state: snapshot(store.getState(), keys), restoredStores };
  previewWindow.__mosslightPreviewSessionV1 = cache;
  let lastWritten = -Infinity;
  const save = () => {
    // An outgoing HMR effect must not overwrite the replacement store's run.
    if (previewWindow.__mosslightPreviewSessionV1 !== cache) return;
    cache.state = snapshot(store.getState(), keys);
    lastWritten = Date.now();
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, state: cache.state }));
    } catch {}
  };
  const unsubscribe = store.subscribe((state, oldState) => {
    if (previewWindow.__mosslightPreviewSessionV1 !== cache) return;
    cache.state = snapshot(state, keys);
    if (state.status !== oldState.status || state.zone !== oldState.zone || Date.now() - lastWritten >= 1000) save();
  });
  document.addEventListener('visibilitychange', save);
  window.addEventListener('pagehide', save);
  save();
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    save();
    unsubscribe();
    document.removeEventListener('visibilitychange', save);
    window.removeEventListener('pagehide', save);
  };
}
