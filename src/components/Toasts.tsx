import { CheckCircle2, AlertTriangle, Info } from 'lucide-react';

export interface ToastItem {
  id: number;
  kind: 'success' | 'warn' | 'info';
  text: string;
}

export default function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+12px)]">
      {items.map((t) => {
        const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'warn' ? AlertTriangle : Info;
        const color =
          t.kind === 'success' ? 'text-emerald-400' : t.kind === 'warn' ? 'text-volt-400' : 'text-electric-400';
        return (
          <div
            key={t.id}
            className="toast-in pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl border border-ink-600 bg-ink-800/95 px-4 py-3 text-sm shadow-xl backdrop-blur"
          >
            <Icon className={`h-5 w-5 shrink-0 ${color}`} />
            <span>{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}
