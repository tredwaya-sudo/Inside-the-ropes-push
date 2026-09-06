/** Shared domain types — port of Engine.swift / Clippd wire shapes. */

export const HOLE_COUNT = 18;

export type FollowType = "player" | "team";

export interface FollowTarget {
  type: FollowType;
  id: string;
  name?: string;
}

export interface Course {
  roundId: number;
  name: string;
  pars: number[];
}

export interface PlayerRound {
  roundId: number;
  /** 1...18. Shotgun starts make this routinely something other than 1. */
  startingHole: number;
  /** 18 entries, null until a score is posted. */
  strokes: (number | null)[];
  teeTime?: string | null;
}

export interface GolfPlayer {
  id: string;
  name: string;
  teamId: string | null;
  teamName: string;
  rounds: PlayerRound[];
}

export interface Snapshot {
  eventId: string;
  eventName: string;
  courses: Course[];
  players: GolfPlayer[];
}

export type ScoreEventKind = "holePosted" | "scoreCorrected" | "roundCompleted";

export interface ScoreEvent {
  kind: ScoreEventKind;
  playerId: string;
  playerName: string;
  teamId: string | null;
  roundId: number;
  hole: number | null;
  playIndex: number;
  strokes: number | null;
  par: number | null;
  previousStrokes: number | null;
  holesCompleted: number;
}

export interface DeviceRecord {
  deviceToken: string;
  platform: "ios";
  follows: FollowTarget[];
  eventIds: string[];
  updatedAt: string;
}

export interface RegisterDeviceBody {
  deviceToken: string;
  platform: "ios";
  follows?: FollowTarget[];
  eventIds?: string[];
}
