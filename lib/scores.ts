/**
 * Records et classements.
 * - Toujours : meilleur temps personnel dans le navigateur (localStorage).
 * - Si NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY sont définis : classement en ligne
 *   via l'API REST Supabase (table `runs`, voir supabase/schema.sql).
 */

export interface RunResult {
  pisteId: string;
  pisteName: string;
  player: string;
  timeS: number;
  maxKmh: number;
  avgKmh: number;
  score: number;
  tricks: number;
  approximate: boolean; // terrain reconstruit approximativement
  at: string;
}

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const ONLINE = !!(SB_URL && SB_KEY);

const LS_KEY = 'pds3d.runs.v1';

function readLocal(): RunResult[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]') as RunResult[];
  } catch {
    return [];
  }
}

function writeLocal(runs: RunResult[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(runs.slice(-500)));
  } catch {
    /* stockage indisponible */
  }
}

export function personalBest(pisteId: string): RunResult | null {
  const runs = readLocal().filter((r) => r.pisteId === pisteId);
  if (!runs.length) return null;
  return runs.reduce((a, b) => (b.timeS < a.timeS ? b : a));
}

export function getPlayerName(): string {
  try {
    return localStorage.getItem('pds3d.player') || 'Skieur anonyme';
  } catch {
    return 'Skieur anonyme';
  }
}

export function setPlayerName(n: string) {
  try {
    localStorage.setItem('pds3d.player', n.slice(0, 24));
  } catch {
    /* noop */
  }
}

export async function saveRun(run: RunResult): Promise<void> {
  writeLocal([...readLocal(), run]);
  if (!ONLINE) return;
  try {
    await fetch(`${SB_URL}/rest/v1/runs`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY!,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        piste_id: run.pisteId,
        piste_name: run.pisteName,
        player: run.player,
        time_s: run.timeS,
        max_kmh: run.maxKmh,
        avg_kmh: run.avgKmh,
        score: run.score,
        tricks: run.tricks,
        approximate: run.approximate,
      }),
    });
  } catch {
    /* hors ligne : le record local est conservé */
  }
}

export async function leaderboard(pisteId: string, limit = 10): Promise<{ online: boolean; rows: RunResult[] }> {
  if (ONLINE) {
    try {
      const q = new URLSearchParams({
        piste_id: `eq.${pisteId}`,
        order: 'time_s.asc',
        limit: String(limit),
        select: 'piste_id,piste_name,player,time_s,max_kmh,avg_kmh,score,tricks,approximate,created_at',
      });
      const r = await fetch(`${SB_URL}/rest/v1/runs?${q}`, { headers: { apikey: SB_KEY!, Authorization: `Bearer ${SB_KEY}` } });
      if (r.ok) {
        const rows = (await r.json()) as Record<string, unknown>[];
        return {
          online: true,
          rows: rows.map((x) => ({
            pisteId: String(x.piste_id),
            pisteName: String(x.piste_name),
            player: String(x.player),
            timeS: Number(x.time_s),
            maxKmh: Number(x.max_kmh),
            avgKmh: Number(x.avg_kmh),
            score: Number(x.score),
            tricks: Number(x.tricks),
            approximate: !!x.approximate,
            at: String(x.created_at),
          })),
        };
      }
    } catch {
      /* repli local */
    }
  }
  const rows = readLocal()
    .filter((r) => r.pisteId === pisteId)
    .sort((a, b) => a.timeS - b.timeS)
    .slice(0, limit);
  return { online: false, rows };
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}
