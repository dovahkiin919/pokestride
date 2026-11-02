import type { ActivityType } from './db';

export const XP_RATES: Record<ActivityType, { perKm: number; perMeter: number; perMinute: number; label: string }> = {
  Running: { perKm: 320, perMeter: 2.5, perMinute: 0, label: '320 XP/km + 2.5 XP/m elev' },
  Cycling: { perKm: 95, perMeter: 2.0, perMinute: 0, label: '95 XP/km + 2.0 XP/m elev' },
  Walking: { perKm: 180, perMeter: 2.5, perMinute: 0, label: '180 XP/km + 2.5 XP/m elev' },
  Gym: { perKm: 0, perMeter: 0, perMinute: 40, label: '40 XP per moving minute' },
};

export interface XpInput {
  activityType: ActivityType;
  distanceKm: number;
  elevationM: number;
  durationSec: number;
}

export function calculateXp({ activityType, distanceKm, elevationM, durationSec }: XpInput): number {
  const r = XP_RATES[activityType];
  const xp =
    activityType === 'Gym'
      ? (durationSec / 60) * r.perMinute
      : distanceKm * r.perKm + elevationM * r.perMeter;
  return Math.max(0, Math.round(xp));
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
