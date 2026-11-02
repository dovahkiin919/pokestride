import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Bike, Dumbbell, Footprints, ImageUp, Mountain, Route, Share2, Timer, Trophy, X, Zap, Activity } from 'lucide-react';
import { db, type ActivityType, type Workout } from '../db';
import { formatDuration } from '../xp';

const BADGE: Record<ActivityType, { icon: typeof Bike; cls: string }> = {
  Running: { icon: Activity, cls: 'bg-rose-500/20 text-rose-300' },
  Cycling: { icon: Bike, cls: 'bg-electric-500/20 text-electric-400' },
  Walking: { icon: Footprints, cls: 'bg-emerald-500/20 text-emerald-300' },
  Gym: { icon: Dumbbell, cls: 'bg-violet-500/20 text-violet-300' },
};

function useThumbUrl(hash: string) {
  const row = useLiveQuery(() => db.images.get(hash), [hash]);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!row) return;
    const u = URL.createObjectURL(row.thumb);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [row]);
  return url;
}

function WorkoutCard({ w }: { w: Workout }) {
  const url = useThumbUrl(w.imageHash);
  const { icon: Icon, cls } = BADGE[w.activityType];
  return (
    <div className="overflow-hidden rounded-2xl border border-ink-700 bg-ink-800">
      <div className="relative aspect-[3/4] bg-ink-900">
        {url && <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />}
        <span className={`absolute left-2 top-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold backdrop-blur ${cls}`}>
          <Icon className="h-3 w-3" /> {w.activityType}
        </span>
      </div>
      <div className="space-y-1 p-3 text-xs">
        <div className="text-[11px] text-slate-500">
          {new Date(w.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </div>
        {w.activityType === 'Gym' ? (
          <div className="flex items-center gap-1 text-slate-300">
            <Timer className="h-3.5 w-3.5" /> {formatDuration(w.durationSec)}
          </div>
        ) : (
          <div className="flex items-center justify-between text-slate-300">
            <span className="flex items-center gap-1">
              <Route className="h-3.5 w-3.5" /> {w.distanceKm.toFixed(2)} km
            </span>
            <span className="flex items-center gap-1">
              <Mountain className="h-3.5 w-3.5" /> {Math.round(w.elevationM)} m
            </span>
          </div>
        )}
        <div className="flex items-center gap-1 pt-1 text-sm font-bold text-volt-400">
          <Zap className="h-4 w-4 fill-volt-400" /> +{w.xp.toLocaleString()} XP
        </div>
      </div>
    </div>
  );
}

interface Props {
  xpBank: number;
  onFiles: (files: File[]) => void;
}

export default function VaultTab({ xpBank, onFiles }: Props) {
  const workouts = useLiveQuery(() => db.workouts.orderBy('timestamp').reverse().toArray(), []) ?? [];
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(() => {
    try {
      return localStorage.getItem('ps-share-banner') !== 'closed';
    } catch {
      return true;
    }
  });

  const totalKm = workouts.reduce((a, w) => a + w.distanceKm, 0);

  const closeBanner = () => {
    setBannerOpen(false);
    try {
      localStorage.setItem('ps-share-banner', 'closed');
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="space-y-4 px-4 pb-6">
      {/* XP Bank header card */}
      <div className="rounded-3xl border border-volt-500/30 bg-gradient-to-br from-ink-800 to-ink-700 p-5 shadow-lg">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">XP Bank</div>
        <div className="mt-1 flex items-center gap-2 text-3xl font-extrabold text-volt-400">
          <Zap className="h-8 w-8 fill-volt-400" /> {xpBank.toLocaleString()} XP
          <span className="text-base font-semibold text-slate-400">Available</span>
        </div>
        <div className="mt-3 flex gap-6 text-sm text-slate-300">
          <span className="flex items-center gap-1.5">
            <Route className="h-4 w-4 text-electric-400" /> {totalKm.toFixed(1)} km lifetime
          </span>
          <span className="flex items-center gap-1.5">
            <Trophy className="h-4 w-4 text-electric-400" /> {workouts.length} workouts
          </span>
        </div>
      </div>

      {/* Action bar */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(Array.from(e.dataTransfer.files));
        }}
        className={`rounded-2xl border-2 border-dashed p-4 text-center transition ${
          dragging ? 'border-electric-400 bg-electric-500/10' : 'border-ink-600'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            onFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <button
          onClick={() => inputRef.current?.click()}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-electric-500 py-3 font-bold text-white active:bg-electric-600"
        >
          <ImageUp className="h-5 w-5" /> Upload Strava Screenshot
        </button>
        <p className="mt-2 text-xs text-slate-500">or drag &amp; drop images here</p>
      </div>

      {bannerOpen && (
        <div className="flex gap-3 rounded-2xl border border-electric-500/30 bg-electric-500/10 p-4 text-sm text-slate-300">
          <Share2 className="mt-0.5 h-5 w-5 shrink-0 text-electric-400" />
          <div className="flex-1">
            <div className="font-semibold text-white">Share straight from Strava</div>
            <p className="mt-1 text-xs text-slate-400">
              On Android, install PokéStride (browser menu → Install app). Then in Strava tap Share → choose
              the screenshot/image → pick PokéStride.
            </p>
          </div>
          <button onClick={closeBanner} aria-label="Dismiss" className="self-start text-slate-500">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Gallery */}
      <h2 className="pt-2 text-sm font-semibold uppercase tracking-wider text-slate-400">Workout Vault</h2>
      {workouts.length === 0 ? (
        <div className="rounded-2xl border border-ink-700 bg-ink-800 p-8 text-center text-sm text-slate-500">
          No workouts yet. Upload a screenshot to start banking XP.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {workouts.map((w) => (
            <WorkoutCard key={w.id} w={w} />
          ))}
        </div>
      )}
    </div>
  );
}
