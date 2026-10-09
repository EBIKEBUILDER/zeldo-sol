import type { GameData } from './types';

export type MusicTrack = 'overworld' | 'dungeon' | 'boss';
export type MusicVoice = 'lead' | 'pluck' | 'pad' | 'bass';

/** Score timing is in sixteenth notes, so a four-beat bar spans 16 steps. */
export interface MusicNote {
  step: number;
  midi: number;
  length: number;
  volume: number;
  voice: MusicVoice;
}

export interface MusicScore {
  bpm: number;
  steps: number;
  notes: readonly MusicNote[];
  percussion: readonly { step: number; kind: 'kick' | 'snare' | 'hat'; volume: number }[];
}

type Phrase = readonly (readonly [step: number, midi: number, length: number])[];
type Chord = readonly [number, number, number];
const LOOP_STEPS = 128;

function addPhrase(notes: MusicNote[], bar: number, phrase: Phrase, voice: MusicVoice, volume: number): void {
  for (const [step, midi, length] of phrase) notes.push({ step: bar * 16 + step, midi, length, voice, volume });
}

function addChord(notes: MusicNote[], bar: number, chord: Chord, volume: number): void {
  for (const midi of chord) notes.push({ step: bar * 16, midi, length: 15, voice: 'pad', volume });
}

function finishScore(bpm: number, notes: MusicNote[], percussion: MusicScore['percussion'] = []): MusicScore {
  return {
    bpm,
    steps: LOOP_STEPS,
    notes: notes.sort((a, b) => a.step - b.step),
    percussion: [...percussion].sort((a, b) => a.step - b.step),
  };
}

function overworldScore(): MusicScore {
  const notes: MusicNote[] = [];
  // C – G – Am – F, then a answering phrase that leads G back to C.
  const chords: readonly Chord[] = [
    [60, 64, 67], [59, 62, 67], [60, 64, 69], [60, 65, 69],
    [60, 64, 67], [59, 62, 67], [60, 65, 69], [59, 62, 67],
  ];
  const roots = [36, 43, 45, 41, 36, 43, 41, 43];
  const melody: readonly Phrase[] = [
    [[0, 76, 3], [4, 79, 3], [8, 81, 2], [10, 79, 2], [12, 76, 3]],
    [[0, 74, 3], [4, 76, 2], [6, 79, 2], [8, 74, 6]],
    [[0, 76, 3], [4, 81, 3], [8, 84, 3], [12, 81, 3]],
    [[0, 79, 3], [4, 76, 3], [8, 74, 2], [10, 72, 5]],
    [[0, 76, 2], [2, 79, 2], [4, 84, 3], [8, 81, 3], [12, 79, 3]],
    [[0, 74, 3], [4, 79, 3], [8, 81, 2], [10, 79, 2], [12, 76, 3]],
    [[0, 76, 3], [4, 74, 3], [8, 72, 6]],
    [[0, 74, 3], [4, 76, 3], [8, 74, 2], [10, 79, 5]],
  ];
  for (let bar = 0; bar < chords.length; bar++) {
    const chord = chords[bar];
    addChord(notes, bar, chord, 0.03);
    addPhrase(notes, bar, [[0, roots[bar], 6], [8, roots[bar] + 7, 5]], 'bass', 0.1);
    addPhrase(notes, bar, melody[bar], 'lead', 0.13);
    for (let index = 0; index < 8; index++) {
      const chordTone = [0, 1, 2, 1][index % 4];
      notes.push({ step: bar * 16 + index * 2, midi: chord[chordTone], length: 1, voice: 'pluck', volume: index % 4 === 0 ? 0.065 : 0.05 });
    }
  }
  return finishScore(104, notes);
}

function dungeonScore(): MusicScore {
  const notes: MusicNote[] = [];
  // D minor, with the raised seventh in the A chord pulling each half home.
  const chords: readonly Chord[] = [
    [50, 57, 65], [53, 58, 62], [50, 55, 62], [52, 57, 61],
    [50, 57, 65], [53, 60, 65], [53, 58, 62], [52, 57, 61],
  ];
  const roots = [38, 34, 31, 33, 38, 41, 34, 33];
  const melody: readonly Phrase[] = [
    [[2, 74, 5], [10, 77, 4]],
    [[4, 81, 5], [12, 77, 3]],
    [[2, 79, 6], [12, 74, 3]],
    [[4, 73, 8]],
    [[2, 74, 5], [10, 81, 4]],
    [[4, 84, 5], [12, 81, 3]],
    [[2, 77, 5], [10, 74, 4]],
    [[0, 76, 4], [6, 73, 7]],
  ];
  for (let bar = 0; bar < chords.length; bar++) {
    addChord(notes, bar, chords[bar], 0.035);
    addPhrase(notes, bar, [[0, roots[bar], 12]], 'bass', 0.085);
    addPhrase(notes, bar, melody[bar], 'lead', 0.105);
    addPhrase(notes, bar, [[0, chords[bar][0] + 12, 2], [6, chords[bar][1] + 12, 2], [10, chords[bar][2] + 12, 2]], 'pluck', 0.055);
  }
  return finishScore(72, notes);
}

function bossScore(): MusicScore {
  const notes: MusicNote[] = [];
  const percussion: { step: number; kind: 'kick' | 'snare' | 'hat'; volume: number }[] = [];
  const chords: readonly Chord[] = [
    [50, 53, 57], [50, 53, 58], [50, 55, 58], [49, 52, 57],
    [50, 53, 57], [50, 53, 58], [50, 55, 58], [49, 52, 57],
  ];
  const roots = [38, 34, 31, 33, 38, 34, 31, 33];
  const melody: readonly Phrase[] = [
    [[0, 74, 2], [2, 77, 2], [4, 81, 3], [8, 79, 2], [10, 77, 2], [12, 76, 2], [14, 74, 2]],
    [[0, 77, 3], [4, 82, 3], [8, 81, 2], [10, 77, 2], [12, 74, 3]],
    [[0, 79, 3], [4, 82, 3], [8, 86, 3], [12, 82, 2], [14, 79, 2]],
    [[0, 81, 3], [4, 76, 3], [8, 73, 3], [12, 76, 3]],
    [[0, 86, 2], [2, 81, 2], [4, 77, 3], [8, 81, 2], [10, 79, 2], [12, 77, 2], [14, 74, 2]],
    [[0, 82, 3], [4, 81, 2], [6, 77, 2], [8, 74, 3], [12, 77, 3]],
    [[0, 79, 2], [2, 82, 2], [4, 86, 3], [8, 84, 2], [10, 82, 2], [12, 79, 3]],
    [[0, 81, 3], [4, 76, 2], [6, 73, 2], [8, 69, 3], [12, 73, 3]],
  ];
  for (let bar = 0; bar < chords.length; bar++) {
    addChord(notes, bar, chords[bar], 0.03);
    addPhrase(notes, bar, melody[bar], 'lead', 0.12);
    for (let index = 0; index < 8; index++) {
      const offset = index * 2;
      const bassInterval = index === 3 || index === 7 ? 7 : index % 2 === 1 ? 12 : 0;
      notes.push({ step: bar * 16 + offset, midi: roots[bar] + bassInterval, length: 1, voice: 'bass', volume: index % 4 === 0 ? 0.14 : 0.1 });
      notes.push({ step: bar * 16 + offset + 1, midi: chords[bar][index % 3] + 12, length: 1, voice: 'pluck', volume: 0.05 });
      percussion.push({ step: bar * 16 + offset, kind: 'hat', volume: index % 2 === 0 ? 0.04 : 0.03 });
    }
    for (const offset of [0, 6, 8, 10]) percussion.push({ step: bar * 16 + offset, kind: 'kick', volume: 0.15 });
    for (const offset of [4, 12]) percussion.push({ step: bar * 16 + offset, kind: 'snare', volume: 0.09 });
  }
  return finishScore(140, notes, percussion);
}

/** Original eight-bar themes generated locally; playback never needs audio files. */
export const MUSIC_SCORES: Record<MusicTrack, MusicScore> = {
  overworld: overworldScore(),
  dungeon: dungeonScore(),
  boss: bossScore(),
};

/** A gate opening sets the scene; the battle theme waits for the boss to engage. */
export function getMusicTrack(state: Pick<GameData, 'status' | 'zone' | 'quest' | 'enemies'>, blocked = false): MusicTrack | null {
  if (state.status !== 'playing' || blocked) return null;
  if (state.zone === 'overworld') return 'overworld';
  if (state.quest.gate && !state.quest.boss && state.enemies.some(enemy => enemy.boss && enemy.alive && enemy.hp > 0 && enemy.navigation.chasing)) return 'boss';
  return 'dungeon';
}
