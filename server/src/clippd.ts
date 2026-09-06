/**
 * Clippd scoreboard client — mirrors Clippd.swift snapshot parsing.
 */

import { HOLE_COUNT, type GolfPlayer, type Snapshot } from "./types.js";

export interface ClippdConfig {
  host: string;
  /** Injected for tests — skip real network. */
  fetchImpl?: typeof fetch;
}

interface CourseDTO {
  roundId: number;
  courseName?: string | null;
  pars: number[];
}

interface RoundDTO {
  roundId: number;
  startingHole?: number | null;
  strokes?: (number | null)[] | null;
  teeTime?: string | null;
}

interface PlayerDTO {
  playerId: string;
  playerName: string;
  schoolId?: string | null;
  schoolName?: string | null;
  schoolLogo?: string | null;
  userPicture?: string | null;
  rounds?: RoundDTO[] | null;
}

interface LeaderboardPayload {
  tournamentId?: string | null;
  courses: CourseDTO[];
  results: PlayerDTO[];
}

interface TournamentDTO {
  tournamentId?: string | number | null;
  tournamentName?: string | null;
  isComplete?: boolean | null;
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string | null;
}

function normalise(raw: (number | null)[] | null | undefined): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: HOLE_COUNT }, () => null);
  if (!raw) return out;
  for (let i = 0; i < Math.min(raw.length, HOLE_COUNT); i++) {
    out[i] = raw[i] ?? null;
  }
  return out;
}

export class ClippdClient {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ClippdConfig) {
    this.host = config.host.replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.host}${path}`;
    const res = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Clippd ${res.status} for ${path}`);
    }
    return res.json();
  }

  async tournamentName(eventId: string): Promise<string> {
    try {
      const data = (await this.get(`/api/tournaments/${eventId}`)) as TournamentDTO;
      return data.tournamentName ?? `Event ${eventId}`;
    } catch {
      return `Event ${eventId}`;
    }
  }

  async snapshot(eventId: string, eventName?: string): Promise<Snapshot> {
    const data = (await this.get(
      `/api/tournaments/${eventId}/leaderboards/player`
    )) as LeaderboardPayload;

    const name = eventName ?? (await this.tournamentName(eventId));

    const courses = (data.courses ?? []).map((dto) => ({
      roundId: dto.roundId,
      name: dto.courseName ?? "",
      pars: dto.pars ?? [],
    }));

    const players: GolfPlayer[] = (data.results ?? []).map((row) => ({
      id: row.playerId,
      name: row.playerName,
      teamId: row.schoolId ?? null,
      teamName: row.schoolName ?? "",
      rounds: (row.rounds ?? []).map((round) => ({
        roundId: round.roundId,
        startingHole: round.startingHole ?? 1,
        strokes: normalise(round.strokes),
        teeTime: round.teeTime ?? null,
      })),
    }));

    return {
      eventId: data.tournamentId ?? eventId,
      eventName: name,
      courses,
      players,
    };
  }
}

/** Parse a raw Clippd leaderboard JSON payload (for fixtures / tests). */
export function snapshotFromLeaderboardPayload(
  data: LeaderboardPayload,
  eventId: string,
  eventName: string
): Snapshot {
  const courses = (data.courses ?? []).map((dto) => ({
    roundId: dto.roundId,
    name: dto.courseName ?? "",
    pars: dto.pars ?? [],
  }));
  const players: GolfPlayer[] = (data.results ?? []).map((row) => ({
    id: row.playerId,
    name: row.playerName,
    teamId: row.schoolId ?? null,
    teamName: row.schoolName ?? "",
    rounds: (row.rounds ?? []).map((round) => ({
      roundId: round.roundId,
      startingHole: round.startingHole ?? 1,
      strokes: normalise(round.strokes),
      teeTime: round.teeTime ?? null,
    })),
  }));
  return {
    eventId: data.tournamentId ?? eventId,
    eventName,
    courses,
    players,
  };
}
