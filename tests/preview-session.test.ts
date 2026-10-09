import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from 'zustand';
import { attachPreviewSession, getPreviewSessionState } from '../game/previewSession';
import { createInitialData, type AdventureData } from '../game/simulation';
import type { AdventureStore } from '../game/store';

const STORAGE_KEY = 'mosslight:preview-session:v1';

class FakeEvents {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(name: string, listener: () => void): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: () => void): void { this.listeners.get(name)?.delete(listener); }
  dispatch(name: string): void { for (const listener of this.listeners.get(name) ?? []) listener(); }
  get listenerCount(): number { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

class FakeStorage {
  values = new Map<string, string>();
  reads = 0;
  writes = 0;
  unavailable = false;
  getItem(key: string): string | null {
    this.reads++;
    if (this.unavailable) throw new Error('Storage unavailable');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    if (this.unavailable) throw new Error('Storage unavailable');
    this.values.set(key, value);
  }
  saved(): AdventureStore {
    return JSON.parse(this.values.get(STORAGE_KEY)!).state as AdventureStore;
  }
}

class FakeBrowser extends FakeEvents {
  constructor(public sessionStorage = new FakeStorage()) { super(); }
}

function makeStore() {
  return create<AdventureStore>(set => ({
    ...createInitialData(),
    start: () => set(createInitialData('playing')),
    togglePause: () => set(state => ({ status: state.status === 'paused' ? 'playing' : 'paused' })),
    toggleMute: () => set(state => ({ muted: !state.muted })),
    tick: () => {},
  }));
}

function environment(run: (browser: FakeBrowser, document: FakeEvents, setBrowser: (next: FakeBrowser) => void) => void, mode = 'development'): void {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldMode = process.env.NODE_ENV;
  const env = process.env as Record<string, string | undefined>;
  const browser = new FakeBrowser();
  const document = new FakeEvents();
  const setBrowser = (next: FakeBrowser) => Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: next });
  env.NODE_ENV = mode;
  setBrowser(browser);
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
  try { run(browser, document, setBrowser); }
  finally {
    if (oldMode === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = oldMode;
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

test('a development full reload restores the current run while keeping new actions and defaults', () => environment((browser, _document, setBrowser) => {
  const first = makeStore();
  const detachFirst = attachPreviewSession(first);
  first.setState(state => ({
    status: 'paused', zone: 'dungeon', player: { ...state.player, x: 12, z: 22, hp: 2 },
    quest: { key: true, gate: true, boss: false, treasure: false }, rupees: 17, elapsed: 93, muted: true,
    zoneMemory: { overworld: { enemies: state.enemies, breakables: state.breakables, pickups: state.pickups } },
  }));
  detachFirst();
  const serialized = JSON.parse(browser.sessionStorage.values.get(STORAGE_KEY)!);
  delete serialized.state.navigationStats;
  delete serialized.state.navigationCursor;
  delete serialized.state.hazards;
  serialized.state.start = 'stale action from a previous bundle';
  browser.sessionStorage.values.set(STORAGE_KEY, JSON.stringify(serialized));
  setBrowser(new FakeBrowser(browser.sessionStorage));
  const replacement = makeStore();
  const freshActions = replacement.getState();
  const detachReplacement = attachPreviewSession(replacement);
  const restored = replacement.getState();
  assert.equal(restored.status, 'paused');
  assert.equal(restored.zone, 'dungeon');
  assert.deepEqual(restored.player, first.getState().player);
  assert.deepEqual(restored.quest, first.getState().quest);
  assert.equal(restored.rupees, 17);
  assert.equal(restored.elapsed, 93);
  assert.equal(restored.muted, true);
  assert.deepEqual(restored.zoneMemory, first.getState().zoneMemory);
  assert.deepEqual(restored.navigationStats, { searches: 0, expansions: 0, deferred: 0 });
  assert.equal(restored.navigationCursor, 0);
  assert.deepEqual(restored.hazards, [], 'new hazards default safely when loading an older preview');
  for (const action of ['start', 'togglePause', 'toggleMute', 'tick'] as const) assert.equal(restored[action], freshActions[action]);
  restored.togglePause();
  assert.equal(replacement.getState().status, 'playing', 'the replacement action remains callable');
  detachReplacement();
}));

test('replacement modules read the latest validated memory without synchronously loading storage', () => environment((browser) => {
  browser.sessionStorage.values.set(STORAGE_KEY, JSON.stringify({ version: 1, state: createInitialData('playing') }));
  assert.equal(getPreviewSessionState(), null, 'cold loads wait for the post-mount storage restoration');
  assert.equal(browser.sessionStorage.reads, 0);
  const store = makeStore();
  const detach = attachPreviewSession(store);
  store.setState(state => ({ status: 'paused', player: { ...state.player, x: 21, z: 11 }, rupees: 9 }));
  const reads = browser.sessionStorage.reads;
  const cache = (browser as unknown as { __mosslightPreviewSessionV1: { state: Partial<AdventureData> } }).__mosslightPreviewSessionV1;
  delete cache.state.hazards;
  delete cache.state.navigationStats;
  const restored = getPreviewSessionState();
  assert.ok(restored);
  assert.equal(restored.status, 'paused');
  assert.equal(restored.player, store.getState().player);
  assert.equal(restored.rupees, 9);
  assert.deepEqual(restored.hazards, []);
  assert.deepEqual(restored.navigationStats, { searches: 0, expansions: 0, deferred: 0 });
  assert.equal('start' in restored, false, 'the synchronous seed contains data without stale actions');
  assert.equal(browser.sessionStorage.reads, reads);
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = 'production';
  try { assert.equal(getPreviewSessionState(), null, 'a production build ignores even an existing development cache'); }
  finally { env.NODE_ENV = 'development'; }
  (cache.state as unknown as Record<string, unknown>).status = 'invalid';
  assert.equal(getPreviewSessionState(), null, 'invalid memory is ignored without falling back to storage');
  assert.equal(browser.sessionStorage.reads, reads);
  detach();
}));

test('preview snapshots preserve valid hazards and reject malformed hazard lists', () => {
  const valid = createInitialData('playing');
  valid.hazards = [{ id: 'ember-1', x: 12, z: 22, age: 0.4, duration: 1.8, radius: 1.2, ownerId: 'boss' }];
  environment((browser) => {
    browser.sessionStorage.values.set(STORAGE_KEY, JSON.stringify({ version: 1, state: valid }));
    const store = makeStore();
    const detach = attachPreviewSession(store);
    assert.deepEqual(store.getState().hazards, valid.hazards);
    assert.deepEqual(getPreviewSessionState()!.hazards, valid.hazards);
    detach();
  });
  for (const hazards of [null, [null], [{ ...valid.hazards[0], age: -1 }], [{ ...valid.hazards[0], radius: -1 }], [{ ...valid.hazards[0], duration: 'long' }], [{ ...valid.hazards[0], ownerId: null }]]) {
    environment((browser) => {
      browser.sessionStorage.values.set(STORAGE_KEY, JSON.stringify({ version: 1, state: { ...valid, hazards } }));
      const store = makeStore();
      const fresh = store.getState();
      const detach = attachPreviewSession(store);
      assert.equal(store.getState(), fresh);
      detach();
    });
  }
});

test('a module replacement retains exact live state even when browser storage is blocked', () => environment((browser) => {
  browser.sessionStorage.unavailable = true;
  const first = makeStore();
  const detachFirst = attachPreviewSession(first);
  first.setState(state => ({ status: 'playing', player: { ...state.player, x: 18 }, quest: { ...state.quest, key: true } }));
  const replacement = makeStore();
  const freshStart = replacement.getState().start;
  const detachReplacement = attachPreviewSession(replacement);
  assert.equal(replacement.getState().player, first.getState().player, 'HMR preserves the current immutable player snapshot');
  assert.equal(replacement.getState().quest, first.getState().quest);
  assert.equal(replacement.getState().start, freshStart);
  replacement.setState({ rupees: 41 });
  detachFirst();
  const third = makeStore();
  const detachThird = attachPreviewSession(third);
  assert.equal(third.getState().rupees, 41, 'an outgoing effect cannot overwrite the replacement run');
  detachReplacement();
  detachThird();
}));

test('remounting the same store does not replay an old snapshot over a new adventure', () => environment(() => {
  const store = makeStore();
  let detach = attachPreviewSession(store);
  store.setState({ status: 'playing', rupees: 20 });
  detach();
  store.setState(createInitialData());
  const current = store.getState();
  detach = attachPreviewSession(store);
  assert.equal(store.getState(), current, 'each store is restored only once');
  assert.equal(store.getState().status, 'title');
  assert.equal(store.getState().rupees, 0);
  detach();
}));

test('preview writes are throttled and flush immediately on travel, status, visibility, and page exit', () => environment((browser, document) => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const store = makeStore();
    const detach = attachPreviewSession(store);
    assert.equal(browser.sessionStorage.writes, 1);
    for (let frame = 0; frame < 60; frame++) store.setState(state => ({ player: { ...state.player, x: state.player.x + 0.01 } }));
    assert.equal(browser.sessionStorage.writes, 1, 'simulation ticks do not serialize every frame');
    now += 1100;
    store.setState({ rupees: 1 });
    assert.equal(browser.sessionStorage.writes, 2);
    store.setState({ status: 'playing' });
    assert.equal(browser.sessionStorage.writes, 3);
    store.setState({ zone: 'dungeon' });
    assert.equal(browser.sessionStorage.writes, 4);
    store.setState({ rupees: 2 });
    document.dispatch('visibilitychange');
    assert.equal(browser.sessionStorage.writes, 5);
    assert.equal(browser.sessionStorage.saved().rupees, 2);
    store.setState({ rupees: 3 });
    browser.dispatch('pagehide');
    assert.equal(browser.sessionStorage.writes, 6);
    assert.equal(browser.sessionStorage.saved().rupees, 3);
    detach();
    assert.equal(browser.sessionStorage.writes, 7);
    assert.equal(browser.listenerCount, 0);
    assert.equal(document.listenerCount, 0);
    store.setState({ rupees: 4 });
    browser.dispatch('pagehide');
    document.dispatch('visibilitychange');
    detach();
    assert.equal(browser.sessionStorage.writes, 7, 'cleanup detaches its subscription and listeners exactly once');
  } finally { Date.now = originalNow; }
}));

test('corrupt or unavailable preview storage leaves a fresh playable game', () => {
  const valid = createInitialData('playing');
  for (const text of ['{', JSON.stringify({ version: 2, state: valid }), JSON.stringify({ version: 1, state: { ...valid, player: null } }),
    JSON.stringify({ version: 1, state: { ...valid, enemies: [null] } }), JSON.stringify({ version: 1, state: { ...valid, quest: { ...valid.quest, key: 'yes' } } })]) {
    environment((browser) => {
      browser.sessionStorage.values.set(STORAGE_KEY, text);
      const store = makeStore();
      const fresh = store.getState();
      const detach = attachPreviewSession(store);
      assert.equal(store.getState(), fresh);
      store.getState().start();
      assert.equal(store.getState().status, 'playing');
      detach();
    });
  }
  environment((browser, document) => {
    browser.sessionStorage.unavailable = true;
    const store = makeStore();
    assert.doesNotThrow(() => {
      const detach = attachPreviewSession(store);
      store.getState().start();
      document.dispatch('visibilitychange');
      browser.dispatch('pagehide');
      detach();
    });
    assert.equal(store.getState().status, 'playing');
  });
});

test('published games and server rendering never read or write preview sessions', () => {
  environment((browser, document) => {
    const store = makeStore();
    const detach = attachPreviewSession(store);
    assert.equal(getPreviewSessionState(), null);
    store.getState().start();
    browser.dispatch('pagehide');
    document.dispatch('visibilitychange');
    detach();
    assert.equal(browser.sessionStorage.reads, 0);
    assert.equal(browser.sessionStorage.writes, 0);
    assert.equal(browser.listenerCount, 0);
    assert.equal(document.listenerCount, 0);
  }, 'production');
  environment(() => {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    const store = makeStore();
    const before = store.getState();
    assert.doesNotThrow(() => attachPreviewSession(store)());
    assert.equal(getPreviewSessionState(), null);
    assert.equal(store.getState(), before);
  });
});
