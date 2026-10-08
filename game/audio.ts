export type SoundName = 'swing' | 'hit' | 'death' | 'rupee' | 'hurt' | 'key' | 'gate' | 'chest' | 'warning' | 'fire';

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = false;

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
    }
    if (context.state !== 'running') void context.resume().catch(() => {});
  } catch {
    // An unavailable audio device must never prevent a game from starting.
  }
}

export function setAudioMuted(value: boolean): void {
  muted = value;
  if (!context || !master) return;
  try {
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setTargetAtTime(value ? 0 : 0.36, context.currentTime, 0.012);
  } catch {}
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
