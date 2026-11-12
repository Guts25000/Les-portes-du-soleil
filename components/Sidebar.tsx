'use client';
import { useState } from 'react';
import type { DomainData } from '@/lib/types';
import type { WeatherPayload } from '@/lib/weather';
import { weatherLabel } from '@/lib/weather';
import type { AvalancheBulletin, LiveStatus } from '@/lib/live';
import { OFFICIAL_LINKS } from '@/lib/live';
import type { Basemap, Filters } from './MapView';
import { DIFF_COLOR } from '@/lib/estimates';

interface Props {
  open: boolean;
  onToggle: () => void;
  data: DomainData | null;
  dataError: string | null;
  weather: WeatherPayload | null;
  weatherError: string | null;
  live: LiveStatus | null;
  avalanche: AvalancheBulletin[] | null;
  filters: Filters;
  setFilters: (f: Filters) => void;
  basemap: Basemap;
  setBasemap: (b: Basemap) => void;
  mode3d: boolean;
  setMode3d: (b: boolean) => void;
  onOpenRoute: () => void;
}

const windDir = (d: number) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(d / 45) % 8];

function Toggle({ on, onClick, children, color }: { on: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[12px] font-medium transition ${
        on ? 'border-white/20 bg-white/10 text-snow' : 'border-white/5 bg-transparent text-glacier-200/40'
      }`}
    >
      {color && <span className="h-2.5 w-2.5 rounded-full border border-white/60" style={{ background: on ? color : 'transparent' }} />}
      {children}
    </button>
  );
}

export default function Sidebar(p: Props) {
  const [sector, setSector] = useState<string>('avoriaz');
  const w = p.weather?.sectors.find((s) => s.stationId === sector) ?? p.weather?.sectors[0];
  const f = p.filters;
  const tog = (k: keyof Filters) => p.setFilters({ ...f, [k]: !f[k] });
  const named = p.data ? new Set(p.data.pistes.filter((x) => x.named).map((x) => `${x.sector}|${x.name}`)).size : 0;

  return (
    <>
      <button
        onClick={p.onToggle}
        className="glass pointer-events-auto absolute left-3 top-3 z-30 grid h-11 w-11 place-items-center rounded-xl text-lg md:hidden"
        aria-label="Panneau"
      >
        {p.open ? '×' : '☰'}
      </button>
      <aside
        className={`glass pointer-events-auto absolute z-20 flex flex-col rounded-2xl transition-transform duration-500 ease-[cubic-bezier(.2,.8,.2,1)]
        left-3 top-16 bottom-3 w-[calc(100vw-24px)] max-w-[340px] md:top-3
        ${p.open ? 'translate-x-0' : '-translate-x-[calc(100%+24px)]'}`}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-glacier-300">Les Portes du Soleil</div>
            <div className="text-[17px] font-bold">Conditions du domaine</div>
          </div>
          <button onClick={p.onToggle} className="hidden h-8 w-8 rounded-full bg-white/5 hover:bg-white/15 md:block" aria-label="Replier">
            ‹
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4 scroll-thin">
          {/* Météo */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="label">Météo par secteur</span>
              {p.weather && <span className="text-[10px] text-glacier-200/40">{new Date(p.weather.fetchedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>}
            </div>
            {p.weatherError && <div className="text-[12px] text-red-300">{p.weatherError}</div>}
            {!p.weather && !p.weatherError && <div className="h-28 animate-pulse rounded-xl bg-white/5" />}
            {w && (
              <div className="rounded-2xl bg-gradient-to-br from-glacier-500/25 to-electric-600/10 border border-white/10 p-3">
                <select
                  value={w.stationId}
                  onChange={(e) => setSector(e.target.value)}
                  className="mb-1 w-full bg-transparent text-[13px] font-semibold outline-none"
                >
                  {p.weather!.sectors.map((s) => (
                    <option key={s.stationId} value={s.stationId} className="bg-anthracite-900">
                      {s.name} ({s.alt} m)
                    </option>
                  ))}
                </select>
                <div className="flex items-end justify-between">
                  <div className="text-4xl font-light">{Math.round(w.temperature)}°</div>
                  <div className="text-right">
                    <div className="text-3xl">{weatherLabel(w.weatherCode).icon}</div>
                    <div className="text-[12px] text-glacier-100/80">{weatherLabel(w.weatherCode).label}</div>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
                  {[
                    ['Ressenti', `${Math.round(w.apparent)}°`],
                    ['Vent', `${Math.round(w.windSpeed)} km/h ${windDir(w.windDir)}`],
                    ['Rafales', `${Math.round(w.windGusts)} km/h`],
                    ['Visibilité', w.visibilityM != null ? (w.visibilityM >= 10000 ? '> 10 km' : `${(w.visibilityM / 1000).toFixed(1)} km`) : '—'],
                    ['Neige au sol', w.snowDepthCm != null ? `${w.snowDepthCm} cm` : '—'],
                    ['Iso 0 °C', w.freezingLevelM != null ? `${Math.round(w.freezingLevelM / 50) * 50} m` : '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-black/20 px-1 py-1.5">
                      <div className="text-[9px] uppercase tracking-wider text-glacier-200/60">{k}</div>
                      <div className="text-[12px] font-semibold">{v}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex justify-between text-[11px] text-glacier-100/80">
                  <span>❄️ 24 h : <b>{w.snowfall24hCm} cm</b></span>
                  <span>72 h : <b>{w.snowfall72hCm} cm</b></span>
                </div>
              </div>
            )}
            {p.weather && (
              <div className="grid grid-cols-2 gap-1">
                {p.weather.sectors.map((s) => (
                  <button
                    key={s.stationId}
                    onClick={() => setSector(s.stationId)}
                    className={`flex items-center justify-between rounded-lg px-2 py-1 text-[11px] ${s.stationId === w?.stationId ? 'bg-white/10' : 'bg-white/[0.03] hover:bg-white/[0.07]'}`}
                  >
                    <span className="truncate text-glacier-100/80">{s.name}</span>
                    <span className="font-semibold">{Math.round(s.temperature)}°</span>
                  </button>
                ))}
              </div>
            )}
            {p.weather && <p className="text-[10px] leading-snug text-glacier-200/40">{p.weather.source}</p>}
          </section>

          {/* Domaine */}
          <section className="space-y-2">
            <span className="label">Domaine</span>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-white/[0.04] p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-glacier-200/60">Pistes ouvertes</div>
                <div className="text-[18px] font-bold">{p.live ? `${p.live.pistesOpen}/${p.live.pistesTotal}` : '—'}</div>
                <div className="text-[10px] text-glacier-200/40">{p.live ? p.live.source : `${named} pistes nommées dans OSM`}</div>
              </div>
              <div className="rounded-xl bg-white/[0.04] p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-glacier-200/60">Remontées ouvertes</div>
                <div className="text-[18px] font-bold">{p.live ? `${p.live.liftsOpen}/${p.live.liftsTotal}` : '—'}</div>
                <div className="text-[10px] text-glacier-200/40">{p.live ? p.live.source : `${p.data?.lifts.length ?? '…'} remontées dans OSM`}</div>
              </div>
            </div>
            <div className="rounded-xl bg-white/[0.04] p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-glacier-200/60">Risque d'avalanche</div>
              {p.avalanche?.length ? (
                p.avalanche.map((b) => (
                  <div key={b.massif} className="mt-1 flex justify-between text-[13px]">
                    <span>{b.massif}</span>
                    <b>{b.risk}/5</b>
                  </div>
                ))
              ) : (
                <div className="mt-1 text-[12px] text-glacier-100/70">
                  Bulletin officiel non branché — consultez :
                  <div className="mt-1 flex flex-col gap-0.5">
                    {OFFICIAL_LINKS.map((l) => (
                      <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="text-glacier-300 hover:underline">
                        {l.label} ↗
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {!p.live && (
              <p className="text-[10px] leading-snug text-glacier-200/40">
                L'ouverture en temps réel nécessite le flux de l'exploitant (voir <code>lib/live.ts</code>). Aucune valeur n'est inventée.
              </p>
            )}
          </section>

          {/* Affichage */}
          <section className="space-y-2">
            <span className="label">Affichage</span>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="col-span-2 flex rounded-xl bg-white/5 p-1">
                {(['satellite', 'topo'] as Basemap[]).map((b) => (
                  <button key={b} onClick={() => p.setBasemap(b)} className={`flex-1 rounded-lg py-1.5 text-[12px] font-medium ${p.basemap === b ? 'bg-white/15' : 'text-glacier-200/60'}`}>
                    {b === 'satellite' ? 'Satellite' : 'Topographique'}
                  </button>
                ))}
              </div>
              <div className="col-span-2 flex rounded-xl bg-white/5 p-1">
                {[true, false].map((b) => (
                  <button key={String(b)} onClick={() => p.setMode3d(b)} className={`flex-1 rounded-lg py-1.5 text-[12px] font-medium ${p.mode3d === b ? 'bg-electric-500/80' : 'text-glacier-200/60'}`}>
                    {b ? 'Vue 3D' : 'Vue 2D'}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <span className="label">Filtres</span>
            <div className="flex flex-wrap gap-1.5">
              <Toggle on={f.verte} onClick={() => tog('verte')} color={DIFF_COLOR.verte}>Vertes</Toggle>
              <Toggle on={f.bleue} onClick={() => tog('bleue')} color={DIFF_COLOR.bleue}>Bleues</Toggle>
              <Toggle on={f.rouge} onClick={() => tog('rouge')} color={DIFF_COLOR.rouge}>Rouges</Toggle>
              <Toggle on={f.noire} onClick={() => tog('noire')} color="#e5e7eb">Noires</Toggle>
              <Toggle on={f.freeride} onClick={() => tog('freeride')} color={DIFF_COLOR.freeride}>Itinéraires</Toggle>
              <Toggle on={f.lifts} onClick={() => tog('lifts')}>🚡 Remontées</Toggle>
              <Toggle on={f.webcams} onClick={() => tog('webcams')}>📷 Webcams</Toggle>
              <Toggle on={f.restaurants} onClick={() => tog('restaurants')}>🍽️ Restaurants</Toggle>
              <Toggle on={f.snowparks} onClick={() => tog('snowparks')}>🏂 Snowparks</Toggle>
              <Toggle on={f.pois} onClick={() => tog('pois')}>🔭 Points d'intérêt</Toggle>
            </div>
          </section>

          <button className="btn-ghost w-full" onClick={p.onOpenRoute}>🧭 Calculer un itinéraire</button>

          <section className="space-y-1 border-t border-white/5 pt-3 text-[10px] leading-snug text-glacier-200/40">
            <div className="label !text-[9px]">Sources</div>
            {p.dataError ? <div className="text-red-300">{p.dataError}</div> : <div>Pistes, remontées, POI : © contributeurs OpenStreetMap (ODbL){p.data ? ` — ${new Date(p.data.generatedAt).toLocaleDateString('fr-FR')}` : ''}</div>}
            <div>Relief : AWS Terrain Tiles · Imagerie : Esri · Topo : OpenTopoMap</div>
            <div>Météo : Open-Meteo (modèles)</div>
          </section>
        </div>
      </aside>
      {!p.open && (
        <button onClick={p.onToggle} className="glass pointer-events-auto absolute left-3 top-3 z-20 hidden h-11 rounded-xl px-3 text-sm md:flex md:items-center md:gap-2">
          ☰ Conditions
        </button>
      )}
    </>
  );
}
