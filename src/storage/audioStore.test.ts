import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsAudioStore, InMemoryAudioStore, extFromMime, mimeFromExt } from './audioStore';

async function readAll(store: { openRead(p: string): Promise<NodeJS.ReadableStream | null> }, p: string) {
  const s = await store.openRead(p);
  if (!s) return null;
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

test('FsAudioStore — save écrit le fichier et openRead le relit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sabi-audio-'));
  try {
    const store = new FsAudioStore(dir);
    const buf = Buffer.from('AUDIODATA');
    const path = await store.save('clip1', buf, 'm4a');
    assert.equal(path, 'clip1.m4a');
    assert.deepEqual(await readAll(store, path), buf);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FsAudioStore — openRead renvoie null si absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sabi-audio-'));
  try {
    assert.equal(await new FsAudioStore(dir).openRead('missing.m4a'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('InMemoryAudioStore — round-trip', async () => {
  const store = new InMemoryAudioStore();
  const buf = Buffer.from('X');
  const path = await store.save('c', buf, 'wav');
  assert.deepEqual(await readAll(store, path), buf);
});

test('mime helpers — mapping connu et rejet inconnu', () => {
  assert.equal(extFromMime('audio/mpeg'), 'mp3');
  assert.equal(extFromMime('image/png'), null);
  assert.equal(mimeFromExt('m4a'), 'audio/mp4');
  assert.equal(mimeFromExt('zzz'), 'application/octet-stream');
});

test('FsAudioStore.save — rejette clipId traversal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sabi-audio-'));
  try {
    const store = new FsAudioStore(dir);
    const buf = Buffer.from('X');
    await assert.rejects(
      () => store.save('../evil', buf, 'm4a'),
      /unsafe path segment/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FsAudioStore.save — rejette ext traversal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sabi-audio-'));
  try {
    const store = new FsAudioStore(dir);
    const buf = Buffer.from('X');
    await assert.rejects(
      () => store.save('clip1', buf, '../evil'),
      /unsafe path segment/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FsAudioStore.openRead — rejette storedPath traversal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sabi-audio-'));
  try {
    const store = new FsAudioStore(dir);
    await assert.rejects(
      () => store.openRead('../evil.m4a'),
      /unsafe path segment/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
