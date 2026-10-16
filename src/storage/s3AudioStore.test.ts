import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { S3AudioStore, type S3Sender } from './s3AudioStore';

// Client factice : capture les commandes envoyées, rejoue des réponses.
function fakeClient(onSend: (cmd: object) => Promise<unknown>): S3Sender & { sent: object[] } {
  const sent: object[] = [];
  return {
    sent,
    async send(cmd: object) {
      sent.push(cmd);
      return onSend(cmd);
    },
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

test('S3AudioStore.save — PutObject avec clé, content-type et bucket corrects', async () => {
  const client = fakeClient(async () => ({}));
  const store = new S3AudioStore(client, { bucket: 'sabi-audio', prefix: 'clips/' });
  const buf = Buffer.from('AUDIODATA');

  const path = await store.save('clip1', buf, 'm4a');

  assert.equal(path, 'clip1.m4a'); // chemin relatif identique à FsAudioStore
  assert.equal(client.sent.length, 1);
  const cmd = client.sent[0];
  assert.ok(cmd instanceof PutObjectCommand);
  assert.equal(cmd.input.Bucket, 'sabi-audio');
  assert.equal(cmd.input.Key, 'clips/clip1.m4a');
  assert.equal(cmd.input.ContentType, 'audio/mp4');
  assert.deepEqual(cmd.input.Body, buf);
});

test('S3AudioStore.save — sans prefix, la clé est le chemin relatif', async () => {
  const client = fakeClient(async () => ({}));
  const store = new S3AudioStore(client, { bucket: 'b' });
  await store.save('c9', Buffer.from('X'), 'wav');
  const cmd = client.sent[0] as PutObjectCommand;
  assert.equal(cmd.input.Key, 'c9.wav');
});

test('S3AudioStore.openRead — renvoie le Body en flux lisible', async () => {
  const buf = Buffer.from('CONTENU');
  const client = fakeClient(async () => ({ Body: Readable.from(buf) }));
  const store = new S3AudioStore(client, { bucket: 'b', prefix: 'clips/' });

  const stream = await store.openRead('clip1.m4a');

  assert.ok(stream);
  assert.deepEqual(await readAll(stream), buf);
  const cmd = client.sent[0];
  assert.ok(cmd instanceof GetObjectCommand);
  assert.equal(cmd.input.Bucket, 'b');
  assert.equal(cmd.input.Key, 'clips/clip1.m4a');
});

test('S3AudioStore.openRead — null si la clé est absente (NoSuchKey)', async () => {
  const err = Object.assign(new Error('no such key'), { name: 'NoSuchKey' });
  const client = fakeClient(async () => { throw err; });
  const store = new S3AudioStore(client, { bucket: 'b' });
  assert.equal(await store.openRead('missing.m4a'), null);
});

test('S3AudioStore.openRead — null sur 404 sans nom d’erreur typé', async () => {
  const err = Object.assign(new Error('not found'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
  const client = fakeClient(async () => { throw err; });
  const store = new S3AudioStore(client, { bucket: 'b' });
  assert.equal(await store.openRead('missing.m4a'), null);
});

test('S3AudioStore.openRead — propage les autres erreurs (ex. accès refusé)', async () => {
  const err = Object.assign(new Error('forbidden'), { name: 'AccessDenied' });
  const client = fakeClient(async () => { throw err; });
  const store = new S3AudioStore(client, { bucket: 'b' });
  await assert.rejects(() => store.openRead('clip1.m4a'), /forbidden/);
});

test('S3AudioStore — rejette les segments traversal', async () => {
  const client = fakeClient(async () => ({}));
  const store = new S3AudioStore(client, { bucket: 'b' });
  await assert.rejects(() => store.save('../evil', Buffer.from('X'), 'm4a'), /unsafe path segment/);
  await assert.rejects(() => store.save('clip1', Buffer.from('X'), '../evil'), /unsafe path segment/);
  await assert.rejects(() => store.openRead('../evil.m4a'), /unsafe path segment/);
  assert.equal(client.sent.length, 0); // rien ne part vers S3
});
