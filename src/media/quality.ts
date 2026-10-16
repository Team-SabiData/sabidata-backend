import { CONFIG } from '../config';

export type AudioQuality = 'A' | 'B' | 'C' | 'F';

export interface MediaMetrics {
  durationMs: number;
  silenceRatio: number;
  snrDb: number | null;
  peakDbfs: number | null;
  sampleRateHz: number;
  channels: number;
}

export interface GradeResult {
  quality: AudioQuality;
  passed: boolean;
  reasons: string[];
}

/** Grade audio technique (orthogonal au tier de transcription). */
export function gradeAudio(m: MediaMetrics): GradeResult {
  const reasons: string[] = [];
  const durationS = m.durationMs / 1000;
  const { minSeconds, maxSeconds } = CONFIG.autocheck;

  if (durationS < minSeconds || durationS > maxSeconds) {
    reasons.push(`duration_out_of_range:${durationS.toFixed(2)}s`);
    return { quality: 'F', passed: false, reasons };
  }
  if (m.sampleRateHz !== 16000 || m.channels !== 1) {
    reasons.push('master_not_16k_mono');
    return { quality: 'F', passed: false, reasons };
  }
  if (m.peakDbfs != null && m.peakDbfs > -0.5) {
    reasons.push('clipping');
    return { quality: 'F', passed: false, reasons };
  }
  if (m.silenceRatio > 0.5) {
    reasons.push(`silence_too_high:${m.silenceRatio.toFixed(2)}`);
    return { quality: 'F', passed: false, reasons };
  }

  const snr = m.snrDb;
  const silenceOk = m.silenceRatio <= 0.15;
  const snrA = snr == null || snr >= 20;
  const snrB = snr == null || snr >= 12;

  if (silenceOk && snrA) {
    return { quality: 'A', passed: true, reasons };
  }
  if (m.silenceRatio <= 0.35 && snrB) {
    reasons.push('quality_B');
    return { quality: 'B', passed: true, reasons };
  }
  reasons.push('quality_C');
  return { quality: 'C', passed: true, reasons };
}
