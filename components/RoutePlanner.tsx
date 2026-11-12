'use client';
import { useEffect, useRef, useState } from 'react';
import type { DomainData } from '@/lib/types';
import { STATIONS } from '@/lib/stations';
import { DemSampler } from '@/lib/dem';
import { SkiGraph, type RouteResult } from '@/lib/routing';
import { DIFF_COLOR, LIFT_LABEL, fmtMin } from '@/lib/estimates';
import type { LiveStatus } from '@/lib/live';

interface Props {
  data: DomainData | null;
  live: LiveStatus | null;
  initialFrom?: string;
  onRoute: (r: RouteResult | null) => void;
  onClose: () => void;
}

// MNT basse résolution partagé pour orienter les pistes (sens de descente)
let routingDem: DemSampler | null = null;

export default function RoutePlanner({ data, live, initialFrom, onRoute, onClose }: Props) {
  const [from, setFrom] = useState(initialFrom ?? 'avoriaz');
  const [to, setTo] = useState('chatel');
  const [noBlack, setNoBlack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<RouteResult | null | 'none'>(null);
  const graphCache = useRef<Map<string, SkiGraph>>(new Map());

  useEffect(() => {
    if (initialFrom) setFrom(initialFrom);
  }, [initialFrom]);

  async function compute() {
    if (!data) return;
    setBusy(true);
    setRes(null);
    try {
      if (!routingDem) {
        routingDem = new DemSampler(12);
        await routingDem.preload(data.bbox);
      }
      const key = `${noBlack}`;
      let g = graphCache.current.get(key);
      if (!g) {
        const closedLifts = new Set<string>();
        const closedPistes = new Set<string>();
        if (live) {
          for (const l of data.lifts) if (live.lifts[`${l.sector}|${l.name}`] === 'ferme') closedLifts.add(l.id);
          for (const p of data.pistes) if (live.pistes[`${p.sector}|${p.name}`] === 'ferme') closedPistes.add(p.id);
        }
        await new Promise((r) => setTimeout(r, 20)); // laisse l'UI afficher le chargement
        g = new SkiGraph(data.pistes, data.lifts, (p) => routingDem!.sample(p), { avoid: noBlack ? ['noire', 'freeride'] : ['freeride'], closedLifts, closedPistes });
        graphCache.current.set(key, g);
      }
      const a = STATIONS.find((s) => s.id === from)!;
      const b = STATIONS.find((s) => s.id === to)!;
      const r = g.route(a.coord, b.coord);
      setRes(r ?? 'none');
      onRoute(r);
    } finally {
      setBusy(false);
    }
  }

  const sel = 'w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-[13px] outline-none';

  return (
    <div className="glass animate-fade-up pointer-events-auto w-full max-w-[380px] rounded-2xl p-4 space-y-3 max-h-[calc(100vh-120px)] overflow-y-auto scroll-thin">
      <div className="flex items-center justify-between">
        <div>
          <div className="label">Itinéraire skieur</div>
          <h2 className="text-lg font-bold">Rejoindre une station</h2>
        </div>
        <button
          onClick={() => {
            onRoute(null);
            onClose();
          }}
          className="h-8 w-8 rounded-full bg-white/5 hover:bg-white/15 text-lg"
        >
          ×
        </button>
      </div>
      <div className="space-y-2">
        <select className={sel} value={from} onChange={(e) => setFrom(e.target.value)}>
          {STATIONS.map((s) => (
            <option key={s.id} value={s.id} className="bg-anthracite-900">Départ : {s.name}</option>
          ))}
        </select>
        <select className={sel} value={to} onChange={(e) => setTo(e.target.value)}>
          {STATIONS.map((s) => (
            <option key={s.id} value={s.id} className="bg-anthracite-900">Arrivée : {s.name}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-[12px] text-glacier-100/80">
          <input type="checkbox" checked={noBlack} onChange={(e) => setNoBlack(e.target.checked)} /> Éviter les pistes noires
        </label>
        <button className="btn-primary w-full" disabled={busy || !data || from === to} onClick={compute}>
          {busy ? 'Calcul sur le graphe pistes + remontées…' : 'Calculer'}
        </button>
      </div>

      {res === 'none' && <p className="text-[13px] text-amber-200">Aucun itinéraire trouvé avec les données OSM disponibles (raccordement manquant ou options trop restrictives).</p>}
      {res && res !== 'none' && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between rounded-xl bg-electric-500/15 border border-electric-400/30 px-3 py-2">
            <span className="text-2xl font-bold">{fmtMin(res.minutes)}</span>
            <span className="text-[12px] text-glacier-100/70">{(res.lengthM / 1000).toFixed(1)} km · {res.steps.filter((s) => s.kind === 'lift').length} remontées</span>
          </div>
          <ol className="space-y-1">
            {res.steps.map((s, i) => (
              <li key={i} className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[12px]">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/5">
                  {s.kind === 'lift' ? '🚡' : s.kind === 'walk' ? '🚶' : <span className="h-2.5 w-2.5 rounded-full" style={{ background: DIFF_COLOR[s.difficulty ?? 'inconnue'] }} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.label}</span>
                  <span className="text-[10px] text-glacier-200/50">
                    {s.kind === 'lift' ? LIFT_LABEL[(s.liftKind ?? 'autre') as keyof typeof LIFT_LABEL] : s.kind === 'walk' ? 'à pied' : 'piste'} · {Math.round(s.lengthM)} m
                  </span>
                </span>
                <span className="text-glacier-100/70">{fmtMin(s.minutes)}</span>
              </li>
            ))}
          </ol>
          <p className="text-[10px] leading-snug text-glacier-200/40">
            Temps estimés (vitesse moyenne par couleur, 3 min d'attente par remontée). {live ? `Remontées fermées exclues (${live.source}).` : "État d'ouverture non disponible : vérifiez les remontées fermées sur place."}
          </p>
        </div>
      )}
    </div>
  );
}
