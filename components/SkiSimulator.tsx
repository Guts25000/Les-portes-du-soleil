'use client';
import { useEffect, useRef, useState } from 'react';
import type { DomainData, Piste } from '@/lib/types';
import { SkiGame, type GameResult, type Hud } from '@/game/SkiGame';
import type { Input } from '@/game/physics';
import { bboxOf } from '@/lib/geo';
import { DIFF_COLOR, DIFF_LABEL } from '@/lib/estimates';
import { MEDAL_ICON, medalFor, type MedalTargets } from '@/lib/championship';
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

function nearby(piste: Piste, domain: DomainData) {
  const [w, s, e, n] = bboxOf(piste.line);
  const m = 0.035;
  const inBox = (pts: [number, number][]) => pts.some(([x, y]) => x > w - m && x < e + m && y > s - m && y < n + m);
  return {
    pistes: domain.pistes.filter((p) => p.segments.some((seg) => inBox(seg))),
    lifts: domain.lifts.filter((l) => inBox(l.line)),
  };
}

export default function SkiSimulator({ piste, domain, onExit, targets, onRun }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const game = useRef<SkiGame | null>(null);
  const [loading, setLoading] = useState<string | null>('Initialisation…');
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [best, setBest] = useState<RunResult | null>(() => personalBest(piste.id));
  const [prevBest, setPrevBest] = useState<RunResult | null>(null);
  const [board, setBoard] = useState<{ online: boolean; rows: RunResult[] } | null>(null);
  const [approx, setApprox] = useState(false);
  const [player, setPlayer] = useState(getPlayerName());
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const runRef = useRef(onRun);
  runRef.current = onRun;

  useEffect(() => {
    if (!box.current) return;
    const nb = nearby(piste, domain);
    const g = new SkiGame({
      container: box.current,
      piste,
      nearbyPistes: nb.pistes,
      nearbyLifts: nb.lifts,
      onHud: (h) => {
        setHud(h);
        if (h.phase !== 'loading') setLoading(null);
      },
      onFinish: async (r) => {
        setResult(r);
        runRef.current?.(r);
        const pb = personalBest(piste.id);
        setPrevBest(pb);
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
      onLoading: setLoading,
    });
    game.current = g;
    g.init()
      .then(() => setApprox(g.approximate))
      .catch((e) => setError(String(e)));
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && exitRef.current();
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('keydown', esc);
      g.dispose();
      game.current = null;
    };
  }, [piste, domain]);

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
            <div className="text-[10px] text-glacier-200/60">{piste.sector} · {DIFF_LABEL[piste.difficulty]}</div>
          </div>
        </div>
        {hud && hud.phase !== 'loading' && (
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

      {/* HUD bas */}
      {hud && hud.phase !== 'loading' && !result && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 p-3 md:p-5">
          <div className="mx-auto mb-3 h-1.5 max-w-xl overflow-hidden rounded-full bg-white/15">
            <div className="h-full rounded-full bg-gradient-to-r from-glacier-300 to-electric-400" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="mx-auto flex max-w-3xl items-end justify-between gap-2">
            <div className="glass rounded-2xl px-4 py-2">
              <div className="font-mono text-4xl font-black tabular-nums md:text-5xl">{Math.round(speed)}</div>
              <div className="label">km/h</div>
            </div>
            <div className="glass hidden gap-5 rounded-2xl px-4 py-2 sm:flex">
              <div><div className="label">Parcouru</div><div className="font-semibold tabular-nums">{Math.round(hud.dist)} m</div></div>
              <div><div className="label">Restant</div><div className="font-semibold tabular-nums">{Math.round(hud.remaining)} m</div></div>
              <div><div className="label">Altitude</div><div className="font-semibold tabular-nums">{Math.round(hud.altitude)} m</div></div>
              <div><div className="label">Figures</div><div className="font-semibold tabular-nums">{hud.tricks}</div></div>
            </div>
            <div className="glass rounded-2xl px-4 py-2 text-right">
              <div className="font-mono text-2xl font-bold tabular-nums">{hud.score.toLocaleString('fr-FR')}</div>
              <div className="label">score</div>
            </div>
          </div>
          <div className="mx-auto mt-2 hidden max-w-3xl text-center text-[10px] text-white/50 md:block">
            ←/→ ou A/D tourner · ↑/W pousser · ↓/S freiner · Espace sauter (+ ←/→ en l'air : rotation) · Shift position aéro / grab · C caméra · R recommencer · Échap quitter
          </div>
        </div>
      )}

      {hud?.phase === 'countdown' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-[120px] font-black text-white drop-shadow-[0_8px_30px_rgba(31,107,255,0.8)]">{hud.countdown}</div>
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
          </div>
        </div>
      )}
      {!result && hud && hud.phase === 'running' && (
        <div className="absolute right-3 top-20 flex flex-col gap-2">
          <button className="glass rounded-xl px-3 py-1.5 text-[12px]" onClick={() => game.current?.toggleCamera()}>🎥 Caméra</button>
          <button className="glass rounded-xl px-3 py-1.5 text-[12px]" onClick={() => game.current?.unstuck()}>↺ Bloqué ?</button>
        </div>
      )}

      {/* chargement */}
      {(loading || error) && (
        <div className="absolute inset-0 grid place-items-center bg-anthracite-950/95">
          <div className="max-w-sm px-6 text-center">
            <div className="mx-auto mb-5 h-12 w-12 animate-spin rounded-full border-2 border-white/10 border-t-electric-400" />
            <div className="text-lg font-semibold">{piste.name}</div>
            <div className="mt-1 text-sm text-glacier-200/70">{error ? `Erreur : ${error}` : loading}</div>
            <p className="mt-4 text-[11px] leading-relaxed text-glacier-200/40">
              Parcours : tracé GPS OpenStreetMap · Relief : MNT réel. Forêt, balisage, filets et autres skieurs sont générés pour l'ambiance.
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
                ['Chutes', String(result.crashes)],
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

            <div className="mt-5 flex gap-2">
              <button className="btn-primary flex-1" onClick={restart}>↻ Recommencer</button>
              <button className="btn-ghost flex-1" onClick={onExit}>Choisir une autre piste</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
