import { useEffect, useMemo, useState } from 'react';
import { Loader2, X, Zap } from 'lucide-react';
import type { ActivityType } from '../db';
import type { OcrMetrics } from '../ocrService';
import { XP_RATES, calculateXp } from '../xp';

export interface ConfirmData {
  activityType: ActivityType;
  distanceKm: number;
  elevationM: number;
  durationSec: number;
  xp: number;
}

interface Props {
  imageUrl: string;
  scanning: boolean;
  progress: number;
  ocr: OcrMetrics | null;
  ocrFailed: boolean;
  onConfirm: (d: ConfirmData) => void;
  onCancel: () => void;
}

const ACTIVITIES: ActivityType[] = ['Running', 'Cycling', 'Walking', 'Gym'];
const ACTIVITY_LABEL: Record<ActivityType, string> = {
  Running: 'Running / Trail Run',
  Cycling: 'Outdoor Cycling',
  Walking: 'Walking / Hiking',
  Gym: 'Indoor Gym / Cardio',
};

const inputCls =
  'w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-base text-white outline-none focus:border-electric-400';

export default function ConfirmModal({ imageUrl, scanning, progress, ocr, ocrFailed, onConfirm, onCancel }: Props) {
  const [activity, setActivity] = useState<ActivityType>('Running');
  const [distance, setDistance] = useState('');
  const [elevation, setElevation] = useState('');
  const [h, setH] = useState('');
  const [m, setM] = useState('');
  const [s, setS] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  // Pre-fill once OCR results arrive
  useEffect(() => {
    if (!ocr) return;
    setActivity(ocr.activityType ?? 'Running');
    setDistance(ocr.distanceKm !== null ? String(ocr.distanceKm) : '');
    setElevation(ocr.elevationM !== null ? String(ocr.elevationM) : '');
    if (ocr.durationSec !== null) {
      setH(String(Math.floor(ocr.durationSec / 3600)));
      setM(String(Math.floor((ocr.durationSec % 3600) / 60)));
      setS(String(ocr.durationSec % 60));
    }
  }, [ocr]);

  const durationSec = (+h || 0) * 3600 + (+m || 0) * 60 + (+s || 0);
  const distanceKm = Math.max(0, parseFloat(distance) || 0);
  const elevationM = Math.max(0, parseFloat(elevation) || 0);

  const xp = useMemo(
    () => calculateXp({ activityType: activity, distanceKm, elevationM, durationSec }),
    [activity, distanceKm, elevationM, durationSec]
  );

  const isGym = activity === 'Gym';
  const valid = xp > 0;

  const missing = ocr && (ocr.distanceKm === null || ocr.durationSec === null);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center">
      <div className="safe-bottom max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-ink-600 bg-ink-800 p-5 sm:rounded-3xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Verify Workout</h2>
          <button onClick={onCancel} aria-label="Cancel" className="rounded-full p-1.5 text-slate-400 hover:bg-ink-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-4 flex gap-3">
          <img src={imageUrl} alt="Workout screenshot" className="h-28 w-20 shrink-0 rounded-lg border border-ink-600 object-cover" />
          <div className="flex-1 text-sm text-slate-300">
            {scanning ? (
              <div className="flex h-full flex-col justify-center gap-2">
                <div className="flex items-center gap-2 text-electric-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Reading screenshot…
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-ink-700">
                  <div
                    className="h-full bg-electric-500 transition-all"
                    style={{ width: `${Math.max(5, Math.round(progress * 100))}%` }}
                  />
                </div>
                <p className="text-xs text-slate-500">Runs on-device. First scan may take a few seconds.</p>
              </div>
            ) : ocrFailed ? (
              <p className="text-volt-400">Couldn't read this image automatically. Please enter the numbers manually.</p>
            ) : missing ? (
              <p className="text-volt-400">Some values weren't detected — please check and fill them in.</p>
            ) : (
              <p className="text-emerald-400">Values detected. Double-check them before confirming.</p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Activity</span>
            <select value={activity} onChange={(e) => setActivity(e.target.value as ActivityType)} className={inputCls}>
              {ACTIVITIES.map((a) => (
                <option key={a} value={a}>
                  {ACTIVITY_LABEL[a]}
                </option>
              ))}
            </select>
          </label>

          {!isGym && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-400">Distance (km)</span>
                <input inputMode="decimal" value={distance} onChange={(e) => setDistance(e.target.value)} placeholder="0.00" className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-400">Elevation gain (m)</span>
                <input inputMode="decimal" value={elevation} onChange={(e) => setElevation(e.target.value)} placeholder="0" className={inputCls} />
              </label>
            </div>
          )}

          <div>
            <span className="mb-1 block text-xs font-medium text-slate-400">
              {isGym ? 'Moving time' : 'Duration'} (h : m : s)
            </span>
            <div className="grid grid-cols-3 gap-2">
              <input inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} placeholder="h" className={inputCls} />
              <input inputMode="numeric" value={m} onChange={(e) => setM(e.target.value)} placeholder="m" className={inputCls} />
              <input inputMode="numeric" value={s} onChange={(e) => setS(e.target.value)} placeholder="s" className={inputCls} />
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-xl border border-volt-500/40 bg-volt-500/10 px-4 py-3">
          <div>
            <div className="text-xs text-slate-400">XP you'll earn</div>
            <div className="text-[11px] text-slate-500">{XP_RATES[activity].label}</div>
          </div>
          <div className="flex items-center gap-1 text-2xl font-extrabold text-volt-400">
            <Zap className="h-6 w-6 fill-volt-400" /> {xp.toLocaleString()}
          </div>
        </div>

        {ocr?.rawText && (
          <div className="mt-3">
            <button onClick={() => setShowRaw((v) => !v)} className="text-xs text-slate-500 underline">
              {showRaw ? 'Hide' : 'Show'} detected text
            </button>
            {showRaw && (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-900 p-2 text-[11px] text-slate-400">
                {ocr.rawText}
              </pre>
            )}
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button onClick={onCancel} className="rounded-xl border border-ink-600 py-3 font-semibold text-slate-300 active:bg-ink-700">
            Discard
          </button>
          <button
            disabled={scanning || !valid}
            onClick={() => onConfirm({ activityType: activity, distanceKm, elevationM: isGym ? 0 : elevationM, durationSec, xp })}
            className="rounded-xl bg-electric-500 py-3 font-bold text-white active:bg-electric-600 disabled:opacity-40"
          >
            Bank XP
          </button>
        </div>
      </div>
    </div>
  );
}
