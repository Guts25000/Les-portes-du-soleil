'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import MapView, { DEFAULT_FILTERS, type Basemap, type Filters } from './MapView';
import Sidebar from './Sidebar';
import SearchBar from './SearchBar';
import DetailCard from './DetailCard';
import RoutePlanner from './RoutePlanner';
import ChampionshipPanel from './ChampionshipPanel';
import { matchSector } from '@/lib/sectorMatch';
import { loadChamp, medalTargets, recordRun, saveChamp, type ChampState, type MedalTargets } from '@/lib/championship';
import type { DomainData, Piste, Selection, Webcam } from '@/lib/types';
import type { WeatherPayload } from '@/lib/weather';
import type { RouteResult } from '@/lib/routing';
import { fetchAvalanche, fetchLiveStatus, type AvalancheBulletin, type LiveStatus } from '@/lib/live';
import { WEBCAMS } from '@/data/webcams';
import { loadDomain, loadWeather } from '@/lib/clientData';

const SkiSimulator = dynamic(() => import('./SkiSimulator'), { ssr: false });

export default function App() {
  const [data, setData] = useState<DomainData | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataStatus, setDataStatus] = useState('Chargement des pistes OpenStreetMap…');
  const [weather, setWeather] = useState<WeatherPayload | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [avalanche, setAvalanche] = useState<AvalancheBulletin[] | null>(null);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [basemap, setBasemap] = useState<Basemap>('satellite');
  const [mode3d, setMode3d] = useState(true);
  const [sidebar, setSidebar] = useState(false);
  const [intro, setIntro] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<{ sel: Selection; nonce: number } | null>(null);
  const [routeOpen, setRouteOpen] = useState(false);
  const [routeFrom, setRouteFrom] = useState<string | undefined>();
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [skiing, setSkiing] = useState<{ piste: Piste; targets?: MedalTargets } | null>(null);
  const [champOpen, setChampOpen] = useState(false);
  const [champ, setChamp] = useState<ChampState>(() => loadChamp());
  const sectorEntries = useMemo(() => matchSector(data), [data]);
  const openChamp = () => {
    setSelection(null);
    setRouteOpen(false);
    setChampOpen(true);
    if (window.innerWidth < 768) setSidebar(false);
  };

  // Webcams : configuration manuelle + webcams taguées dans OSM
  const webcams: Webcam[] = WEBCAMS;

  useEffect(() => {
    loadDomain(setDataStatus)
      .then(setData)
      .catch((e) => setDataError(`Données OSM indisponibles : ${e.message}. Réessayez dans quelques minutes (serveurs Overpass parfois saturés).`));
    const refreshWeather = () =>
      loadWeather()
        .then((w) => {
          setWeather(w);
          setWeatherError(null);
        })
        .catch((e) => setWeatherError(`Météo indisponible (${e.message})`));
    refreshWeather();
    const t = setInterval(refreshWeather, 15 * 60_000);
    fetchLiveStatus().then(setLive);
    fetchAvalanche().then(setAvalanche);
    return () => clearInterval(t);
  }, []);

  const select = useCallback((s: Selection, fly = false) => {
    setSelection(s);
    setRouteOpen(false);
    setChampOpen(false);
    if (fly) setFocus({ sel: s, nonce: Date.now() });
  }, []);

  const explore = () => {
    setIntro(false);
    if (window.innerWidth >= 768) setSidebar(true);
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-anthracite-950">
      <MapView
        data={data}
        webcams={webcams}
        filters={filters}
        mode3d={mode3d}
        basemap={basemap}
        selection={selection}
        focus={focus}
        route={route}
        intro={intro}
        onSelect={(s) => select(s, s.type === 'station')}
      />

      {/* Introduction */}
      {intro && (
        <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-end bg-gradient-to-t from-anthracite-950/90 via-anthracite-950/20 to-transparent pb-16 md:pb-24">
          <div className="animate-fade-up text-center" style={{ animationDelay: '0.6s' }}>
            <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.5em] text-glacier-300">France · Suisse · 12 stations</div>
            <h1 className="text-4xl font-extrabold tracking-tight text-snow drop-shadow-2xl md:text-7xl">
              Les Portes <span className="bg-gradient-to-r from-glacier-200 to-electric-400 bg-clip-text text-transparent">du Soleil</span>
            </h1>
            <p className="mx-auto mt-4 max-w-md px-6 text-sm text-glacier-100/80 md:text-base">
              Explorez le domaine en 3D sur le relief réel, consultez les conditions et descendez les vraies pistes.
            </p>
            <button onClick={explore} className="btn-primary pointer-events-auto mt-8 rounded-2xl px-8 py-4 text-base font-bold tracking-wide">
              Explorer le domaine →
            </button>
            <div className="mt-4 text-[11px] text-glacier-200/50">{data ? `${data.pistes.length} tronçons de pistes · ${data.lifts.length} remontées chargés` : dataError ? '⚠️ ' + dataError : dataStatus}</div>
          </div>
        </div>
      )}

      {!intro && (
        <div className="pointer-events-none absolute inset-0 z-10">
          <Sidebar
            open={sidebar}
            onToggle={() => setSidebar((v) => !v)}
            data={data}
            dataError={dataError}
            weather={weather}
            weatherError={weatherError}
            live={live}
            avalanche={avalanche}
            filters={filters}
            setFilters={setFilters}
            basemap={basemap}
            setBasemap={setBasemap}
            mode3d={mode3d}
            setMode3d={setMode3d}
            onOpenChampionship={openChamp}
            onOpenRoute={() => {
              setSelection(null);
              setChampOpen(false);
              setRouteOpen(true);
              if (window.innerWidth < 768) setSidebar(false);
            }}
          />

          <div className={`absolute top-3 flex justify-center px-3 transition-all duration-500 left-16 right-3 md:right-auto md:left-1/2 md:w-[440px] md:-translate-x-1/2`}>
            <SearchBar data={data} webcams={webcams} onPick={(s) => select(s, true)} />
          </div>

          {/* Boutons rapides */}
          <div className="pointer-events-auto absolute bottom-6 left-1/2 flex -translate-x-1/2 gap-2 md:bottom-4">
            <button className="glass btn rounded-xl !border-amber-300/40" onClick={openChamp}>
              🏆 <span className="hidden sm:inline">Championnat</span>
            </button>
            <button className={`glass btn rounded-xl ${mode3d ? '!bg-electric-500/80' : ''}`} onClick={() => setMode3d(!mode3d)}>
              {mode3d ? '3D' : '2D'}
            </button>
            <button
              className="glass btn rounded-xl"
              onClick={() => {
                setSelection(null);
                setChampOpen(false);
                setRouteOpen(true);
              }}
            >
              🧭 <span className="hidden sm:inline">Itinéraire</span>
            </button>
            <button className="glass btn rounded-xl" onClick={() => setBasemap(basemap === 'satellite' ? 'topo' : 'satellite')}>
              🗺️ <span className="hidden sm:inline">{basemap === 'satellite' ? 'Topo' : 'Satellite'}</span>
            </button>
          </div>

          {/* Panneau de détail / itinéraire */}
          <div className="absolute bottom-20 left-3 right-3 flex justify-center md:bottom-auto md:left-auto md:right-14 md:top-3 md:justify-end">
            {selection && !routeOpen && (
              <DetailCard
                key={selection.type + (('id' in selection.item && selection.item.id) || '')}
                sel={selection}
                data={data}
                weather={weather?.sectors ?? null}
                live={live}
                onClose={() => setSelection(null)}
                onSki={(p) => setSkiing({ piste: p })}
                onRouteFrom={(id) => {
                  setRouteFrom(id);
                  setSelection(null);
                  setRouteOpen(true);
                }}
              />
            )}
            {champOpen && (
              <ChampionshipPanel
                entries={sectorEntries}
                champ={champ}
                loading={!data && !dataError}
                onClose={() => setChampOpen(false)}
                onShow={(p) => select({ type: 'piste', item: p }, true)}
                onSki={(e) => e.piste && setSkiing({ piste: e.piste, targets: medalTargets(e.piste.lengthM, e.difficulty) })}
              />
            )}
            {routeOpen && <RoutePlanner data={data} live={live} initialFrom={routeFrom} onRoute={setRoute} onClose={() => setRouteOpen(false)} />}
          </div>
        </div>
      )}

      {skiing && data && (
        <SkiSimulator
          piste={skiing.piste}
          domain={data}
          targets={skiing.targets}
          onExit={() => setSkiing(null)}
          onRun={
            skiing.targets
              ? (r) => {
                  const targets = skiing.targets!;
                  setChamp((prev) => {
                    const next = recordRun(prev, skiing.piste.id, r.timeS, r.score, targets).state;
                    saveChamp(next);
                    return next;
                  });
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
