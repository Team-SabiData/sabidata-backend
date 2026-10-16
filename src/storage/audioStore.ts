import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Readable } from 'node:stream';

// Stockage de blob audio, abstrait pour rester swappable (S3/pré-signé = D6).
export interface AudioStore {
  // Persiste le buffer et renvoie un chemin relatif à stocker sur le clip.
  save(clipId: string, buffer: Buffer, ext: string): Promise<string>;
  // Ouvre le blob en lecture ; null si absent.
  openRead(storedPath: string): Promise<Readable | null>;
}

// Formats audio acceptés (mimetype → extension).
const AUDIO_MIME_EXT: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
};

// Valide qu'un segment de chemin ne contient pas de traversal dangereux.
export function assertSafeSegment(s: string): void {
  if (s.includes('/') || s.includes('\\') || s.includes('..') || s.length === 0) {
    throw new Error(`unsafe path segment: ${s}`);
  }
}

export function extFromMime(mime: string): string | null {
  return AUDIO_MIME_EXT[mime] ?? null;
}

export function mimeFromExt(ext: string): string {
  const found = Object.entries(AUDIO_MIME_EXT).find(([, e]) => e === ext);
  return found ? found[0] : 'application/octet-stream';
}

// Implémentation filesystem : <dir>/<clipId>.<ext>.
export class FsAudioStore implements AudioStore {
  constructor(private readonly dir: string) {}

  async save(clipId: string, buffer: Buffer, ext: string): Promise<string> {
    assertSafeSegment(clipId);
    assertSafeSegment(ext);
    await mkdir(this.dir, { recursive: true });
    const rel = `${clipId}.${ext}`;
    await writeFile(join(this.dir, rel), buffer);
    return rel;
  }

  async openRead(storedPath: string): Promise<Readable | null> {
    assertSafeSegment(storedPath);
    const full = join(this.dir, storedPath);
    if (!existsSync(full)) return null;
    return createReadStream(full);
  }
}

// Implémentation mémoire pour les tests (pas de disque).
export class InMemoryAudioStore implements AudioStore {
  private readonly blobs = new Map<string, Buffer>();

  async save(clipId: string, buffer: Buffer, ext: string): Promise<string> {
    const rel = `${clipId}.${ext}`;
    this.blobs.set(rel, buffer);
    return rel;
  }

  async openRead(storedPath: string): Promise<Readable | null> {
    const buf = this.blobs.get(storedPath);
    if (!buf) return null;
    const { Readable } = await import('node:stream');
    return Readable.from(buf);
  }
}
