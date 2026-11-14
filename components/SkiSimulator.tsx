'use client';
import { useEffect, useRef, useState } from 'react';
import type { DomainData, Piste } from '@/lib/types';
import { SkiGame, type GameResult, type Hud } from '@/game/SkiGame';
import type { Input } from '@/game/physics';
import { DIFF_COLOR, DIFF_LABEL } from '@/lib/estimates';
import { MEDAL_ICON, medalFor, type MedalTargets } from '@/lib/championship';
import { ghostKey } from '@/game/ghost';
import { QUALITY_LABEL, loadQuality, saveQuality, type QualityLevel } from '@/game/quality';
import { fmtTime, getPlayerName, leaderboard, personalBest, saveRun, setPlayerName, type RunResult } from '@/lib/scores';

interface Props {
  piste: Piste;
  domain: DomainData;
  onExit: () => void;
  /** Mode championnat : temps cibles des médailles. */
  targets?: MedalTargets;
  /** Appelé à chaque descente terminée (mode championnat). */
  onRun?: (r: GameResult) => void;
}

export default function SkiSimulator({ piste, domain, onExit, targets, onRun }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const game = useRef<SkiGame | null>(null);
  const [loading, setLoading] = useState<string | null>('Initialisation…');
  const [loadPct, setLoadPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [best, setBest] = useState<RunResult | null>(() => personalBest(piste.id));
  const [prevBest, setPrevBest] = useState<RunResult | null>(null);
  const [board, setBoard] = useState<{ online: boolean; rows: RunResult[] } | null>(null);
  const [approx, setApprox] = useState(false);
  const [noBuildings, setNoBuildings] = useState(false);
  const [player, setPlayer] = useState(getPlayerName());
  const [quality, setQuality] = useState<QualityLevel>(() => loadQuality());
  const [muted, setMuted] = useState(false);
  const [trickPop, setTrickPop] = useState<Hud['lastTrick']>(null);
  const lastTrickId = useRef(0);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const runRef = useRef(onRun);
  runRef.current = onRun;

  useEffect(() => {
    if (!box.current) return;
    const g = new SkiGame({
      container: box.current,
      piste,
      quality,
      onHud: (h) => {
        setHud(h);
        if (h.phase !== 'loading') setLoading(null);
        if (h.lastTrick && h.lastTrick.id !== lastTrickId.current) {
          lastTrickId.current = h.lastTrick.id;
          setTrickPop(h.lastTrick);
        }
      },
      onFinish: async (r) => {
        setResult(r);
        runRef.current?.(r);
        const pb = personalBest(piste.id);
        setPrevBest(pb);
        if (!pb || r.timeS < pb.timeS) {
          try {
            localStorage.setItem(ghostKey(piste.id), r.ghost);
          } catch {
            /* stockage plein : pas de fantôme */
          }
        }
        const run: RunResult = {
          pisteId: piste.id,
          pisteName: piste.name,
          player: getPlayerName(),
          timeS: r.timeS,
          maxKmh: r.maxKmh,
          avgKmh: r.avgKmh,
          score: r.score,
          tricks: r.tricks,
          approximate: r.approximate,
          at: new Date().toISOString(),
        };
        await saveRun(run);
        setBest(personalBest(piste.id));
        setBoard(await leaderboard(piste.id));
      },
      onLoading: (msg, p) => {
        setLoading(msg);
        if (p != null) setLoadPct(p);
      },
    });
    game.current = g;
    g.init()
      .then(() => {
        setApprox(g.approximate);
        setNoBuildings(g.buildingsStatus === 'indisponibles');
      })
      .catch((e) => setError(String(e)));
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && exitRef.current();
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('keydown', esc);
      g.dispose();
      game.current = null;
    };
  }, [piste, domain, quality]);

  useEffect(() => {
    if (!trickPop) return;
    const t = setTimeout(() => setTrickPop(null), 1600);
    return () => clearTimeout(t);
  }, [trickPop]);

  const press = (k: keyof Input, v: boolean) => {
    if (game.current) game.current.input[k] = v;
  };
  const touchBtn = (k: keyof Input, label: string, cls = '') => (
    <button
      className={`glass grid select-none place-items-center rounded-2xl text-xl font-bold active:bg-electric-500/60 ${cls}`}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        press(k, true);
      }}
      onPointerUp={() => press(k, false)}
      onPointerCancel={() => press(k, false)}
      onPointerLeave={() => press(k, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );

  const restart = () => {
    setResult(null);
    setBoard(null);
    game.current?.reset();
  };
  const goFree = () => {
    setResult(null);
    game.current?.startFree();
  };
  const free = hud?.phase === 'free';

  const speed = hud?.speedKmh ?? 0;
  const progress = hud ? hud.dist / Math.max(1, hud.dist + hud.remaining) : 0;

  return (
    <div className="fixed inset-0 z-[60] bg-anthracite-950 touch-none">
      <div ref={box} className="absolute inset-0" />

      {/* effet de vitesse */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 45%, rgba(220,235,255,0.55) 100%)',
          opacity: Math.min(0.85, Math.max(0, (speed - 45) / 60)),
        }}
      />

      {/* barre supérieure */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 flex items-start justify-between gap-2 p-3">
        <div className="glass pointer-events-auto flex items-center gap-3 rounded-2xl px-3 py-2">
          <button onClick={onExit} className="rounded-lg bg-white/10 px-2 py-1 text-sm hover:bg-white/20">← Carte</button>
          <span className="h-3 w-3 rounded-full border border-white/70" style={{ background: DIFF_COLOR[piste.difficulty] }} />
          <div className="leading-tight">
            <div className="text-[13px] font-bold">{piste.name}</div>
            <div className="text-[10px] text-glacier-200/60">
              {piste.sector} · {DIFF_LABEL[piste.difficulty]}
              {hud && hud.phase !== 'loading' ? ` · ${hud.fps} img/s${hud.renderScale < 100 ? ` (${hud.renderScale} %)` : ''}` : ''}
            </div>
          </div>
        </div>
        {free && (
          <div className="glass rounded-2xl px-4 py-2 text-right">
            <div className="text-[13px] font-bold">🗺️ Mode libre</div>
            <div className="text-[10px] text-glacier-200/60">Prenez les remontées (E) · R : revenir au départ</div>
          </div>
        )}
        {hud && hud.phase !== 'loading' && !free && (
          <div className="glass rounded-2xl px-4 py-2 text-right">
            <div className="font-mono text-2xl font-bold tabular-nums">{fmtTime(hud.time)}</div>
            <div className="text-[10px] text-glacier-200/60">{best ? `Record : ${fmtTime(best.timeS)}` : 'Pas encore de record'}</div>
            {targets && (
              <div className="mt-1 flex justify-end gap-2 text-[11px] tabular-nums">
                {(['or', 'argent', 'bronze'] as const).map((m) => (
                  <span key={m} className={hud.time > targets[m] ? 'opacity-30 line-through' : ''}>
                    {MEDAL_ICON[m]} {fmtTime(targets[m])}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {approx && (
        <div className="pointer-events-none absolute left-1/2 top-20 -translate-x-1/2 rounded-xl border border-amber-400/40 bg-amber-500/20 px-3 py-1.5 text-[12px] text-amber-100 backdrop-blur">
          ⚠️ Relief indisponible : terrain reconstruit approximativement (le tracé GPS reste réel)
        </div>
      )}

      {noBuildings && hud?.phase !== 'loading' && (
        <div className="pointer-events-none absolute left-3 top-20 rounded-lg bg-black/40 px-2 py-1 text-[10px] text-glacier-100/70">
          Bâtiments OSM indisponibles (serveur Overpass saturé)
        </div>
      )}

      {/* HUD bas */}
      {hud && hud.phase !== 'loading' && !result && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 p-3 md:p-5">
          {hud.riding ? (
            <div className="mx-auto mb-3 max-w-md rounded-2xl bg-black/40 px-4 py-2.5 backdrop-blur">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-bold">🚡 {hud.riding.kind} {hud.riding.name}</span>
                <span className="tabular-nums text-glacier-100/80">{Math.ceil(hud.riding.remainingS)} s</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/15">
                <div className="h-full rounded-full bg-white" style={{ width: `${hud.riding.progress * 100}%` }} />
              </div>
              <div className="mt-1 text-[10px] text-glacier-200/60">Maintenez Espace (ou ⏩) pour accélérer</div>
            </div>
          ) : (
            <div className="mb-2 flex flex-col items-center gap-2">
              {hud.liftPrompt && (
                <button
                  className="pointer-events-auto animate-fade-up rounded-2xl bg-electric-500 px-4 py-2 text-[13px] font-bold shadow-[0_0_24px_rgba(31,107,255,0.6)]"
                  onClick={() => game.current?.board()}
                >
                  {hud.liftPrompt}
                </button>
              )}
              <div className="rounded-full bg-black/35 px-3 py-1 text-[12px] backdrop-blur">
                {hud.currentPiste ? (
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full border border-white/70" style={{ background: DIFF_COLOR[hud.currentPiste.difficulty] }} />
                    {hud.currentPiste.name}
                  </span>
                ) : (
                  <span className="text-amber-200">Hors piste</span>
                )}
              </div>
            </div>
          )}
          {!free && !hud.riding && (
            <div className="mx-auto mb-3 h-1.5 max-w-xl overflow-hidden rounded-full bg-white/15">
              <div className="h-full rounded-full bg-gradient-to-r from-glacier-300 to-electric-400" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          <div className="mx-auto flex max-w-3xl items-end justify-between gap-2">
            <div className="glass rounded-2xl px-4 py-2">
              <div className="font-mono text-4xl font-black tabular-nums md:text-5xl">{Math.round(speed)}</div>
              <div className="label">km/h</div>
            </div>
            <div className="glass hidden gap-5 rounded-2xl px-4 py-2 sm:flex">
              {!free && (
                <>
                  <div><div className="label">Parcouru</div><div className="font-semibold tabular-nums">{Math.round(hud.dist)} m</div></div>
                  <div><div className="label">Restant</div><div className="font-semibold tabular-nums">{Math.round(hud.remaining)} m</div></div>
                </>
              )}
              <div><div className="label">Altitude</div><div className="font-semibold tabular-nums">{Math.round(hud.altitude)} m</div></div>
              <div><div className="label">Figures</div><div className="font-semibold tabular-nums">{hud.tricks}</div></div>
            </div>
            <div className="glass rounded-2xl px-4 py-2 text-right">
              <div className="font-mono text-2xl font-bold tabular-nums">{hud.score.toLocaleString('fr-FR')}</div>
              <div className="label">score</div>
            </div>
          </div>
          <div className="mx-auto mt-2 hidden max-w-3xl text-center text-[10px] text-white/50 md:block">
            ←/→ tourner · ↑ pousser · ↓ freiner · Espace : maintenir pour charger, relâcher pour sauter · En l'air : ←/→ spins, ↑/↓ flips, Shift grab · Shift au sol : aéro · T rewind · E remontée · C caméra · M carte · R recommencer · Échap
          </div>
        </div>
      )}

      {hud?.phase === 'countdown' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-[120px] font-black text-white drop-shadow-[0_8px_30px_rgba(31,107,255,0.8)]">{hud.countdown}</div>
        </div>
      )}
      {/* combo en cours (style arcade) */}
      {hud?.combo && !result && (
        <div className="pointer-events-none absolute left-3 top-24 max-w-[60vw] md:left-6 md:top-28">
          <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-glacier-200/70">Combo</div>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-black tabular-nums text-white drop-shadow-lg md:text-5xl">{hud.combo.total.toLocaleString('fr-FR')}</span>
            <span className="rounded-lg bg-amber-400 px-1.5 text-lg font-black text-anthracite-950">x{hud.combo.mult}</span>
          </div>
          <div className="mt-1 text-[12px] font-semibold text-glacier-100/85">{hud.combo.names.join(' + ')}</div>
          <div className="mt-1.5 h-1 w-40 overflow-hidden rounded-full bg-white/15">
            <div className="h-full bg-amber-300" style={{ width: `${hud.combo.window * 100}%` }} />
          </div>
        </div>
      )}
      {trickPop && !result && (
        <div key={trickPop.id} className="pointer-events-none absolute left-1/2 top-[18%] -translate-x-1/2 animate-fade-up text-center">
          <div className={`text-sm font-black uppercase tracking-[0.3em] ${({ Perfect: 'text-emerald-300', Good: 'text-sky-200', Sloppy: 'text-amber-300' })[trickPop.quality]}`}>{trickPop.quality}</div>
          <div className="whitespace-nowrap text-3xl font-black italic text-white drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)] md:text-5xl">{trickPop.name}</div>
          <div className="text-lg font-bold text-amber-300">+{trickPop.points.toLocaleString('fr-FR')}</div>
        </div>
      )}
      {hud && !result && (hud.charge > 0.05 || hud.switchStance || hud.grinding || hud.ghost) && (
        <div className="pointer-events-none absolute bottom-40 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5 md:bottom-44">
          {hud.charge > 0.05 && (
            <div className="h-2 w-40 overflow-hidden rounded-full bg-black/40">
              <div className="h-full bg-gradient-to-r from-sky-300 to-amber-300" style={{ width: `${hud.charge * 100}%` }} />
            </div>
          )}
          <div className="flex gap-1.5 text-[11px] font-bold">
            {hud.grinding && <span className="rounded bg-violet-500/80 px-2 py-0.5">GRIND</span>}
            {hud.switchStance && <span className="rounded bg-white/20 px-2 py-0.5">SWITCH</span>}
            {hud.ghost && <span className="rounded bg-sky-400/40 px-2 py-0.5">👻 fantôme du record</span>}
          </div>
        </div>
      )}

      {hud?.message && (
        <div className="pointer-events-none absolute left-1/2 top-[28%] -translate-x-1/2 animate-fade-up whitespace-nowrap rounded-2xl bg-black/35 px-5 py-2 text-2xl font-extrabold tracking-wide text-white backdrop-blur md:text-3xl">
          {hud.message}
        </div>
      )}

      {/* commandes tactiles */}
      {!result && hud && hud.phase !== 'loading' && (
        <div className="absolute bottom-28 left-0 right-0 flex items-end justify-between px-3 md:hidden">
          <div className="flex gap-2">
            {touchBtn('left', '◀', 'h-16 w-16')}
            {touchBtn('right', '▶', 'h-16 w-16')}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {touchBtn('tuck', '⚡', 'h-14 w-14 text-base')}
            {touchBtn('up', '▲', 'h-14 w-14')}
            {touchBtn('jump', '⤒', 'h-14 w-14')}
            {touchBtn('down', '▼', 'h-14 w-14')}
            {hud.riding && touchBtn('jump', '⏩', 'col-span-2 h-12 w-full text-base')}
            <button className="glass col-span-2 h-10 rounded-2xl text-sm font-bold" onClick={() => game.current?.rewind()}>⏪</button>
          </div>
        </div>
      )}
      {!result && hud && (hud.phase === 'running' || hud.phase === 'free' || hud.phase === 'countdown') && (
        <div className="absolute right-3 top-28 flex flex-col gap-2">
          {!free && (
            <button className="glass rounded-xl px-3 py-1.5 text-[12px]" onClick={goFree}>🗺️ Mode libre</button>
          )}
          <button className="glass rounded-xl px-3 py-1.5 text-[12px]" onClick={() => game.current?.rewind()}>⏪ Rewind{hud.rewinds ? ` (${hud.rewinds})` : ''}</button>
          <button className="glass rounded-xl px-3 py-1.5 text-[12px]" onClick={() => game.current?.toggleCamera()}>🎥 Caméra</button>
          <button
            className="glass rounded-xl px-3 py-1.5 text-[12px]"
            onClick={() => {
              game.current?.setMuted(!muted);
              setMuted(!muted);
            }}
          >
            {muted ? '🔇 Son' : '🔊 Son'}
          </button>
          <select
            value={quality}
            onChange={(e) => {
              const q = e.target.value as QualityLevel;
              saveQuality(q);
              setResult(null);
              setLoading('Changement de qualité…');
              setQuality(q);
            }}
            className="glass rounded-xl px-2 py-1.5 text-[12px] outline-none"
            title="Qualité graphique (recharge la descente)"
          >
            {(Object.keys(QUALITY_LABEL) as QualityLevel[]).map((q) => (
              <option key={q} value={q} className="bg-anthracite-900">
                🎨 {QUALITY_LABEL[q]}
              </option>
            ))}
          </select>
          <button className="glass rounded-xl px-3 py-1.5 text-[12px]" onClick={() => game.current?.unstuck()}>↺ Bloqué ?</button>
        </div>
      )}

      {/* chargement */}
      {(loading || error) && (
        <div className="absolute inset-0 grid place-items-center bg-anthracite-950/95">
          <div className="max-w-sm px-6 text-center">
            <div className="label">Pléney · Nyon · Les Gets</div>
            <div className="mt-1 text-lg font-semibold">{piste.name}</div>
            <div className="mx-auto mt-5 h-2 w-64 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gradient-to-r from-electric-500 to-glacier-300 transition-[width] duration-300" style={{ width: `${Math.round(loadPct * 100)}%` }} />
            </div>
            <div className="mt-2 text-sm text-glacier-200/70">{error ? `Erreur : ${error}` : `${loading} ${loadPct > 0 && loadPct < 1 ? Math.round(loadPct * 100) + ' %' : ''}`}</div>
            <p className="mt-4 text-[11px] leading-relaxed text-glacier-200/40">
              Toute la carte du secteur est chargée une fois (≈ 30 Mo) : relief IGN au pas de 5 m, chaque sapin placé d’après la photo aérienne IGN, pistes, remontées et chalets OpenStreetMap, ombres pré-calculées. Les descentes suivantes démarrent tout de suite.
              <br />
              Jalons, panneaux, filets, modules freestyle et autres skieurs sont générés pour l’ambiance.
            </p>
            {error && <button className="btn-ghost mt-4" onClick={onExit}>Retour à la carte</button>}
          </div>
        </div>
      )}

      {/* résultats */}
      {result && (
        <div className="absolute inset-0 grid place-items-center bg-anthracite-950/70 p-4 backdrop-blur-sm">
          <div className="glass animate-fade-up w-full max-w-md rounded-3xl p-6">
            <div className="label">{targets ? 'Championnat Morzine – Les Gets' : 'Descente terminée'}</div>
            <h2 className="text-2xl font-extrabold">{piste.name}</h2>
            {targets && (() => {
              const m = medalFor(result.timeS, targets);
              return (
                <div className={`mt-3 flex items-center gap-3 rounded-2xl px-4 py-3 ${m ? 'bg-amber-400/15 border border-amber-300/40' : 'bg-white/5'}`}>
                  <span className="text-4xl">{m ? MEDAL_ICON[m] : '🏁'}</span>
                  <div className="text-[13px]">
                    <div className="font-bold">{m ? `Médaille ${m === 'or' ? "d'or" : m === 'argent' ? "d'argent" : 'de bronze'} !` : 'Pas de médaille cette fois'}</div>
                    <div className="text-glacier-100/70">
                      🥇 {fmtTime(targets.or)} · 🥈 {fmtTime(targets.argent)} · 🥉 {fmtTime(targets.bronze)}
                    </div>
                  </div>
                </div>
              );
            })()}
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              {[
                ['Temps', fmtTime(result.timeS)],
                ['Vitesse max', `${Math.round(result.maxKmh)} km/h`],
                ['Vitesse moy.', `${Math.round(result.avgKmh)} km/h`],
                ['Score', result.score.toLocaleString('fr-FR')],
                ['Figures', String(result.tricks)],
                ['Chutes / rewinds', `${result.crashes} / ${result.rewinds}`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-white/5 py-2">
                  <div className="label">{k}</div>
                  <div className="text-lg font-bold tabular-nums">{v}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-xl bg-white/5 px-3 py-2 text-[13px]">
              {prevBest ? (
                result.timeS < prevBest.timeS ? (
                  <span className="text-emerald-300">🏆 Nouveau record ! {(prevBest.timeS - result.timeS).toFixed(2)} s de mieux que {fmtTime(prevBest.timeS)}</span>
                ) : (
                  <span>À {(result.timeS - prevBest.timeS).toFixed(2)} s de votre record ({fmtTime(prevBest.timeS)})</span>
                )
              ) : (
                <span className="text-emerald-300">🏆 Premier temps enregistré sur cette piste</span>
              )}
            </div>
            {result.approximate && <div className="mt-2 text-[11px] text-amber-200">Descente sur terrain reconstruit approximativement.</div>}

            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between">
                <span className="label">Classement {board?.online ? 'en ligne' : 'local'}</span>
                <input
                  value={player}
                  onChange={(e) => {
                    setPlayer(e.target.value);
                    setPlayerName(e.target.value);
                  }}
                  className="w-36 rounded-lg bg-white/5 px-2 py-0.5 text-right text-[12px] outline-none"
                  placeholder="Votre pseudo"
                />
              </div>
              <ol className="max-h-40 space-y-0.5 overflow-y-auto scroll-thin">
                {board?.rows.map((r, i) => (
                  <li key={i} className="flex justify-between rounded-lg px-2 py-1 text-[12px] odd:bg-white/[0.03]">
                    <span>{i + 1}. {r.player}</span>
                    <span className="font-mono tabular-nums">{fmtTime(r.timeS)}</span>
                  </li>
                )) ?? <li className="text-[12px] text-glacier-200/50">Chargement…</li>}
              </ol>
            </div>

            <button className="btn-ghost mt-4 w-full !border-electric-400/40" onClick={goFree}>🗺️ Continuer en mode libre (remontées, autres pistes)</button>
            <div className="mt-2 flex gap-2">
              <button className="btn-primary flex-1" onClick={restart}>↻ Recommencer</button>
              <button className="btn-ghost flex-1" onClick={onExit}>Choisir une autre piste</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
