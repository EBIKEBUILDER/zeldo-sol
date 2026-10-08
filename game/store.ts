import { create } from 'zustand';
import { playSound, setAudioMuted, unlockAudio } from './audio';
import { createInitialData, stepGame, type AdventureData } from './simulation';
import type { GameActions } from './types';

export type AdventureStore = AdventureData & GameActions;

export const useGameStore = create<AdventureStore>((set, get) => ({
  ...createInitialData(),
  start: () => {
    unlockAudio();
    const muted = get().muted;
    setAudioMuted(muted);
    set(createInitialData('playing', muted));
  },
  togglePause: () => {
    const status = get().status;
    if (status === 'playing') set({ status: 'paused' });
    else if (status === 'paused') set({ status: 'playing' });
  },
  toggleMute: () => {
    const muted = !get().muted;
    setAudioMuted(muted);
    set({ muted });
  },
  tick: (dt, input) => {
    const result = stepGame(get(), dt, input);
    if (result.data !== get()) set(result.data);
    for (const sound of result.sounds) playSound(sound);
  },
}));
