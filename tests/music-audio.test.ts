import assert from 'node:assert/strict';
import test from 'node:test';
import * as audio from '../game/audio';

type Automation = { method: string; value?: number; time: number };

class FakeAudioParam {
  value = 0;
  automation: Automation[] = [];

  private schedule(method: string, value: number, time: number): this {
    assert.ok(Number.isFinite(value), `${method} received a finite value`);
    assert.ok(Number.isFinite(time), `${method} received a finite time`);
    this.automation.push({ method, value, time });
    return this;
  }

  setValueAtTime(value: number, time: number): this { return this.schedule('set', value, time); }
  linearRampToValueAtTime(value: number, time: number): this { return this.schedule('linear', value, time); }
  exponentialRampToValueAtTime(value: number, time: number): this { return this.schedule('exponential', value, time); }
  setTargetAtTime(value: number, time: number, constant: number): this {
    assert.ok(Number.isFinite(constant) && constant > 0);
    return this.schedule('target', value, time);
  }
  cancelScheduledValues(time: number): this {
    assert.ok(Number.isFinite(time));
    this.automation.push({ method: 'cancel', time });
    return this;
  }
}

class FakeAudioNode {
  connections: FakeAudioNode[] = [];
  disconnected = false;
  connect(destination: FakeAudioNode): FakeAudioNode {
    this.connections.push(destination);
    return destination;
  }
  disconnect(): void { this.disconnected = true; }
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeFilterNode extends FakeAudioNode {
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
  type = 'lowpass';
}

class FakeSourceNode extends FakeAudioNode {
  frequency = new FakeAudioParam();
  detune = new FakeAudioParam();
  playbackRate = new FakeAudioParam();
  type = 'sine';
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startTime: number | null = null;
  stopTimes: number[] = [];
  ended = false;

  start(time = 0): void {
    assert.ok(Number.isFinite(time));
    assert.equal(this.startTime, null, 'each synthesized voice starts once');
    this.startTime = time;
  }
  stop(time = 0): void {
    assert.ok(Number.isFinite(time));
    this.stopTimes.push(time);
  }
  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.onended?.();
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = 'running';
  currentTime = 10;
  sampleRate = 44100;
  destination = new FakeAudioNode();
  onstatechange: (() => void) | null = null;
  gains: FakeGainNode[] = [];
  filters: FakeFilterNode[] = [];
  sources: FakeSourceNode[] = [];

  constructor() { FakeAudioContext.instances.push(this); }
  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }
  createOscillator(): FakeSourceNode { return this.createBufferSource(); }
  createBufferSource(): FakeSourceNode {
    const node = new FakeSourceNode();
    this.sources.push(node);
    return node;
  }
  createBiquadFilter(): FakeFilterNode {
    const node = new FakeFilterNode();
    this.filters.push(node);
    return node;
  }
  createBuffer(_channels: number, length: number): { getChannelData: () => Float32Array } {
    return { getChannelData: () => new Float32Array(length) };
  }
  async resume(): Promise<void> { this.changeState('running'); }
  changeState(state: string): void {
    this.state = state;
    this.onstatechange?.();
  }
}

test('synthesized music unlocks on a gesture and manages one scheduler across tracks, mute, and suspension', async () => {
  const replacedGlobals = ['window', 'navigator', 'setInterval', 'clearInterval'] as const;
  const descriptors = new Map(replacedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const intervals = new Map<number, () => void>();
  let nextInterval = 1;
  const activation = { isActive: false };
  const setInterval = (callback: () => void): number => {
    const id = nextInterval++;
    intervals.set(id, callback);
    return id;
  };
  const clearInterval = (id: number): void => { intervals.delete(id); };
  const install = (name: string, value: unknown): void => {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  FakeAudioContext.instances = [];
  install('window', { AudioContext: FakeAudioContext, setInterval, clearInterval });
  install('navigator', { userActivation: activation });
  install('setInterval', setInterval);
  install('clearInterval', clearInterval);
  try {
    audio.setMusicTrack('overworld');
    assert.equal(FakeAudioContext.instances.length, 0, 'requesting a track does not bypass browser autoplay rules');
    assert.equal(intervals.size, 0);
    audio.unlockAudio();
    assert.equal(FakeAudioContext.instances.length, 0, 'a call without active user input stays silent');

    activation.isActive = true;
    audio.unlockAudio();
    await Promise.resolve();
    const context = FakeAudioContext.instances[0];
    assert.ok(context, 'a user gesture creates an audio context');
    assert.equal(intervals.size, 1, 'unlocking starts the requested music');
    assert.ok(context.sources.length > 0, 'the overworld has audible synthesized voices');
    const initialSourceCount = context.sources.length;
    const initialTimer = [...intervals.keys()][0];
    for (let i = 0; i < 100; i++) audio.setMusicTrack('overworld');
    audio.unlockAudio();
    await Promise.resolve();
    assert.equal(FakeAudioContext.instances.length, 1);
    assert.equal(intervals.size, 1);
    assert.equal([...intervals.keys()][0], initialTimer, 'syncing an unchanged track preserves its scheduler');
    assert.equal(context.sources.length, initialSourceCount, 'syncing a track does not stack voices');
    for (const source of context.sources) {
      assert.ok(source.startTime !== null && Number.isFinite(source.startTime));
      assert.ok(source.stopTimes.some((time) => time > source.startTime!), 'every voice has a scheduled end');
    }

    for (let tick = 0; tick < 20; tick++) {
      context.currentTime += 0.1;
      for (const callback of intervals.values()) callback();
    }
    assert.ok(context.sources.length > initialSourceCount, 'the scheduler keeps the composition playing');

    const beforeStall = context.sources.length;
    context.currentTime += 1000;
    for (const callback of intervals.values()) callback();
    const afterStall = context.sources.slice(beforeStall);
    assert.ok(afterStall.length < initialSourceCount * 100, 'a suspended tab does not replay thousands of missed notes');
    for (const source of afterStall) {
      assert.ok(source.startTime! >= context.currentTime - 0.1, 'resumed notes are scheduled near the current audio clock');
      assert.ok(source.startTime! <= context.currentTime + 2, 'only a bounded horizon of notes is scheduled');
    }

    const master = context.gains[0];
    const oldBus = context.gains.find((node) => node.connections.includes(master));
    assert.ok(oldBus, 'music has its own gain bus');
    const oldAutomationCount = oldBus.gain.automation.length;
    const beforeDungeon = context.sources.length;
    audio.setMusicTrack('dungeon');
    assert.equal(intervals.size, 1, 'a location transition retains one active scheduler');
    assert.ok(context.sources.length > beforeDungeon, 'the dungeon transition starts a new arrangement');
    assert.ok(oldBus.gain.automation.slice(oldAutomationCount).some((event) => event.value === 0), 'the previous arrangement fades out');
    assert.ok(context.gains.filter((node) => node.connections.includes(master)).length >= 2, 'the new arrangement has a separate fading gain bus');

    const beforeBoss = context.sources.length;
    audio.setMusicTrack('boss');
    assert.equal(intervals.size, 1);
    assert.ok(context.sources.length > beforeBoss, 'the boss encounter starts its own arrangement');
    audio.setAudioMuted(true);
    assert.equal(intervals.size, 0, 'mute stops music scheduling');
    const mutedSourceCount = context.sources.length;
    audio.setMusicTrack('dungeon');
    audio.unlockAudio();
    await Promise.resolve();
    assert.equal(context.sources.length, mutedSourceCount, 'track updates and gestures stay silent while muted');
    assert.equal(intervals.size, 0);
    audio.setAudioMuted(false);
    assert.equal(intervals.size, 1, 'unmute resumes the currently requested track');
    assert.ok(context.sources.length > mutedSourceCount);

    context.changeState('suspended');
    assert.equal(intervals.size, 0, 'an audio-device suspension stops background scheduling');
    const suspendedSourceCount = context.sources.length;
    audio.setMusicTrack('overworld');
    assert.equal(context.sources.length, suspendedSourceCount);
    context.changeState('running');
    assert.equal(intervals.size, 1, 'a running audio device resumes the desired track');
    assert.ok(context.sources.length > suspendedSourceCount);

    audio.setMusicTrack(null);
    assert.equal(intervals.size, 0, 'paused or stopped gameplay leaves no active scheduler');
    const stoppedSourceCount = context.sources.length;
    audio.setAudioMuted(true);
    audio.setAudioMuted(false);
    audio.unlockAudio();
    await Promise.resolve();
    assert.equal(context.sources.length, stoppedSourceCount, 'unmuting and gestures do not restart cleared music');
    assert.equal(intervals.size, 0);
    for (const source of context.sources) {
      assert.ok(source.stopTimes.length > 0);
      source.finish();
      assert.ok(source.disconnected, 'ended music voices disconnect from the audio graph');
    }
    assert.ok(context.gains.slice(1).every((node) => node.disconnected), 'voice envelopes and retired music buses are released');
    assert.ok(context.filters.every((node) => node.disconnected), 'ended percussion filters are released');
  } finally {
    audio.setMusicTrack(null);
    for (const name of replacedGlobals) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
