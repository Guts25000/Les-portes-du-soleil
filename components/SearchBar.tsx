'use client';
import { useMemo, useState } from 'react';
import type { DomainData, Selection, Webcam } from '@/lib/types';
import { STATIONS } from '@/lib/stations';
import { normalizeText } from '@/lib/geo';
import { DIFF_COLOR, LIFT_LABEL } from '@/lib/estimates';

interface Entry {
  key: string;
  label: string;
  sub: string;
  icon: React.ReactNode;
  norm: string;
  sel: Selection;
  rank: number;
}

const poiIcon: Record<string, string> = { restaurant: '🍽️', bar: '🍺', snowpark: '🏂', webcam: '📷', viewpoint: '🔭', hut: '🛖', debutant: '🐣', freeride: '⚠️', repos: '🪑' };

export default function SearchBar({ data, webcams, onPick }: { data: DomainData | null; webcams: Webcam[]; onPick: (s: Selection) => void }) {
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState(false);

  const index = useMemo<Entry[]>(() => {
    const out: Entry[] = STATIONS.map((s) => ({
      key: s.id,
      label: s.name,
      sub: `Station · ${s.country === 'CH' ? 'Suisse' : 'France'}`,
      icon: '🏔️',
      norm: normalizeText(s.name),
      sel: { type: 'station', item: s },
      rank: 0,
    }));
    if (data) {
      const seen = new Set<string>();
      for (const p of data.pistes) {
        if (!p.named) continue;
        const k = `${p.sector}|${p.name}|${p.difficulty}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          key: p.id,
          label: p.name,
          sub: `Piste · ${p.sector}`,
          icon: <span className="block h-3 w-3 rounded-full border border-white/70" style={{ background: DIFF_COLOR[p.difficulty] }} />,
          norm: normalizeText(p.name),
          sel: { type: 'piste', item: p },
          rank: 1,
        });
      }
      for (const l of data.lifts) {
        out.push({ key: l.id, label: l.name, sub: `${LIFT_LABEL[l.kind]} · ${l.sector}`, icon: '🚡', norm: normalizeText(l.name), sel: { type: 'lift', item: l }, rank: 2 });
      }
      for (const x of data.pois) {
        out.push({ key: x.id, label: x.name, sub: `${x.sector}`, icon: poiIcon[x.kind] ?? '•', norm: normalizeText(x.name), sel: { type: 'poi', item: x }, rank: 3 });
      }
    }
    for (const w of webcams) out.push({ key: w.id, label: w.name, sub: 'Webcam', icon: '📷', norm: normalizeText(w.name), sel: { type: 'webcam', item: w }, rank: 3 });
    return out;
  }, [data, webcams]);

  const results = useMemo(() => {
    const n = normalizeText(q);
    if (!n) return [];
    const words = n.split(' ');
    return index
      .map((e) => {
        if (!words.every((w) => e.norm.includes(w))) return null;
        const score = (e.norm.startsWith(n) ? 0 : e.norm.split(' ').some((t) => t.startsWith(words[0])) ? 1 : 2) * 10 + e.rank;
        return { e, score };
      })
      .filter((x): x is { e: Entry; score: number } => !!x)
      .sort((a, b) => a.score - b.score || a.e.label.length - b.e.label.length)
      .slice(0, 12)
      .map((x) => x.e);
  }, [q, index]);

  return (
    <div className="pointer-events-auto relative w-full max-w-[440px]">
      <div className="glass flex items-center gap-2 rounded-2xl px-3.5 py-2.5">
        <span className="text-glacier-200/60">⌕</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) {
              onPick(results[0].sel);
              setQ('');
            }
          }}
          placeholder="Station, piste, remontée, restaurant…"
          className="w-full bg-transparent text-[14px] text-snow placeholder:text-glacier-200/40 outline-none"
        />
        {q && (
          <button onClick={() => setQ('')} className="text-glacier-200/60 hover:text-snow">
            ×
          </button>
        )}
      </div>
      {focus && results.length > 0 && (
        <div className="glass absolute left-0 right-0 top-[calc(100%+6px)] max-h-[60vh] overflow-y-auto rounded-2xl p-1.5 scroll-thin animate-fade-up">
          {results.map((r) => (
            <button
              key={r.key}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(r.sel);
                setQ('');
              }}
              className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-white/10"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/5 text-[14px]">{r.icon}</span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{r.label}</span>
                <span className="block text-[11px] text-glacier-200/50">{r.sub}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
