import { createWorker, type Worker } from 'tesseract.js';
import type { ActivityType } from './db';

export interface OcrMetrics {
  distanceKm: number | null;
  elevationM: number | null;
  durationSec: number | null;
  activityType: ActivityType | null;
  rawText: string;
}

/* ---------- Worker (self-hosted assets for offline use, CDN fallback) ---------- */

let workerPromise: Promise<Worker> | null = null;
let progressCb: ((p: number) => void) | null = null;

const logger = (m: { status: string; progress: number }) => {
  if (m.status === 'recognizing text') progressCb?.(m.progress);
};

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      try {
        return await createWorker('eng', 1, {
          workerPath: '/tesseract/worker.min.js',
          corePath: '/tesseract/core',
          langPath: '/tesseract/lang',
          logger,
        });
      } catch (err) {
        console.warn('Local Tesseract assets unavailable, falling back to CDN', err);
        return await createWorker('eng', 1, { logger });
      }
    })();
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

export async function runOcr(image: Blob, onProgress?: (p: number) => void): Promise<OcrMetrics> {
  progressCb = onProgress ?? null;
  const worker = await getWorker();
  const { data } = await worker.recognize(image);
  progressCb = null;
  return parseWorkoutText(data.text ?? '');
}

/* ---------- Parsing ---------- */

const MI_TO_KM = 1.609344;
const FT_TO_M = 0.3048;

const num = (s: string) => parseFloat(s.replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));

function parseDuration(s: string): number | null {
  const colon = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (colon) {
    return colon[3] !== undefined
      ? +colon[1] * 3600 + +colon[2] * 60 + +colon[3]
      : +colon[1] * 60 + +colon[2];
  }
  const h = s.match(/(\d+)\s*h/i);
  const m = s.match(/(\d+)\s*m(?:in)?\b/i);
  const sec = s.match(/(\d+)\s*s\b/i);
  const total = (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (sec ? +sec[1] : 0);
  return total > 0 ? total : null;
}

const DUR = String.raw`((?:\d{1,2}:){1,2}\d{2}|\d+\s*h(?:\s*\d+\s*m(?:in)?)?(?:\s*\d+\s*s)?|\d+\s*m(?:in)?(?:\s*\d+\s*s)?)`;

export function parseWorkoutText(raw: string): OcrMetrics {
  const text = raw.replace(/[|]/g, ' ');

  // Distance: prefer a number labelled "distance", else first "<n> km|mi"
  let distanceKm: number | null = null;
  const distRe = /(\d+(?:[.,]\d{1,2})?)\s*(km|mi)\b/gi;
  const labelled = text.match(/distance[^\d]{0,15}(\d+(?:[.,]\d{1,2})?)\s*(km|mi)\b/i);
  const first = labelled ?? distRe.exec(text);
  if (first) {
    const v = num(first[1]);
    distanceKm = first[2].toLowerCase() === 'mi' ? v * MI_TO_KM : v;
  }

  // Elevation: labelled "elevation (gain)" or "gain"
  let elevationM: number | null = null;
  const elev =
    text.match(/elev\w*(?:\s*gain)?[^\d]{0,15}(\d[\d,]*(?:\.\d+)?)\s*(m|ft)\b/i) ??
    text.match(/gain[^\d]{0,15}(\d[\d,]*(?:\.\d+)?)\s*(m|ft)\b/i);
  if (elev) {
    const v = num(elev[1]);
    elevationM = elev[2].toLowerCase() === 'ft' ? v * FT_TO_M : v;
  }

  // Duration: moving time > elapsed time > generic time > first non-pace clock value
  let durationSec: number | null = null;
  for (const label of ['moving\\s*time', 'elapsed\\s*time', '\\btime']) {
    const m = text.match(new RegExp(label + String.raw`[^\d]{0,15}` + DUR, 'i'));
    if (m) {
      durationSec = parseDuration(m[1].trim());
      if (durationSec) break;
    }
  }
  if (!durationSec) {
    const clock = text.match(/(\d{1,2}:\d{2}(?::\d{2})?)(?!\s*\/|\d)/);
    if (clock) durationSec = parseDuration(clock[1]);
  }

  // Activity guess from keywords
  const lower = text.toLowerCase();
  let activityType: ActivityType | null = null;
  if (/\b(run|running|trail)\b/.test(lower)) activityType = 'Running';
  else if (/\b(ride|cycling|bike|biking)\b/.test(lower)) activityType = 'Cycling';
  else if (/\b(walk|walking|hike|hiking)\b/.test(lower)) activityType = 'Walking';
  else if (/\b(gym|weight|workout|cardio|treadmill|elliptical|yoga|hiit)\b/.test(lower)) activityType = 'Gym';

  return {
    distanceKm: distanceKm !== null ? Math.round(distanceKm * 100) / 100 : null,
    elevationM: elevationM !== null ? Math.round(elevationM) : null,
    durationSec,
    activityType,
    rawText: raw,
  };
}
