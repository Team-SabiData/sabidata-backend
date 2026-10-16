import { type Readable } from 'node:stream';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { type AudioStore, assertSafeSegment, mimeFromExt } from './audioStore';

// Sous-ensemble de S3Client suffisant pour le store (injectable en test).
export interface S3Sender {
  send(cmd: PutObjectCommand | GetObjectCommand): Promise<unknown>;
}

export interface S3AudioStoreOptions {
  bucket: string;
  // Préfixe de clé optionnel (ex. 'clips/') ; le chemin stocké en base reste
  // relatif (clipId.ext), comme FsAudioStore — les deux stores sont permutables.
  prefix?: string;
}

// Absence de clé S3 : NoSuchKey (GetObject), NotFound (HeadObject) ou 404 brut.
function isMissingKey(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404;
}

// Implémentation S3 (compatible R2/B2/MinIO via endpoint custom).
export class S3AudioStore implements AudioStore {
  constructor(
    private readonly client: S3Sender,
    private readonly opts: S3AudioStoreOptions,
  ) {}

  private key(rel: string): string {
    return `${this.opts.prefix ?? ''}${rel}`;
  }

  async save(clipId: string, buffer: Buffer, ext: string): Promise<string> {
    assertSafeSegment(clipId);
    assertSafeSegment(ext);
    const rel = `${clipId}.${ext}`;
    await this.client.send(new PutObjectCommand({
      Bucket: this.opts.bucket,
      Key: this.key(rel),
      Body: buffer,
      ContentType: mimeFromExt(ext),
    }));
    return rel;
  }

  async openRead(storedPath: string): Promise<Readable | null> {
    assertSafeSegment(storedPath);
    let out: { Body?: unknown };
    try {
      out = (await this.client.send(new GetObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.key(storedPath),
      }))) as { Body?: unknown };
    } catch (e) {
      if (isMissingKey(e)) return null;
      throw e;
    }
    return (out.Body as Readable | undefined) ?? null;
  }
}
