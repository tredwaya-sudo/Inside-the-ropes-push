/**
 * Scoring engine — faithful TypeScript port of InsideTheRopes Engine.swift.
 * Pure logic: snapshots in, events out. No I/O.
 */

import {
  HOLE_COUNT,
  type Course,
  type FollowTarget,
  type GolfPlayer,
  type PlayerRound,
  type ScoreEvent,
  type Snapshot,
} from "./types.js";

export function coursePar(course: Course, hole: number): number | undefined {
  if (hole < 1 || hole > course.pars.length) return undefined;
  return course.pars[hole - 1];
}

export function playIndex(round: PlayerRound, hole: number): number {
  return (hole - round.startingHole + HOLE_COUNT) % HOLE_COUNT;
}

export function holesCompleted(round: PlayerRound): number {
  let count = 0;
  for (const stroke of round.strokes) {
    if (stroke != null) count += 1;
  }
  return count;
}

export function findCourse(
  snapshot: Snapshot,
  roundId: number
): Course | undefined {
  return (
    snapshot.courses.find((c) => c.roundId === roundId) ?? snapshot.courses[0]
  );
}

export function findPlayer(
  snapshot: Snapshot,
  id: string
): GolfPlayer | undefined {
  return snapshot.players.find((p) => p.id === id);
}

export function findRound(
  player: GolfPlayer,
  roundId: number
): PlayerRound | undefined {
  return player.rounds.find((r) => r.roundId === roundId);
}

export function toPar(event: ScoreEvent): number | null {
  if (event.strokes == null || event.par == null) return null;
  return event.strokes - event.par;
}

export function scoreName(event: ScoreEvent): string {
  const delta = toPar(event);
  if (delta == null) return "";
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
      return "Double bogey";
    case 3:
      return "Triple bogey";
    default:
      return delta > 0 ? `+${delta}` : `${delta}`;
  }
}

/** Deterministic, so a redelivery collapses onto the existing notification. */
export function notificationId(event: ScoreEvent): string {
  const base = `${event.playerId}-r${event.roundId}`;
  switch (event.kind) {
    case "roundCompleted":
      return `${base}-complete`;
    case "scoreCorrected":
      return `${base}-h${event.hole ?? 0}-c${event.strokes ?? 0}`;
    case "holePosted":
      return `${base}-h${event.hole ?? 0}`;
  }
}

export function headline(event: ScoreEvent): string {
  switch (event.kind) {
    case "roundCompleted":
      return `${event.playerName} finished round ${event.roundId}`;
    case "scoreCorrected":
      return `${event.playerName} — hole ${event.hole ?? 0} corrected to ${event.strokes ?? 0}`;
    case "holePosted":
      return `${event.playerName} — ${scoreName(event)} on ${event.hole ?? 0} (${event.strokes ?? 0}) · thru ${event.holesCompleted}`;
  }
}

/**
 * Compare two snapshots and return what changed.
 *
 * A null/undefined `previous` returns nothing on purpose. Without that guard,
 * the first poll of a round already in progress fires a notification for every
 * hole already played.
 */
export function diff(
  previous: Snapshot | null | undefined,
  current: Snapshot
): ScoreEvent[] {
  if (previous == null) return [];

  const events: ScoreEvent[] = [];

  for (const player of current.players) {
    const priorPlayer = findPlayer(previous, player.id);

    for (const round of player.rounds) {
      const course = findCourse(current, round.roundId);
      if (!course) continue;
      const priorRound = priorPlayer
        ? findRound(priorPlayer, round.roundId)
        : undefined;
      if (!priorRound) continue;

      const completed = holesCompleted(round);

      for (let hole = 1; hole <= HOLE_COUNT; hole++) {
        const index = hole - 1;
        if (index >= round.strokes.length || index >= priorRound.strokes.length) {
          continue;
        }

        const before = priorRound.strokes[index] ?? null;
        const after = round.strokes[index] ?? null;

        if (before == null && after != null) {
          events.push({
            kind: "holePosted",
            playerId: player.id,
            playerName: player.name,
            teamId: player.teamId,
            roundId: round.roundId,
            hole,
            playIndex: playIndex(round, hole),
            strokes: after,
            par: coursePar(course, hole) ?? null,
            previousStrokes: null,
            holesCompleted: completed,
          });
        } else if (before != null && after != null && before !== after) {
          events.push({
            kind: "scoreCorrected",
            playerId: player.id,
            playerName: player.name,
            teamId: player.teamId,
            roundId: round.roundId,
            hole,
            playIndex: playIndex(round, hole),
            strokes: after,
            par: coursePar(course, hole) ?? null,
            previousStrokes: before,
            holesCompleted: completed,
          });
        }
      }

      if (
        holesCompleted(priorRound) < HOLE_COUNT &&
        completed === HOLE_COUNT
      ) {
        events.push({
          kind: "roundCompleted",
          playerId: player.id,
          playerName: player.name,
          teamId: player.teamId,
          roundId: round.roundId,
          hole: null,
          playIndex: HOLE_COUNT,
          strokes: null,
          par: null,
          previousStrokes: null,
          holesCompleted: completed,
        });
      }
    }
  }

  // Ordered by how the golf actually happened, not by array index.
  events.sort((lhs, rhs) => {
    if (lhs.roundId !== rhs.roundId) return lhs.roundId - rhs.roundId;
    if (lhs.playIndex !== rhs.playIndex) return lhs.playIndex - rhs.playIndex;
    if (lhs.playerName !== rhs.playerName) {
      return lhs.playerName < rhs.playerName ? -1 : 1;
    }
    return lhs.playerId < rhs.playerId ? -1 : lhs.playerId > rhs.playerId ? 1 : 0;
  });

  return events;
}

export function filterEvents(
  events: ScoreEvent[],
  follows: FollowTarget[]
): ScoreEvent[] {
  if (follows.length === 0) return [];
  const playerIds = new Set(
    follows.filter((f) => f.type === "player").map((f) => f.id)
  );
  const teamIds = new Set(
    follows.filter((f) => f.type === "team").map((f) => f.id)
  );
  return events.filter((event) => {
    if (playerIds.has(event.playerId)) return true;
    if (event.teamId != null && teamIds.has(event.teamId)) return true;
    return false;
  });
}

/**
 * Four players posting in the same minute is one notification with four lines,
 * not four notifications.
 */
export function coalesce(events: ScoreEvent[], limit = 4): string[] {
  if (events.length === 0) return [];
  const lines: string[] = [];
  for (const event of events.slice(0, limit)) {
    lines.push(headline(event));
  }
  const remaining = events.length - lines.length;
  if (remaining > 0) lines.push(`and ${remaining} more`);
  return lines;
}

export function batchNotificationId(
  eventId: string,
  events: ScoreEvent[]
): string {
  if (events.length === 1) return notificationId(events[0]!);
  const first = events[0] ? notificationId(events[0]) : "";
  return `${eventId}-batch-${first}`;
}
