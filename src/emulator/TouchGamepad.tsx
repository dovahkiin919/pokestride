import { useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import type { PadButton } from './useEmulator';

interface PadProps {
  onDown: (b: PadButton) => void;
  onUp: (b: PadButton) => void;
  disabled?: boolean;
}

const buzz = () => {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* unsupported */
  }
};

function HoldButton({
  btn,
  label,
  className,
  onDown,
  onUp,
  disabled,
}: PadProps & { btn: PadButton; label: string; className: string }) {
  const [pressed, setPressed] = useState(false);
  const held = useRef(false);

  const release = () => {
    if (!held.current) return;
    held.current = false;
    setPressed(false);
    onUp(btn);
  };

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        if (held.current) return;
        held.current = true;
        setPressed(true);
        buzz();
        onDown(btn);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      className={`touch-none select-none font-extrabold transition-transform disabled:opacity-40 ${
        pressed ? 'scale-90 brightness-125' : ''
      } ${className}`}
    >
      {label}
    </button>
  );
}

function DPad({ onDown, onUp, disabled }: PadProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dirs = useRef(new Set<PadButton>());
  const [shown, setShown] = useState<PadButton[]>([]);

  const update = (x: number, y: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const t = r.width * 0.14; // dead zone; touching a corner presses two directions
    const next = new Set<PadButton>();
    if (dy < -t) next.add('up');
    if (dy > t) next.add('down');
    if (dx < -t) next.add('left');
    if (dx > t) next.add('right');
    for (const d of dirs.current) if (!next.has(d)) onUp(d);
    for (const d of next) if (!dirs.current.has(d)) onDown(d);
    if (next.size && !dirs.current.size) buzz();
    dirs.current = next;
    setShown(Array.from(next));
  };

  const release = () => {
    for (const d of dirs.current) onUp(d);
    dirs.current = new Set();
    setShown([]);
  };

  const arrow = (dir: PadButton, Icon: typeof ChevronUp, pos: string) => (
    <Icon
      className={`absolute h-7 w-7 ${pos} ${shown.includes(dir) ? 'text-volt-400' : 'text-slate-500'}`}
      strokeWidth={3}
    />
  );

  return (
    <div
      ref={ref}
      role="group"
      aria-label="D-pad"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) update(e.clientX, e.clientY);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      className={`relative h-[120px] w-[120px] touch-none select-none rounded-full border border-ink-600 bg-ink-800 ${
        disabled ? 'opacity-40' : ''
      }`}
    >
      <div className="absolute left-1/2 top-2 bottom-2 w-10 -translate-x-1/2 rounded-lg bg-ink-700" />
      <div className="absolute left-2 right-2 top-1/2 h-10 -translate-y-1/2 rounded-lg bg-ink-700" />
      {arrow('up', ChevronUp, 'left-1/2 top-2 -translate-x-1/2')}
      {arrow('down', ChevronDown, 'bottom-2 left-1/2 -translate-x-1/2')}
      {arrow('left', ChevronLeft, 'left-2 top-1/2 -translate-y-1/2')}
      {arrow('right', ChevronRight, 'right-2 top-1/2 -translate-y-1/2')}
    </div>
  );
}

export default function TouchGamepad({ onDown, onUp, disabled }: PadProps) {
  const p = { onDown, onUp, disabled };
  const shoulder = 'h-10 w-24 rounded-xl border border-ink-600 bg-ink-700 text-sm text-slate-200';
  const pill = 'h-8 w-[72px] rounded-full border border-ink-600 bg-ink-800 text-[11px] text-slate-300';
  const round = 'absolute h-14 w-14 rounded-full border border-electric-400/60 bg-electric-600 text-lg text-white shadow-lg';

  return (
    <div className="touch-none select-none px-3 pb-2" onContextMenu={(e) => e.preventDefault()}>
      <div className="mb-3 flex justify-between px-1">
        <HoldButton btn="l" label="L" className={shoulder} {...p} />
        <HoldButton btn="r" label="R" className={shoulder} {...p} />
      </div>
      <div className="flex items-center justify-between">
        <DPad {...p} />
        <div className="flex flex-col items-center gap-3">
          <HoldButton btn="select" label="SELECT" className={pill} {...p} />
          <HoldButton btn="start" label="START" className={pill} {...p} />
        </div>
        <div className="relative h-[120px] w-[120px]">
          <HoldButton btn="b" label="B" className={`${round} bottom-1 left-0`} {...p} />
          <HoldButton btn="a" label="A" className={`${round} right-0 top-1`} {...p} />
        </div>
      </div>
    </div>
  );
}
