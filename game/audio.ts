import { MUSIC_SCORES, type MusicNote, type MusicTrack } from './music';

export type SoundName = 'swing' | 'hit' | 'death' | 'rupee' | 'hurt' | 'key' | 'gate' | 'chest' | 'warning' | 'fire' | 'blast';

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = false;
let requestedMusic: MusicTrack | null = null;
let musicTimer: ReturnType<typeof setInterval> | null = null;
type MusicPlayback = {
  track: MusicTrack;
  bus: GainNode;
  sources: Set<AudioScheduledSourceNode>;
  step: number;
  nextTime: number;
  retired: boolean;
};
let music: MusicPlayback | null = null;

/** Call from a keyboard or pointer gesture; importing this module is SSR-safe. */
export function unlockAudio(): void {
  if (typeof window === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.userActivation && !navigator.userActivation.isActive) return;
  try {
    if (!context) {
      const Constructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) return;
      context = new Constructor();
      master = context.createGain();
      master.gain.value = muted ? 0 : 0.36;
      master.connect(context.destination);
      noiseBuffer = context.createBuffer(1, context.sampleRate / 2, context.sampleRate);
      const samples = noiseBuffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      context.onstatechange = syncMusicPlayback;
    }
    if (context.state !== 'running') void context.resume().then(syncMusicPlayback).catch(() => {});
    else syncMusicPlayback();
  } catch {
    // An unavailable audio device must never prevent a game from starting.
  }
}

export function setAudioMuted(value: boolean): void {
  muted = value;
  syncMusicPlayback();
  if (!context || !master) return;
  try {
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setTargetAtTime(value ? 0 : 0.36, context.currentTime, 0.012);
  } catch {}
}

/** Select a theme freely; sound still starts only after unlockAudio's user gesture. */
export function setMusicTrack(track: MusicTrack | null): void {
  requestedMusic = track;
  syncMusicPlayback();
}

function retireMusic(): void {
  if (musicTimer !== null) clearInterval(musicTimer);
  musicTimer = null;
  const previous = music;
  music = null;
  if (!previous || !context) return;
  previous.retired = true;
  const now = context.currentTime;
  try {
    previous.bus.gain.cancelScheduledValues(now);
    previous.bus.gain.setTargetAtTime(0, now, .06);
  } catch {}
  // Limit the tail, including notes already queued by the lookahead scheduler.
  for (const source of previous.sources) {
    try { source.stop(now + .3); } catch {}
  }
  if (!previous.sources.size) previous.bus.disconnect();
}

function syncMusicPlayback(): void {
  if (!context || !master || context.state !== 'running' || muted || !requestedMusic) {
    retireMusic();
    return;
  }
  if (music?.track === requestedMusic) return;
  try {
    retireMusic();
    const bus = context.createGain();
    bus.gain.setValueAtTime(0, context.currentTime);
    bus.gain.linearRampToValueAtTime(.8, context.currentTime + .45);
    bus.connect(master);
    music = { track: requestedMusic, bus, sources: new Set(), step: 0, nextTime: context.currentTime + .03, retired: false };
    scheduleMusic();
    musicTimer = setInterval(scheduleMusic, 40);
  } catch {
    retireMusic();
  }
}

function connectMusicSource(playback: MusicPlayback, source: AudioScheduledSourceNode, envelope: GainNode, filter?: BiquadFilterNode): void {
  playback.sources.add(source);
  if (filter) { source.connect(filter); filter.connect(envelope); }
  else source.connect(envelope);
  envelope.connect(playback.bus);
  source.onended = () => {
    source.disconnect();
    filter?.disconnect();
    envelope.disconnect();
    playback.sources.delete(source);
    if (playback.retired && !playback.sources.size) playback.bus.disconnect();
  };
}

function musicTone(playback: MusicPlayback, frequency: number, start: number, length: number, volume: number, voice: MusicNote['voice'], overtone = false): void {
  if (!context) return;
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  const filter = context.createBiquadFilter();
  oscillator.type = overtone || voice === 'pad' ? 'sine' : playback.track === 'boss' && voice === 'bass' ? 'sawtooth' : 'triangle';
  oscillator.frequency.setValueAtTime(frequency, start);
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(voice === 'bass' ? 650 : voice === 'pluck' ? 2200 : 3200, start);
  const attack = voice === 'pad' ? Math.min(.22, length / 3) : .012;
  const release = voice === 'pad' ? .3 : voice === 'pluck' ? .06 : .10;
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(volume, start + attack);
  envelope.gain.exponentialRampToValueAtTime(Math.max(.0001, volume * (voice === 'pluck' ? .12 : .65)), start + Math.max(attack + .001, length * .8));
  envelope.gain.exponentialRampToValueAtTime(.0001, start + length + release);
  connectMusicSource(playback, oscillator, envelope, filter);
  oscillator.start(start);
  oscillator.stop(start + length + release + .02);
}

function musicDrum(playback: MusicPlayback, kind: 'kick' | 'snare' | 'hat', start: number, volume: number): void {
  if (!context || !noiseBuffer) return;
  const envelope = context.createGain();
  const length = kind === 'kick' ? .18 : kind === 'snare' ? .12 : .045;
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(volume, start + .004);
  envelope.gain.exponentialRampToValueAtTime(.0001, start + length);
  if (kind === 'kick') {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(140, start);
    oscillator.frequency.exponentialRampToValueAtTime(42, start + length);
    connectMusicSource(playback, oscillator, envelope);
    oscillator.start(start);
    oscillator.stop(start + length + .02);
  } else {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    source.buffer = noiseBuffer;
    filter.type = kind === 'hat' ? 'highpass' : 'bandpass';
    filter.frequency.setValueAtTime(kind === 'hat' ? 6500 : 1800, start);
    filter.Q.value = .7;
    connectMusicSource(playback, source, envelope, filter);
    source.start(start);
    source.stop(start + length + .02);
  }
}

function scheduleMusic(): void {
  if (!context || !music || muted || context.state !== 'running') {
    retireMusic();
    return;
  }
  try {
    const playback = music;
    const score = MUSIC_SCORES[playback.track];
    const stepLength = 60 / score.bpm / 4;
    const now = context.currentTime;
    // A delayed timer resumes from now; it never dumps overdue notes in a burst.
    if (playback.nextTime < now) playback.nextTime = now + .015;
    while (playback.nextTime < now + .15) {
      for (const note of score.notes) {
        if (note.step !== playback.step) continue;
        const frequency = 440 * 2 ** ((note.midi - 69) / 12);
        musicTone(playback, frequency, playback.nextTime, note.length * stepLength, note.volume, note.voice);
        if (note.voice === 'lead') musicTone(playback, frequency * 2, playback.nextTime, note.length * stepLength, note.volume * .15, note.voice, true);
      }
      for (const drum of score.percussion) {
        if (drum.step === playback.step) musicDrum(playback, drum.kind, playback.nextTime, drum.volume);
      }
      playback.step = (playback.step + 1) % score.steps;
      playback.nextTime += stepLength;
    }
  } catch {
    retireMusic();
  }
}

function tone(frequency: number, length: number, volume: number, delay = 0, type: OscillatorType = 'triangle', endFrequency = frequency): void {
  if (!context || !master) return;
  const start = context.currentTime + delay;
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + length);
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(volume, start + Math.min(0.008, length / 3));
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(envelope);
  envelope.connect(master);
  oscillator.start(start);
  oscillator.stop(start + length + 0.025);
  oscillator.onended = () => {
    oscillator.disconnect();
    envelope.disconnect();
  };
}

function noise(length: number, volume: number, cutoff: number, delay = 0): void {
  if (!context || !master || !noiseBuffer) return;
  const start = context.currentTime + delay;
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const envelope = context.createGain();
  source.buffer = noiseBuffer;
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(cutoff, start);
  filter.frequency.exponentialRampToValueAtTime(Math.max(120, cutoff / 5), start + length);
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(volume, start + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + length);
  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(master);
  source.start(start);
  source.stop(start + length + 0.025);
  source.onended = () => {
    source.disconnect();
    filter.disconnect();
    envelope.disconnect();
  };
}

/** Small handmade timbres: all sounds are synthesized, with no fetched assets. */
export function playSound(name: SoundName): void {
  if (muted || !context || context.state !== 'running') return;
  try {
    switch (name) {
      case 'blast':
        noise(.32, .20, 2200);
        tone(125, .28, .18, 0, 'sine', 32);
        break;
      case 'warning':
        tone(180, 0.5, 0.18, 0, 'triangle', 720);
        tone(360, 0.43, 0.07, 0.06, 'sine', 1080);
        break;
      case 'fire':
        noise(0.23, 0.16, 3800);
        tone(540, 0.18, 0.17, 0, 'sawtooth', 140);
        break;
      case 'swing':
        noise(0.13, 0.15, 5000);
        tone(650, 0.11, 0.08, 0, 'triangle', 170);
        break;
      case 'hit':
        noise(0.085, 0.22, 2800);
        tone(230, 0.09, 0.2, 0, 'square', 65);
        tone(940, 0.045, 0.055);
        break;
      case 'death':
        noise(0.22, 0.13, 1900);
        tone(400, 0.24, 0.15, 0, 'triangle', 55);
        tone(190, 0.19, 0.09, 0.06, 'square', 40);
        break;
      case 'rupee':
        tone(1046.5, 0.1, 0.16);
        tone(1568, 0.17, 0.13, 0.075);
        tone(2093, 0.14, 0.06, 0.13, 'sine');
        break;
      case 'hurt':
        tone(180, 0.22, 0.22, 0, 'sawtooth', 70);
        tone(117, 0.2, 0.11, 0.04, 'square', 50);
        noise(0.12, 0.11, 1500);
        break;
      case 'key':
        [523.25, 659.25, 783.99, 1046.5].forEach((note, index) => {
          tone(note, 0.27, 0.13, index * 0.1);
          tone(note * 2, 0.19, 0.025, index * 0.1, 'sine');
        });
        break;
      case 'gate':
        noise(0.43, 0.19, 800);
        tone(55, 0.43, 0.25, 0, 'sawtooth', 85);
        tone(82.4, 0.21, 0.1, 0.23, 'triangle', 164.8);
        noise(0.12, 0.22, 1500, 0.34);
        break;
      case 'chest':
        [392, 523.25, 659.25, 783.99, 1046.5].forEach((note, index) => {
          tone(note, index === 4 ? 0.9 : 0.3, 0.16, index * 0.13);
          tone(note / 2, index === 4 ? 0.8 : 0.22, 0.065, index * 0.13, 'sine');
        });
        tone(659.25, 0.8, 0.08, 0.52);
        tone(783.99, 0.8, 0.08, 0.52);
        break;
    }
  } catch {
    // Browsers can close audio devices while a tab is suspended.
  }
}
