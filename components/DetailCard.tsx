'use client';
import { useEffect, useMemo, useState } from 'react';
import type { DomainData, Piste, Selection } from '@/lib/types';
import { sharedDem } from '@/lib/dem';
import { bboxOf, haversine } from '@/lib/geo';
import { DIFF_COLOR, DIFF_LABEL, LIFT_LABEL, descentMinutes, fmtMin, liftMinutes } from '@/lib/estimates';
import type { SectorWeather } from '@/lib/weather';
import { weatherLabel } from '@/lib/weather';
import type { LiveStatus } from '@/lib/live';

interface Props {
  sel: Selection;
  data: DomainData | null;
  weather: SectorWeather[] | null;
  live: LiveStatus | null;
  onClose: () => void;
  onSki: (p: Piste) => void;
  onRouteFrom: (stationId: string) => void;
}

interface Profile {
  top: number;
  bottom: number;
  drop: number;
  avgSlope: number;
  maxSlope: number;
  pts: { d: number; h: number }[];
  steep: number; // mètres de passages > 45 %
}

async function computeProfile(line: [number, number][]): Promise<Profile | null> {
  const dem = sharedDem();
  const [w, s, e, n] = bboxOf(line);
  const ok = await dem.preload([w - 0.002, s - 0.002, e + 0.002, n + 0.002]);
  if (!ok) return null;
  const pts: { d: number; h: number }[] = [];
  let d = 0;
  const step = 20;
  for (let i = 1; i < line.length; i++) {
    const seg = haversine(line[i - 1], line[i]);
    const nSub = Math.max(1, Math.ceil(seg / step));
    for (let k = i === 1 ? 0 : 1; k <= nSub; k++) {
      const t = k / nSub;
      const p: [number, number] = [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
      const h = dem.sample(p);
      if (h != null) pts.push({ d: d + seg * t, h });
    }
    d += seg;
  }
  if (pts.length < 2) return null;
  if (pts[0].h < pts[pts.length - 1].h) {
    const L = pts[pts.length - 1].d;
    pts.reverse();
    for (const p of pts) p.d = L - p.d;
  }
  let maxSlope = 0, steep = 0;
  for (let i = 0; i < pts.length; i++) {
    // pente sur une fenêtre d'environ 60 m
    let j = i;
    while (j < pts.length - 1 && pts[j].d - pts[i].d < 60) j++;
    const dd = pts[j].d - pts[i].d;
    if (dd < 30) continue;
    const sl = Math.abs(pts[i].h - pts[j].h) / dd;
    if (sl > maxSlope) maxSlope = sl;
    if (sl > 0.45 && i > 0) steep += pts[i].d - pts[i - 1].d;
  }
  const top = pts[0].h, bottom = pts[pts.length - 1].h;
  const L = pts[pts.length - 1].d;
  return { top, bottom, drop: top - bottom, avgSlope: L ? (top - bottom) / L : 0, maxSlope, pts, steep };
}

function Stat({ k, v, hint }: { k: string; v: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.04] border border-white/5 px-3 py-2">
      <div className="label">{k}</div>
      <div className="text-[15px] font-semibold text-snow mt-0.5">{v}</div>
      {hint && <div className="text-[10px] text-glacier-200/50 mt-0.5">{hint}</div>}
    </div>
  );
}

function ProfileChart({ p, color }: { p: Profile; color: string }) {
  const W = 320, H = 70;
  const L = p.pts[p.pts.length - 1].d;
  const min = Math.min(...p.pts.map((x) => x.h)), max = Math.max(...p.pts.map((x) => x.h));
  const sx = (d: number) => (d / L) * W;
  const sy = (h: number) => H - 6 - ((h - min) / Math.max(1, max - min)) * (H - 14);
  const path = p.pts.map((x, i) => `${i ? 'L' : 'M'}${sx(x.d).toFixed(1)},${sy(x.h).toFixed(1)}`).join('');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[70px]">
      <defs>
        <linearGradient id="pf" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.55" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path}L${W},${H}L0,${H}Z`} fill="url(#pf)" />
      <path d={path} fill="none" stroke={color === '#111827' ? '#e5e7eb' : color} strokeWidth="2" />
      <text x="4" y="12" fill="#a9d6ea" fontSize="10">{Math.round(max)} m</text>
      <text x={W - 4} y={H - 4} fill="#a9d6ea" fontSize="10" textAnchor="end">{Math.round(min)} m</text>
    </svg>
  );
}

const NA = <span className="text-glacier-200/50 font-normal text-[13px]">Non disponible</span>;

export default function DetailCard({ sel, data, weather, live, onClose, onSki, onRouteFrom }: Props) {
  const [profile, setProfile] = useState<Profile | null | 'loading'>('loading');
  const [liftAlt, setLiftAlt] = useState<[number | null, number | null] | null>(null);
  const [camOpen, setCamOpen] = useState(false);
  const [camLoadedAt, setCamLoadedAt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setProfile('loading');
    setLiftAlt(null);
    if (sel.type === 'piste') computeProfile(sel.item.line).then((p) => alive && setProfile(p));
    if (sel.type === 'lift') {
      const dem = sharedDem();
      const l = sel.item.line;
      Promise.all([dem.sampleAsync(l[0]), dem.sampleAsync(l[l.length - 1])]).then((a) => alive && setLiftAlt(a));
    }
    return () => {
      alive = false;
    };
  }, [sel]);

  const sectorWeather = useMemo(() => {
    const name = sel.type === 'station' ? sel.item.name : sel.item && 'sector' in sel.item ? sel.item.sector : null;
    return weather?.find((w) => w.name === name) ?? null;
  }, [sel, weather]);

  let header: React.ReactNode = null;
  let body: React.ReactNode = null;

  if (sel.type === 'piste') {
    const p = sel.item;
    const color = DIFF_COLOR[p.difficulty];
    const prof = profile === 'loading' ? null : profile;
    const state = live?.pistes[`${p.sector}|${p.name}`];
    header = (
      <div className="flex items-start gap-3">
        <div className="mt-1 h-9 w-9 shrink-0 rounded-xl border-2 border-white/80" style={{ background: color }} />
        <div className="min-w-0">
          <div className="label">Piste · {p.sector}</div>
          <h2 className="text-xl font-bold leading-tight truncate">{p.name}</h2>
          <div className="chip mt-1 bg-white/10" style={{ color: p.difficulty === 'noire' ? '#e5e7eb' : color }}>
            {DIFF_LABEL[p.difficulty]}
          </div>
        </div>
      </div>
    );
    body = (
      <>
        <div className="grid grid-cols-2 gap-2">
          <Stat k="Longueur" v={`${p.lengthM.toLocaleString('fr-FR')} m`} hint="tracé OSM" />
          <Stat k="Dénivelé" v={prof ? `${Math.round(prof.drop)} m` : profile === 'loading' ? '…' : NA} hint="calcul MNT" />
          <Stat k="Départ" v={prof ? `${Math.round(prof.top)} m` : profile === 'loading' ? '…' : NA} />
          <Stat k="Arrivée" v={prof ? `${Math.round(prof.bottom)} m` : profile === 'loading' ? '…' : NA} />
          <Stat k="Temps moyen" v={fmtMin(descentMinutes(p.lengthM, p.difficulty))} hint="estimation skieur moyen" />
          <Stat k="Pente moy. / max" v={prof ? `${Math.round(prof.avgSlope * 100)} % / ${Math.round(prof.maxSlope * 100)} %` : '…'} hint="sur 60 m, MNT ~20 m" />
          <Stat k="État" v={state ?? NA} hint={state ? live?.source : 'flux officiel non branché'} />
          <Stat
            k="Neige (secteur)"
            v={sectorWeather?.snowDepthCm != null ? `${sectorWeather.snowDepthCm} cm` : NA}
            hint={sectorWeather ? `+${sectorWeather.snowfall24hCm} cm/24 h · modèle Open-Meteo` : undefined}
          />
        </div>
        {prof && <ProfileChart p={prof} color={color} />}
        {prof && prof.steep > 0 && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-100">
            ⚠️ Passages raides (&gt; 45 %) sur environ {Math.round(prof.steep)} m — calcul d'après le relief, à confirmer sur place.
          </div>
        )}
        {p.difficulty === 'freeride' && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-100">
            Itinéraire non damé / hors-piste : information uniquement. Matériel DVA-pelle-sonde et connaissance du risque d'avalanche indispensables.
          </div>
        )}
        <button className="btn-primary w-full py-3.5 text-[15px] font-bold tracking-wide pulse-ring" onClick={() => onSki(p)}>
          ⛷️ SKIER CETTE PISTE
        </button>
        <div className="text-[10px] text-glacier-200/40">
          OSM : {p.osmIds.slice(0, 4).map((id) => `#${id}`).join(', ')}
          {p.osmIds.length > 4 ? '…' : ''} {p.grooming ? `· damage : ${p.grooming}` : ''}
        </div>
      </>
    );
  } else if (sel.type === 'lift') {
    const l = sel.item;
    const t = liftMinutes(l);
    const state = live?.lifts[`${l.sector}|${l.name}`];
    const [a, b] = liftAlt ?? [null, null];
    const lo = a != null && b != null ? Math.min(a, b) : null;
    const hi = a != null && b != null ? Math.max(a, b) : null;
    header = (
      <div className="flex items-start gap-3">
        <div className="mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-anthracite-700 text-lg">🚡</div>
        <div className="min-w-0">
          <div className="label">{LIFT_LABEL[l.kind]} · {l.sector}</div>
          <h2 className="text-xl font-bold leading-tight truncate">{l.name}</h2>
        </div>
      </div>
    );
    body = (
      <div className="grid grid-cols-2 gap-2">
        <Stat k="Type" v={LIFT_LABEL[l.kind]} hint={`aerialway=${l.osmKind}`} />
        <Stat k="Longueur" v={`${l.lengthM.toLocaleString('fr-FR')} m`} />
        <Stat k="Altitude départ" v={lo != null ? `${Math.round(lo)} m` : '…'} hint="MNT" />
        <Stat k="Altitude arrivée" v={hi != null ? `${Math.round(hi)} m` : '…'} hint="MNT" />
        <Stat k="Temps de montée" v={fmtMin(t.minutes)} hint={t.estimated ? 'estimation (vitesse type)' : 'donnée OSM'} />
        <Stat k="Débit" v={l.capacity ? `${l.capacity} pers./h` : NA} />
        <Stat k="État" v={state ?? NA} hint={state ? live?.source : 'flux officiel non branché'} />
        <Stat k="Horaires" v={l.openingHours ?? NA} />
      </div>
    );
  } else if (sel.type === 'poi') {
    const x = sel.item;
    const kindLabel: Record<string, string> = {
      restaurant: "Restaurant d'altitude",
      bar: 'Bar / terrasse',
      snowpark: 'Snowpark',
      viewpoint: 'Point panoramique',
      hut: 'Refuge',
      webcam: 'Webcam (OSM)',
      debutant: 'Zone débutants',
      freeride: 'Hors-piste — information',
      repos: 'Espace de repos',
    };
    header = (
      <div>
        <div className="label">{kindLabel[x.kind]} · {x.sector}</div>
        <h2 className="text-xl font-bold leading-tight">{x.name}</h2>
      </div>
    );
    const web = x.tags.website || x.tags['contact:website'] || x.tags['contact:webcam'];
    body = (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Stat k="Altitude" v={x.ele ? `${Math.round(x.ele)} m` : NA} />
          <Stat k="Horaires" v={x.tags.opening_hours ?? NA} />
          {x.tags.cuisine && <Stat k="Cuisine" v={x.tags.cuisine.replace(/;/g, ', ')} />}
          {(x.tags.phone || x.tags['contact:phone']) && <Stat k="Téléphone" v={x.tags.phone || x.tags['contact:phone']} />}
        </div>
        {web && (
          <a href={web} target="_blank" rel="noreferrer" className="btn-ghost w-full">
            Site web ↗
          </a>
        )}
        {x.kind === 'freeride' && (
          <p className="text-[12px] text-amber-100/90">Information uniquement — le hors-piste n'est ni balisé ni sécurisé.</p>
        )}
      </div>
    );
  } else if (sel.type === 'webcam') {
    const c = sel.item;
    header = (
      <div>
        <div className="label">Webcam {c.provider ? `· ${c.provider}` : ''}</div>
        <h2 className="text-xl font-bold leading-tight">{c.name}</h2>
      </div>
    );
    const media = c.embedUrl ? (
      <iframe src={c.embedUrl} className="h-full w-full rounded-xl" allow="fullscreen" />
    ) : c.imageUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`${c.imageUrl}${c.imageUrl.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 60000)}`} alt={c.name} className="h-full w-full rounded-xl object-cover" onLoad={() => setCamLoadedAt(new Date().toLocaleTimeString('fr-FR'))} />
    ) : null;
    body = (
      <div className="space-y-2">
        {media ? (
          <div className="relative aspect-video">
            {media}
            <button className="absolute right-2 top-2 btn-ghost px-2 py-1 text-xs" onClick={() => setCamOpen(true)}>⤢ Agrandir</button>
          </div>
        ) : (
          <div className="rounded-xl bg-white/5 p-3 text-[13px] text-glacier-100/80">
            Flux non intégrable ici : consultez la page officielle.
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Stat k="Altitude" v={c.alt ? `${c.alt} m` : NA} />
          <Stat k="Actualisation" v={camLoadedAt ?? (media ? '…' : NA)} hint="heure de chargement de l'image" />
        </div>
        <a href={c.pageUrl} target="_blank" rel="noreferrer" className="btn-ghost w-full">Page officielle ↗</a>
        {camOpen && media && (
          <div className="fixed inset-0 z-[80] bg-black/90 p-4 md:p-10" onClick={() => setCamOpen(false)}>
            <div className="h-full w-full">{media}</div>
          </div>
        )}
      </div>
    );
  } else if (sel.type === 'station') {
    const s = sel.item;
    const nPistes = data?.pistes.filter((p) => p.sector === s.name).length ?? 0;
    const nLifts = data?.lifts.filter((l) => l.sector === s.name).length ?? 0;
    const w = sectorWeather;
    header = (
      <div>
        <div className="label">Station · {s.country === 'CH' ? 'Suisse' : 'France'}</div>
        <h2 className="text-2xl font-bold leading-tight">{s.name}</h2>
      </div>
    );
    body = (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Stat k="Altitude village" v={`${s.alt} m`} />
          <Stat k="Météo" v={w ? `${weatherLabel(w.weatherCode).icon} ${Math.round(w.temperature)}°C` : '…'} hint={w ? weatherLabel(w.weatherCode).label : undefined} />
          <Stat k="Tronçons de pistes" v={nPistes} hint="secteur le plus proche, OSM" />
          <Stat k="Remontées" v={nLifts} hint="OSM" />
        </div>
        <button className="btn-ghost w-full" onClick={() => onRouteFrom(s.id)}>🧭 Itinéraire depuis {s.name}</button>
      </div>
    );
  }

  return (
    <div className="glass animate-fade-up pointer-events-auto w-full max-w-[380px] rounded-2xl p-4 space-y-3 max-h-[calc(100vh-120px)] overflow-y-auto scroll-thin">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">{header}</div>
        <button onClick={onClose} className="h-8 w-8 shrink-0 rounded-full bg-white/5 hover:bg-white/15 text-lg leading-none" aria-label="Fermer">
          ×
        </button>
      </div>
      {body}
    </div>
  );
}
