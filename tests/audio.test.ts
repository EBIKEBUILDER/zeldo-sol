import assert from 'node:assert/strict';
import test from 'node:test';
import { playSound, setAudioMuted, setMusicTrack, unlockAudio } from '../game/audio';

test('audio may be imported and called during server rendering without a browser', () => {
  assert.equal(typeof window, 'undefined');
  assert.doesNotThrow(() => {
    unlockAudio();
    setAudioMuted(true);
    setAudioMuted(false);
    for (const track of ['overworld', 'dungeon', 'boss', null] as const) setMusicTrack(track);
    for (const sound of ['swing', 'hit', 'death', 'rupee', 'hurt', 'key', 'gate', 'chest', 'warning', 'fire', 'blast'] as const) playSound(sound);
  });
});
