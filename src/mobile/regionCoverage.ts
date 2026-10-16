import { CONFIG } from '../config';

export function buildRegionCoverage(
  counts: Array<{ region: string; clips: number }>,
): Array<{ region: string; zone: string; clips: number; coveragePct: number }> {
  const byRegion = new Map(counts.map((c) => [c.region, c.clips]));
  return CONFIG.regions.map((r) => {
    const clips = byRegion.get(r.name) ?? 0;
    return { region: r.name, zone: r.zone, clips, coveragePct: Math.min(1, clips / CONFIG.regionTargetClips) };
  });
}
