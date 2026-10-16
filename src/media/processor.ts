import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { type AudioQuality, type MediaMetrics, gradeAudio } from './quality';

export interface MediaProcessResult {
  masterWav: Buffer;
  metrics: MediaMetrics;
  ingestSha256: string;
  masterSha256: string;
  quality: AudioQuality;
  passed: boolean;
  reasons: string[];
}

export interface MediaProcessor {
  process(ingest: Buffer, ext: string): Promise<MediaProcessResult>;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

/** Tests / CI sans ffmpeg : métriques synthétiques, master = ingest. */
export class StubMediaProcessor implements MediaProcessor {
  constructor(private readonly metricsOverride: Partial<MediaMetrics> = {}) {}

  async process(ingest: Buffer, _ext: string): Promise<MediaProcessResult> {
    const metrics: MediaMetrics = {
      durationMs: this.metricsOverride.durationMs ?? 5000,
      silenceRatio: this.metricsOverride.silenceRatio ?? 0.05,
      snrDb: this.metricsOverride.snrDb ?? 25,
      peakDbfs: this.metricsOverride.peakDbfs ?? -6,
      sampleRateHz: this.metricsOverride.sampleRateHz ?? 16000,
      channels: this.metricsOverride.channels ?? 1,
    };
    const grade = gradeAudio(metrics);
    return {
      masterWav: Buffer.from(ingest),
      metrics,
      ingestSha256: sha256(ingest),
      masterSha256: sha256(ingest),
      quality: grade.quality,
      passed: grade.passed,
      reasons: grade.reasons,
    };
  }
}

/** Prod : decode + master WAV PCM 16 kHz mono + métriques ffmpeg. */
export class FfmpegMediaProcessor implements MediaProcessor {
  async process(ingest: Buffer, ext: string): Promise<MediaProcessResult> {
    const dir = await mkdtemp(join(tmpdir(), 'sabi-media-'));
    const safeExt = ext.replace(/[^a-z0-9]/gi, '') || 'bin';
    const ingestPath = join(dir, `ingest.${safeExt}`);
    const masterPath = join(dir, 'master.wav');
    try {
      await writeFile(ingestPath, ingest);
      const conv = await run('ffmpeg', [
        '-y', '-i', ingestPath,
        '-ac', '1', '-ar', '16000', '-sample_fmt', 's16',
        '-f', 'wav', masterPath,
      ]);
      if (conv.code !== 0) {
        throw new Error(`ffmpeg convert failed: ${conv.stderr.slice(-400)}`);
      }
      const masterWav = await readFile(masterPath);

      const probe = await run('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        masterPath,
      ]);
      const durationS = Number.parseFloat(probe.stdout.trim());
      const durationMs = Number.isFinite(durationS) ? Math.round(durationS * 1000) : 0;

      const silence = await run('ffmpeg', [
        '-i', masterPath,
        '-af', 'silencedetect=noise=-40dB:d=0.25',
        '-f', 'null', '-',
      ]);
      const silenceLog = silence.stderr;
      let silenceMs = 0;
      const startRe = /silence_start:\s*([\d.]+)/g;
      const endRe = /silence_end:\s*([\d.]+)/g;
      const starts = [...silenceLog.matchAll(startRe)].map((m) => Number(m[1]));
      const ends = [...silenceLog.matchAll(endRe)].map((m) => Number(m[1]));
      for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
        silenceMs += Math.max(0, (ends[i]! - starts[i]!) * 1000);
      }
      // silence_end manquant en fin de fichier
      if (starts.length === ends.length + 1 && durationMs > 0) {
        silenceMs += Math.max(0, durationMs - starts[starts.length - 1]! * 1000);
      }
      const silenceRatio = durationMs > 0 ? Math.min(1, silenceMs / durationMs) : 1;

      const astats = await run('ffmpeg', [
        '-i', masterPath,
        '-af', 'astats=metadata=1:reset=1',
        '-f', 'null', '-',
      ]);
      const peakMatch = astats.stderr.match(/Peak level dB:\s*([-\d.]+)/i);
      const rmsMatch = astats.stderr.match(/RMS level dB:\s*([-\d.]+)/i);
      const peakDbfs = peakMatch ? Number(peakMatch[1]) : null;
      const rms = rmsMatch ? Number(rmsMatch[1]) : null;
      // Approximation SNR : écart peak−RMS (indicatif, pas un vrai SNR).
      const snrDb = peakDbfs != null && rms != null ? Math.max(0, peakDbfs - rms) : null;

      const metrics: MediaMetrics = {
        durationMs,
        silenceRatio,
        snrDb,
        peakDbfs,
        sampleRateHz: 16000,
        channels: 1,
      };
      const grade = gradeAudio(metrics);
      return {
        masterWav,
        metrics,
        ingestSha256: sha256(ingest),
        masterSha256: sha256(masterWav),
        quality: grade.quality,
        passed: grade.passed,
        reasons: grade.reasons,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    const r = await run('ffmpeg', ['-version']);
    return r.code === 0;
  } catch {
    return false;
  }
}
