/**
 * Build ActivityKit Live Scores content-state from Clippd snapshots.
 * Shape must match iOS LiveScoresActivityAttributes.ContentState Codable.
 *
 * Date fields use Swift's default JSON encoding: timeIntervalSinceReferenceDate
 * (seconds since 2001-01-01T00:00:00Z), NOT Unix epoch.
 */

import {
  HOLE_COUNT,
  type FollowTarget,
  type GolfPlayer,
  type Snapshot,
} from "./types.js";
import { findCourse, holesCompleted } from "./scoring.js";

const REF_DATE_OFFSET_SEC = 978_307_200; // Unix → Apple reference date

/** Deterministic App Group JPEG name — must match iOS WidgetImageCache.fileName(forEntryId:). */
function imageFileNameForEntryId(id: string): string {
  const safe = id.replace(/\//g, "_").replace(/:/g, "_");
  return `${safe}.jpg`;
}


export interface LiveScoresPlayerState {
  id: string;
  name: string;
  lastName: string;
  shortName: string;
  teamName?: string | null;
  toPar?: number | null;
  toParLabel: string;
  rank?: number | null;
  placeLabel: string;
  thruLabel: string;
  lastHoleLabel?: string | null;
  isHot: boolean;
  isTeam: boolean;
  isFinished: boolean;
  imageFileName?: string | null;
}

export interface LiveScoresContentState {
  headline: string;
  eventName: string;
  players: LiveScoresPlayerState[];
  /** Swift Date as timeIntervalSinceReferenceDate */
  updatedAt: number;
}

function lastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length >= 2) {
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    const initial = first.charAt(0) ? `${first.charAt(0)}.` : "";
    return `${initial}${last}`;
  }
  return fullName;
}

function placeLabel(rank: number, tied = false): string {
  if (rank <= 0) return "—";
  const mod100 = rank % 100;
  const mod10 = rank % 10;
  let suffix = "th";
  if (mod100 < 11 || mod100 > 13) {
    if (mod10 === 1) suffix = "st";
    else if (mod10 === 2) suffix = "nd";
    else if (mod10 === 3) suffix = "rd";
  }
  const ordinal = `${rank}${suffix}`;
  return tied ? `T${ordinal}` : ordinal;
}

function parLabel(toPar: number | null | undefined): string {
  if (toPar == null) return "—";
  if (toPar === 0) return "E";
  if (toPar > 0) return `+${toPar}`;
  return `${toPar}`;
}

function tournamentToPar(player: GolfPlayer, snapshot: Snapshot): number | null {
  let total = 0;
  let any = false;
  for (const round of player.rounds) {
    const course = findCourse(snapshot, round.roundId);
    if (!course) continue;
    if (holesCompleted(round) === 0) continue;
    for (let i = 0; i < round.strokes.length; i++) {
      const stroke = round.strokes[i];
      if (stroke == null) continue;
      const par = course.pars[i];
      if (par == null) continue;
      total += stroke - par;
      any = true;
    }
  }
  return any ? total : null;
}

function currentRound(player: GolfPlayer): {
  roundId: number;
  thru: number;
  startingHole: number;
  strokes: (number | null)[];
} | null {
  let best: {
    roundId: number;
    thru: number;
    startingHole: number;
    strokes: (number | null)[];
  } | null = null;
  for (const round of player.rounds) {
    const thru = holesCompleted(round);
    if (thru === 0) continue;
    if (!best || round.roundId >= best.roundId) {
      best = {
        roundId: round.roundId,
        thru,
        startingHole: round.startingHole,
        strokes: round.strokes,
      };
    }
  }
  return best;
}

function lastHoleLabel(
  player: GolfPlayer,
  snapshot: Snapshot
): string | null {
  const round = currentRound(player);
  if (!round || round.thru <= 0) return null;
  const course = findCourse(snapshot, round.roundId);
  if (!course) return null;
  const completed = Math.min(round.thru, HOLE_COUNT);
  const playIndex = completed - 1;
  const hole =
    ((round.startingHole - 1 + playIndex) % HOLE_COUNT) + 1;
  const stroke = round.strokes[hole - 1];
  const par = course.pars[hole - 1];
  if (stroke == null || par == null) return null;
  if (stroke === 1) return "Ace";
  const delta = stroke - par;
  switch (delta) {
    case -3:
      return "Albatross";
    case -2:
      return "Eagle";
    case -1:
      return "Birdie";
    case 0:
      return "Par";
    case 1:
      return "Bogey";
    case 2:
      return "Double";
    case 3:
      return "Triple";
    default:
      return delta > 0 ? `+${delta}` : `${delta}`;
  }
}

function isHot(player: GolfPlayer, snapshot: Snapshot): boolean {
  const round = currentRound(player);
  if (!round) return false;
  const course = findCourse(snapshot, round.roundId);
  if (!course) return false;
  let under = 0;
  let seen = 0;
  for (let play = round.thru; play >= 1; play--) {
    const hole =
      ((round.startingHole - 1 + (play - 1)) % HOLE_COUNT) + 1;
    const stroke = round.strokes[hole - 1];
    const par = course.pars[hole - 1];
    if (stroke == null || par == null) continue;
    seen += 1;
    if (stroke - par < 0) under += 1;
    else break;
    if (seen >= 3) break;
  }
  return under >= 3;
}

interface Ranked {
  player: GolfPlayer;
  toPar: number | null;
  rank: number;
  tied: boolean;
  snapshot: Snapshot;
}

function rankPlayers(snapshot: Snapshot): Map<string, Ranked> {
  const scored = snapshot.players.map((player) => ({
    player,
    toPar: tournamentToPar(player, snapshot),
  }));
  scored.sort((a, b) => {
    if (a.toPar == null && b.toPar == null)
      return a.player.name.localeCompare(b.player.name);
    if (a.toPar == null) return 1;
    if (b.toPar == null) return -1;
    if (a.toPar !== b.toPar) return a.toPar - b.toPar;
    return a.player.name.localeCompare(b.player.name);
  });
  const map = new Map<string, Ranked>();
  let prev: number | null | undefined = undefined;
  let prevRank = 0;
  let index = 0;
  for (const entry of scored) {
    index += 1;
    let rank: number;
    if (entry.toPar == null) {
      rank = index;
      prev = undefined;
    } else if (prev === entry.toPar) {
      rank = prevRank;
    } else {
      rank = index;
      prevRank = rank;
      prev = entry.toPar;
    }
    map.set(entry.player.id, {
      player: entry.player,
      toPar: entry.toPar,
      rank,
      tied: false,
      snapshot,
    });
  }
  // Mark ties
  const byRank = new Map<number, string[]>();
  for (const r of map.values()) {
    if (r.toPar == null) continue;
    const list = byRank.get(r.rank) ?? [];
    list.push(r.player.id);
    byRank.set(r.rank, list);
  }
  for (const ids of byRank.values()) {
    if (ids.length > 1) {
      for (const id of ids) {
        const row = map.get(id);
        if (row) row.tied = true;
      }
    }
  }
  return map;
}

function playerState(ranked: Ranked): LiveScoresPlayerState | null {
  const { player, toPar, rank, tied, snapshot } = ranked;
  const round = currentRound(player);
  if (!round && toPar == null) return null;
  const thru = round?.thru ?? 0;
  if (thru <= 0 && toPar == null) return null;
  const finished = thru >= HOLE_COUNT;
  const thruLabel = finished ? "F" : thru > 0 ? `Thru ${thru}` : "—";
  return {
    id: player.id,
    name: player.name,
    lastName: lastName(player.name),
    shortName: shortName(player.name),
    teamName: player.teamName || null,
    toPar: toPar,
    toParLabel: parLabel(toPar),
    rank,
    placeLabel: placeLabel(rank, tied),
    thruLabel,
    lastHoleLabel: lastHoleLabel(player, snapshot),
    isHot: isHot(player, snapshot),
    isTeam: false,
    isFinished: finished,
    imageFileName: imageFileNameForEntryId(player.id),
  };
}

interface TeamStanding {
  id: string;
  name: string;
  toPar: number;
  thru: number;
  rank: number;
  tied: boolean;
}

/** Team standings from counting scores (top N to-par), competition ranks with ties. */
function rankTeams(snapshot: Snapshot, countingSize = 4): Map<string, TeamStanding> {
  const byTeam = new Map<string, GolfPlayer[]>();
  for (const player of snapshot.players) {
    if (!player.teamId) continue;
    const list = byTeam.get(player.teamId) ?? [];
    list.push(player);
    byTeam.set(player.teamId, list);
  }

  const standings: Omit<TeamStanding, "rank" | "tied">[] = [];
  for (const [teamId, members] of byTeam) {
    const scored = members
      .map((p) => ({
        player: p,
        toPar: tournamentToPar(p, snapshot),
        thru: currentRound(p)?.thru ?? 0,
      }))
      .filter((m) => m.toPar != null && m.thru > 0)
      .sort((a, b) => {
        const l = a.toPar as number;
        const r = b.toPar as number;
        if (l !== r) return l - r;
        return a.player.id.localeCompare(b.player.id);
      });
    if (scored.length === 0) continue;
    const counting = scored.slice(0, Math.min(countingSize, scored.length));
    const teamToPar = counting.reduce((sum, m) => sum + (m.toPar as number), 0);
    const thru = Math.min(...counting.map((m) => m.thru));
    if (thru <= 0) continue;
    const name = members[0]?.teamName || teamId;
    standings.push({ id: teamId, name, toPar: teamToPar, thru });
  }

  standings.sort((a, b) => {
    if (a.toPar !== b.toPar) return a.toPar - b.toPar;
    return a.name.localeCompare(b.name);
  });

  const map = new Map<string, TeamStanding>();
  let i = 0;
  while (i < standings.length) {
    const score = standings[i]!.toPar;
    let j = i;
    while (j < standings.length && standings[j]!.toPar === score) j += 1;
    const place = i + 1;
    const tied = j - i > 1;
    for (let k = i; k < j; k++) {
      const row = standings[k]!;
      map.set(row.id, { ...row, rank: place, tied });
    }
    i = j;
  }
  return map;
}

/**
 * Build Live Scores content-state for a device's follows across event snapshots.
 * Returns null when nothing started is available.
 */
export function buildLiveScoresContentState(
  follows: FollowTarget[],
  snapshots: Snapshot[]
): LiveScoresContentState | null {
  const candidates: LiveScoresPlayerState[] = [];
  const eventNameById = new Map<string, string>();

  for (const snap of snapshots) {
    const ranks = rankPlayers(snap);
    for (const follow of follows) {
      if (follow.type === "player") {
        const ranked = ranks.get(follow.id);
        if (!ranked) continue;
        const state = playerState(ranked);
        if (!state) continue;
        // Prefer existing better entry
        const existingIdx = candidates.findIndex((c) => c.id === state.id);
        if (existingIdx >= 0) {
          const prev = candidates[existingIdx]!;
          if (!prev.isFinished && state.isFinished) continue;
          if (
            (state.toPar ?? 999) < (prev.toPar ?? 999) ||
            (state.isHot && !prev.isHot)
          ) {
            candidates[existingIdx] = state;
            eventNameById.set(state.id, snap.eventName);
          }
        } else {
          candidates.push(state);
          eventNameById.set(state.id, snap.eventName);
        }
      } else if (follow.type === "team") {
        // Rank full field so followed team gets real place (1st / T2 / …), not "—".
        const teamRanks = rankTeams(snap, 4);
        const standing = teamRanks.get(follow.id);
        if (!standing) continue;
        const finished = standing.thru >= HOLE_COUNT;
        const name = standing.name || follow.name || follow.id;
        const state: LiveScoresPlayerState = {
          id: follow.id,
          name,
          lastName: lastName(name),
          shortName: shortName(name),
          teamName: null,
          toPar: standing.toPar,
          toParLabel: parLabel(standing.toPar),
          rank: standing.rank,
          placeLabel: placeLabel(standing.rank, standing.tied),
          thruLabel: finished ? "F" : `Thru ${standing.thru}`,
          lastHoleLabel: null,
          isHot: false,
          isTeam: true,
          isFinished: finished,
          imageFileName: imageFileNameForEntryId(follow.id),
        };
        if (!candidates.some((c) => c.id === state.id)) {
          candidates.push(state);
          eventNameById.set(state.id, snap.eventName);
        } else {
          const idx = candidates.findIndex((c) => c.id === state.id);
          const prev = candidates[idx]!;
          if ((state.toPar ?? 999) < (prev.toPar ?? 999)) {
            candidates[idx] = state;
            eventNameById.set(state.id, snap.eventName);
          }
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((lhs, rhs) => {
    if (lhs.isHot !== rhs.isHot) return lhs.isHot ? -1 : 1;
    if (lhs.isFinished !== rhs.isFinished) return lhs.isFinished ? 1 : -1;
    if (lhs.isTeam !== rhs.isTeam) return lhs.isTeam ? 1 : -1;
    if (lhs.toPar == null && rhs.toPar == null)
      return lhs.name.localeCompare(rhs.name);
    if (lhs.toPar == null) return 1;
    if (rhs.toPar == null) return -1;
    if (lhs.toPar !== rhs.toPar) return lhs.toPar - rhs.toPar;
    return lhs.name.localeCompare(rhs.name);
  });

  const top = candidates.slice(0, 3);
  const primaryEvent =
    (top[0] && eventNameById.get(top[0].id)) || "Live event";
  const more = Math.max(0, candidates.length - top.length);
  let headline: string;
  if (more > 0) headline = `+${more} more followed`;
  else if (top.length === 1) headline = `Following · ${primaryEvent}`;
  else headline = `${top.length} followed · ${primaryEvent}`;

  return {
    headline,
    eventName: primaryEvent,
    players: top,
    updatedAt: Date.now() / 1000 - REF_DATE_OFFSET_SEC,
  };
}

export function contentStateFingerprint(state: LiveScoresContentState): string {
  // Ignore updatedAt so identical scores don't spam APNs.
  return JSON.stringify({
    headline: state.headline,
    eventName: state.eventName,
    players: state.players.map((p) => ({
      id: p.id,
      toPar: p.toPar,
      toParLabel: p.toParLabel,
      placeLabel: p.placeLabel,
      thruLabel: p.thruLabel,
      lastHoleLabel: p.lastHoleLabel,
      isHot: p.isHot,
      isFinished: p.isFinished,
    })),
  });
}
