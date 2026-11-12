'use client';
import { useMemo, useState } from 'react';
import type { Piste } from '@/lib/types';
import type { SectorEntry } from '@/lib/sectorMatch';
import { DIFF_COLOR, DIFF_LABEL } from '@/lib/estimates';
import { MEDAL_ICON, UNLOCK, isUnlocked, medalTargets, totals, type ChampState } from '@/lib/championship';
import { fmtTime } from '@/lib/scores';
import { SECTOR_SOURCES, ZONES, type Zone } from '@/data/morzineLesGets';

interface Props {
  entries: SectorEntry[];
  champ: ChampState;
  loading: boolean;
  onClose: () => void;
  onSki: (e: SectorEntry) => void;
  onShow: (p: Piste) => void;
}

type Filter = 'toutes' | 'a-faire' | 'manquantes';

export default function ChampionshipPanel({ entries, champ, loading, onClose, onSki, onShow }: Props) {
  const [zone, setZone] = useState<Zone | 'all'>('all');
  const [filter, setFilter] = useState<Filter>('toutes');
  const playable = entries.filter((e) => e.piste);
  const t = totals(champ, playable.map((e) => e.piste!.id));
  const missing = entries.length - playable.length;

  const list = useMemo(
    () =>
      entries.filter((e) => {
        if (zone !== 'all' && e.zone !== zone) return false;
        if (filter === 'manquantes') return !e.piste;
        if (filter === 'a-faire') return !!e.piste && !champ[e.piste.id]?.medal;
        return true;
      }),
    [entries, zone, filter, champ],
  );

  const nextUnlock = (['rouge', 'noire'] as const).find((d) => !isUnlocked(d, t.points));

  return (
    <div className="glass animate-fade-up pointer-events-auto flex w-full max-w-[400px] flex-col rounded-2xl max-h-[calc(100vh-110px)]">
      <div className="space-y-3 p-4 pb-2">
        <div className="flex items-start justify-between">
          <div>
            <div className="label">Forfait Morzine – Les Gets</div>
            <h2 className="text-lg font-bold leading-tight">🏆 Championnat Pleney · Nyon · Les Gets</h2>
          </div>
          <button onClick={onClose} className="h-8 w-8 shrink-0 rounded-full bg-white/5 text-lg hover:bg-white/15">×</button>
        </div>

        <div className="rounded-xl border border-electric-400/30 bg-gradient-to-br from-electric-500/20 to-glacier-500/10 p-3">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-3xl font-black tabular-nums">{t.points}<span className="text-base font-semibold text-glacier-200/60"> / {t.max} pts</span></div>
              <div className="text-[12px] text-glacier-100/80">🥇 {t.or} · 🥈 {t.argent} · 🥉 {t.bronze} · {t.done}/{playable.length} pistes descendues</div>
            </div>
            <div className="text-right text-[11px] text-glacier-100/70">
              Score cumulé<br />
              <b className="text-[14px] text-snow">{t.score.toLocaleString('fr-FR')}</b>
            </div>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-gradient-to-r from-amber-300 to-electric-400" style={{ width: `${(t.points / Math.max(1, t.max)) * 100}%` }} />
          </div>
          <div className="mt-1.5 text-[11px] text-glacier-100/70">
            {nextUnlock ? `🔒 Pistes ${nextUnlock}s débloquées à ${UNLOCK[nextUnlock]} points` : '🔓 Toutes les pistes sont débloquées'}
          </div>
        </div>

        <div className="flex gap-1 overflow-x-auto pb-1 scroll-thin">
          {(['all', ...ZONES.map((z) => z.zone)] as const).map((z) => (
            <button
              key={z}
              onClick={() => setZone(z)}
              className={`shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-medium ${zone === z ? 'bg-white/15' : 'bg-white/[0.04] text-glacier-200/60 hover:bg-white/10'}`}
            >
              {z === 'all' ? 'Tout' : z}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg bg-white/5 p-0.5 text-[11px]">
          {(
            [
              ['toutes', 'Toutes'],
              ['a-faire', 'Sans médaille'],
              ['manquantes', `Tracé manquant (${missing})`],
            ] as [Filter, string][]
          ).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={`flex-1 rounded-md py-1 ${filter === k ? 'bg-white/15' : 'text-glacier-200/60'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto px-4 pb-3 scroll-thin">
        {loading && <div className="h-24 animate-pulse rounded-xl bg-white/5" />}
        {!loading &&
          list.map((e) => {
            const p = e.piste;
            const rec = p ? champ[p.id] : undefined;
            const locked = !isUnlocked(e.difficulty, t.points);
            const targets = p ? medalTargets(p.lengthM, e.difficulty) : null;
            return (
              <div key={e.zone + e.official.name} className={`rounded-xl border px-2.5 py-2 ${p ? 'border-white/5 bg-white/[0.03]' : 'border-dashed border-white/10 bg-transparent'}`}>
                <div className="flex items-center gap-2.5">
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/70"
                    style={{ background: DIFF_COLOR[e.difficulty] }}
                    title={`${DIFF_LABEL[e.difficulty]} — couleur ${e.colorSource}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold">{e.official.name}</span>
                      {rec?.medal && <span>{MEDAL_ICON[rec.medal]}</span>}
                    </div>
                    <div className="text-[10px] text-glacier-200/50">
                      {e.zone}
                      {p ? ` · ${(p.lengthM / 1000).toFixed(1)} km` : ' · tracé absent d’OSM'}
                      {rec ? ` · record ${fmtTime(rec.bestTime)}` : targets ? ` · 🥇 < ${fmtTime(targets.or)}` : ''}
                      {e.colorMismatch && ' · ⚠️ couleur OSM différente'}
                    </div>
                  </div>
                  {p && (
                    <button onClick={() => onShow(p)} className="rounded-lg bg-white/5 px-2 py-1 text-[11px] hover:bg-white/15" title="Voir sur la carte">
                      📍
                    </button>
                  )}
                  {p && (
                    <button
                      disabled={locked}
                      onClick={() => onSki(e)}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ${locked ? 'bg-white/5 text-glacier-200/40' : 'bg-electric-500 text-white hover:bg-electric-400'}`}
                      title={locked ? `Débloquée à ${UNLOCK[e.difficulty]} points` : 'Skier'}
                    >
                      {locked ? '🔒' : '⛷️ Skier'}
                    </button>
                  )}
                </div>
                {e.official.note && <div className="mt-1 text-[10px] text-amber-200/70">{e.official.note}</div>}
              </div>
            );
          })}
        {!loading && !list.length && <div className="py-6 text-center text-[12px] text-glacier-200/50">Aucune piste pour ce filtre.</div>}
      </div>

      <div className="space-y-0.5 border-t border-white/5 px-4 py-2 text-[10px] leading-snug text-glacier-200/40">
        <div>
          Liste : pages officielles d'ouverture des pistes ({entries.length} pistes). Tracés GPS : OpenStreetMap, rapprochés par le nom.
          Médailles : temps cibles calculés sur la longueur réelle du tracé.
        </div>
        <div className="flex flex-wrap gap-x-2">
          {SECTOR_SOURCES.map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="text-glacier-300/70 hover:underline">
              {s.label} ↗
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
