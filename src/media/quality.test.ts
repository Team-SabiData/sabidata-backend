import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeAudio } from './quality';

const base = {
  durationMs: 5000,
  silenceRatio: 0.05,
  snrDb: 25,
  peakDbfs: -6,
  sampleRateHz: 16000,
  channels: 1,
};

test('gradeAudio — A si master 16k mono propre', () => {
  const g = gradeAudio(base);
  assert.equal(g.quality, 'A');
  assert.equal(g.passed, true);
});

test('gradeAudio — F si durée hors plage', () => {
  const g = gradeAudio({ ...base, durationMs: 200 });
  assert.equal(g.quality, 'F');
  assert.equal(g.passed, false);
});

test('gradeAudio — F si trop de silence', () => {
  const g = gradeAudio({ ...base, silenceRatio: 0.8 });
  assert.equal(g.quality, 'F');
  assert.equal(g.passed, false);
});

test('gradeAudio — B si SNR moyen', () => {
  const g = gradeAudio({ ...base, snrDb: 14, silenceRatio: 0.2 });
  assert.equal(g.quality, 'B');
  assert.equal(g.passed, true);
});
