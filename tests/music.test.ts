import assert from 'node:assert/strict';
import test from 'node:test';
import { getMusicTrack, MUSIC_SCORES, type MusicTrack } from '../game/music';
import { createInitialData } from '../game/simulation';
import { createEnemies } from '../game/world';

function dungeon() {
  const state = createInitialData('playing');
  state.zone = 'dungeon';
  state.enemies = createEnemies('dungeon');
  return state;
}

test('music starts with the adventure and follows travel between the overworld and dungeon', () => {
  const state = createInitialData();
  assert.equal(getMusicTrack(state), null);
  state.status = 'playing';
  assert.equal(getMusicTrack(state), 'overworld');
  state.zone = 'dungeon';
  assert.equal(getMusicTrack(state), 'dungeon');
  state.zone = 'overworld';
  assert.equal(getMusicTrack(state), 'overworld');
});

test('pausing, hiding or leaving the active adventure silences every theme', () => {
  const state = dungeon();
  state.quest.gate = true;
  const boss = state.enemies.find(enemy => enemy.boss)!;
  boss.navigation.chasing = true;
  assert.equal(getMusicTrack(state), 'boss');
  assert.equal(getMusicTrack(state, true), null);
  assert.equal(getMusicTrack(state, false), 'boss');
  for (const status of ['title', 'paused', 'gameover', 'victory'] as const) {
    state.status = status;
    assert.equal(getMusicTrack(state), null, status);
  }
  state.status = 'playing';
  assert.equal(getMusicTrack(state), 'boss');
});

test('the boss theme begins on engagement and returns to the dungeon theme on defeat', () => {
  const state = dungeon();
  const boss = state.enemies.find(enemy => enemy.boss)!;
  assert.equal(getMusicTrack(state), 'dungeon');
  state.quest.gate = true;
  assert.equal(getMusicTrack(state), 'dungeon', 'Opening the gate alone must not start the fight music');
  boss.navigation.chasing = true;
  assert.equal(getMusicTrack(state), 'boss');
  boss.hp = 0;
  assert.equal(getMusicTrack(state), 'dungeon');
  boss.hp = boss.maxHp;
  boss.alive = false;
  assert.equal(getMusicTrack(state), 'dungeon');
  boss.alive = true;
  state.quest.boss = true;
  assert.equal(getMusicTrack(state), 'dungeon');
  state.quest.boss = false;
  state.zone = 'overworld';
  assert.equal(getMusicTrack(state), 'overworld', 'The overworld theme takes precedence outside the dungeon');
});

test('unopened gates and ordinary chasing enemies keep the dungeon theme', () => {
  const state = dungeon();
  state.enemies.find(enemy => enemy.boss)!.navigation.chasing = true;
  assert.equal(getMusicTrack(state), 'dungeon');
  state.quest.gate = true;
  state.enemies = state.enemies.filter(enemy => !enemy.boss);
  for (const enemy of state.enemies) enemy.navigation.chasing = true;
  assert.equal(getMusicTrack(state), 'dungeon');
});

test('all scores contain playable notes within one eight-bar loop at restrained levels', () => {
  for (const [track, score] of Object.entries(MUSIC_SCORES)) {
    assert.equal(score.steps, 128, track);
    assert.ok(score.bpm >= 60 && score.bpm <= 160, track);
    assert.ok(score.notes.length > 0, track);
    let previousStep = -1;
    for (const note of score.notes) {
      assert.ok(Number.isInteger(note.step) && note.step >= previousStep && note.step < score.steps, `${track}: ${JSON.stringify(note)}`);
      assert.ok(Number.isInteger(note.length) && note.length > 0 && note.step + note.length <= score.steps, `${track}: ${JSON.stringify(note)}`);
      assert.ok(Number.isInteger(note.midi) && note.midi >= 24 && note.midi <= 96, `${track}: pitch`);
      assert.ok(note.volume >= 0.03 && note.volume <= 0.15, `${track}: note level`);
      assert.ok(['lead', 'pluck', 'pad', 'bass'].includes(note.voice), `${track}: voice`);
      previousStep = note.step;
    }
    previousStep = -1;
    for (const hit of score.percussion) {
      assert.ok(Number.isInteger(hit.step) && hit.step >= previousStep && hit.step < score.steps, `${track}: percussion timing`);
      assert.ok(hit.volume >= 0.03 && hit.volume <= 0.15, `${track}: percussion level`);
      assert.ok(['kick', 'snare', 'hat'].includes(hit.kind), `${track}: percussion voice`);
      previousStep = hit.step;
    }
    for (let bar = 0; bar < 8; bar++) {
      assert.ok(score.notes.some(note => note.voice === 'lead' && Math.floor(note.step / 16) === bar), `${track}: missing melodic bar ${bar}`);
      assert.ok(score.notes.some(note => note.voice === 'bass' && Math.floor(note.step / 16) === bar), `${track}: missing bass bar ${bar}`);
    }
  }
});

test('the three themes differ in tempo, melodic density, harmony and battle percussion', () => {
  const { overworld, dungeon: crypt, boss } = MUSIC_SCORES;
  assert.ok(crypt.bpm < overworld.bpm && overworld.bpm < boss.bpm);
  assert.ok(crypt.notes.filter(note => note.voice === 'lead').length < overworld.notes.filter(note => note.voice === 'lead').length);
  const overworldPitchClasses = new Set(overworld.notes.filter(note => note.voice === 'lead').map(note => note.midi % 12));
  assert.deepEqual([...overworldPitchClasses].sort((a, b) => a - b), [0, 2, 4, 7, 9], 'The overworld melody stays in C major pentatonic');
  assert.ok(crypt.notes.some(note => note.voice === 'lead' && note.midi % 12 === 5), 'The dungeon has a minor third');
  assert.ok(crypt.notes.some(note => note.voice === 'lead' && note.midi % 12 === 1), 'The dungeon has a tense leading tone');
  assert.deepEqual(new Set(boss.percussion.map(hit => hit.kind)), new Set(['kick', 'snare', 'hat']));
  for (const track of ['overworld', 'dungeon', 'boss'] as const satisfies readonly MusicTrack[]) {
    const score = MUSIC_SCORES[track];
    const harmonies = new Set(score.notes.filter(note => note.voice === 'pad').map(note => note.midi));
    assert.ok(harmonies.size >= 5, `${track}: harmony must move beyond a single chord`);
  }
});
