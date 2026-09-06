import { describe, expect, it } from "vitest";
import {
  batchNotificationId,
  coalesce,
  diff,
  filterEvents,
  headline,
  holesCompleted,
  notificationId,
  playIndex,
  scoreName,
} from "../src/scoring.js";
import type {
  FollowTarget,
  GolfPlayer,
  PlayerRound,
  ScoreEvent,
  Snapshot,
} from "../src/types.js";
import { HOLE_COUNT } from "../src/types.js";

function emptyStrokes(): (number | null)[] {
  return Array.from({ length: HOLE_COUNT }, () => null);
}

function withStrokes(
  map: Record<number, number>,
  startingHole = 1
): PlayerRound {
  const strokes = emptyStrokes();
  for (const [hole, value] of Object.entries(map)) {
    strokes[Number(hole) - 1] = value;
  }
  return { roundId: 1, startingHole, strokes, teeTime: null };
}

function player(
  id: string,
  name: string,
  round: PlayerRound,
  teamId: string | null = "team-a"
): GolfPlayer {
  return {
    id,
    name,
    teamId,
    teamName: "Team A",
    rounds: [round],
  };
}

function snap(players: GolfPlayer[], eventId = "evt-1"): Snapshot {
  return {
    eventId,
    eventName: "Test Invitational",
    courses: [
      {
        roundId: 1,
        name: "North",
        pars: Array.from({ length: HOLE_COUNT }, () => 4),
      },
    ],
    players,
  };
}

describe("playIndex (shotgun)", () => {
  it("starting on 1 is identity", () => {
    const round = withStrokes({}, 1);
    expect(playIndex(round, 1)).toBe(0);
    expect(playIndex(round, 18)).toBe(17);
  });

  it("starting on 13 wraps correctly", () => {
    const round = withStrokes({}, 13);
    // 13 is first hole played (index 0), then 14...18, then 1...12
    expect(playIndex(round, 13)).toBe(0);
    expect(playIndex(round, 18)).toBe(5);
    expect(playIndex(round, 1)).toBe(6);
    expect(playIndex(round, 12)).toBe(17);
  });
});

describe("diff — previous null", () => {
  it("returns no events when previous is null", () => {
    const current = snap([
      player("p1", "Ada", withStrokes({ 1: 3, 2: 4, 3: 5 })),
    ]);
    expect(diff(null, current)).toEqual([]);
    expect(diff(undefined, current)).toEqual([]);
  });
});

describe("diff — holePosted / scoreCorrected / roundCompleted", () => {
  it("emits holePosted when stroke goes nil→value", () => {
    const previous = snap([player("p1", "Ada", withStrokes({ 1: 4 }))]);
    const current = snap([player("p1", "Ada", withStrokes({ 1: 4, 2: 3 }))]);
    const events = diff(previous, current);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("holePosted");
    expect(events[0]!.hole).toBe(2);
    expect(events[0]!.strokes).toBe(3);
    expect(events[0]!.par).toBe(4);
    expect(scoreName(events[0]!)).toBe("Birdie");
    expect(events[0]!.holesCompleted).toBe(2);
  });

  it("emits scoreCorrected when value changes", () => {
    const previous = snap([player("p1", "Ada", withStrokes({ 1: 5 }))]);
    const current = snap([player("p1", "Ada", withStrokes({ 1: 4 }))]);
    const events = diff(previous, current);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("scoreCorrected");
    expect(events[0]!.previousStrokes).toBe(5);
    expect(events[0]!.strokes).toBe(4);
    expect(notificationId(events[0]!)).toBe("p1-r1-h1-c4");
  });

  it("emits roundCompleted when holesCompleted hits 18", () => {
    const almost: Record<number, number> = {};
    for (let h = 1; h <= 17; h++) almost[h] = 4;
    const done: Record<number, number> = { ...almost, 18: 4 };

    const previous = snap([player("p1", "Ada", withStrokes(almost))]);
    const current = snap([player("p1", "Ada", withStrokes(done))]);
    const events = diff(previous, current);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("holePosted");
    expect(kinds).toContain("roundCompleted");
    const complete = events.find((e) => e.kind === "roundCompleted")!;
    expect(complete.playIndex).toBe(HOLE_COUNT);
    expect(notificationId(complete)).toBe("p1-r1-complete");
    expect(headline(complete)).toBe("Ada finished round 1");
  });

  it("skips brand-new players with no prior round (no priorRound)", () => {
    const previous = snap([player("p1", "Ada", withStrokes({ 1: 4 }))]);
    const current = snap([
      player("p1", "Ada", withStrokes({ 1: 4 })),
      player("p2", "Bea", withStrokes({ 1: 3, 2: 4 })),
    ]);
    expect(diff(previous, current)).toEqual([]);
  });
});

describe("diff — shotgun playIndex ordering", () => {
  it("sorts by playIndex not hole number", () => {
    // Player starts on 10. Posts hole 10 then hole 11 in one tick from empty.
    // But previous already has nothing → wait, we need previous with some state.
    // previous: hole 10 posted. current: 10 + 11 + also somehow hole 1?
    // Better: two players posting different holes; order by playIndex.
    const prevRound = withStrokes({}, 10);
    const currA = withStrokes({ 10: 4 }, 10); // playIndex 0
    const currB = withStrokes({ 12: 3 }, 10); // playIndex 2

    // Use two players so both events appear; same starting hole semantics.
    const previous = snap([
      player("a", "Zed", prevRound),
      player("b", "Amy", prevRound),
    ]);
    const current = snap([
      player("a", "Zed", currA),
      player("b", "Amy", currB),
    ]);
    const events = diff(previous, current);
    expect(events.map((e) => e.playerName)).toEqual(["Zed", "Amy"]);
    expect(events[0]!.playIndex).toBeLessThan(events[1]!.playIndex);
  });

  it("orders by playIndex within same player across holes", () => {
    const previous = snap([
      player("p1", "Ada", withStrokes({}, 13)),
    ]);
    // Post hole 1 (playIndex 6) and hole 13 (playIndex 0) in same tick
    const current = snap([
      player("p1", "Ada", withStrokes({ 1: 4, 13: 3 }, 13)),
    ]);
    const events = diff(previous, current);
    expect(events).toHaveLength(2);
    expect(events[0]!.hole).toBe(13);
    expect(events[1]!.hole).toBe(1);
  });
});

describe("filter by FollowTarget", () => {
  const events: ScoreEvent[] = [
    {
      kind: "holePosted",
      playerId: "p1",
      playerName: "Ada",
      teamId: "t1",
      roundId: 1,
      hole: 1,
      playIndex: 0,
      strokes: 3,
      par: 4,
      previousStrokes: null,
      holesCompleted: 1,
    },
    {
      kind: "holePosted",
      playerId: "p2",
      playerName: "Bea",
      teamId: "t2",
      roundId: 1,
      hole: 1,
      playIndex: 0,
      strokes: 4,
      par: 4,
      previousStrokes: null,
      holesCompleted: 1,
    },
  ];

  it("returns empty when follows empty", () => {
    expect(filterEvents(events, [])).toEqual([]);
  });

  it("matches player id", () => {
    const follows: FollowTarget[] = [{ type: "player", id: "p2" }];
    expect(filterEvents(events, follows).map((e) => e.playerId)).toEqual([
      "p2",
    ]);
  });

  it("matches team id", () => {
    const follows: FollowTarget[] = [{ type: "team", id: "t1" }];
    expect(filterEvents(events, follows).map((e) => e.playerId)).toEqual([
      "p1",
    ]);
  });
});

describe("coalesce", () => {
  function make(n: number): ScoreEvent[] {
    return Array.from({ length: n }, (_, i) => ({
      kind: "holePosted" as const,
      playerId: `p${i}`,
      playerName: `Player ${i}`,
      teamId: null,
      roundId: 1,
      hole: 1,
      playIndex: 0,
      strokes: 4,
      par: 4,
      previousStrokes: null,
      holesCompleted: 1,
    }));
  }

  it("returns empty for empty input", () => {
    expect(coalesce([])).toEqual([]);
  });

  it("caps at 4 headlines + and N more", () => {
    const lines = coalesce(make(7), 4);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("and 3 more");
    expect(lines[0]).toContain("Player 0");
  });

  it("does not append more when within limit", () => {
    const lines = coalesce(make(3), 4);
    expect(lines).toHaveLength(3);
  });
});

describe("notificationId + batch", () => {
  it("is deterministic for holePosted", () => {
    const e: ScoreEvent = {
      kind: "holePosted",
      playerId: "abc",
      playerName: "Ada",
      teamId: null,
      roundId: 2,
      hole: 7,
      playIndex: 3,
      strokes: 3,
      par: 4,
      previousStrokes: null,
      holesCompleted: 4,
    };
    expect(notificationId(e)).toBe("abc-r2-h7");
    expect(batchNotificationId("evt", [e])).toBe("abc-r2-h7");
  });

  it("batches multiple with first id", () => {
    const a: ScoreEvent = {
      kind: "holePosted",
      playerId: "a",
      playerName: "A",
      teamId: null,
      roundId: 1,
      hole: 1,
      playIndex: 0,
      strokes: 4,
      par: 4,
      previousStrokes: null,
      holesCompleted: 1,
    };
    const b = { ...a, playerId: "b", playerName: "B", hole: 2 };
    expect(batchNotificationId("evt-9", [a, b])).toBe("evt-9-batch-a-r1-h1");
  });
});

describe("holesCompleted", () => {
  it("counts non-null strokes", () => {
    expect(holesCompleted(withStrokes({ 1: 4, 5: 3, 18: 5 }))).toBe(3);
  });
});

describe("headline formatting", () => {
  it("formats holePosted with score name", () => {
    const e: ScoreEvent = {
      kind: "holePosted",
      playerId: "p1",
      playerName: "Ada Lovelace",
      teamId: null,
      roundId: 1,
      hole: 7,
      playIndex: 6,
      strokes: 3,
      par: 4,
      previousStrokes: null,
      holesCompleted: 5,
    };
    expect(headline(e)).toBe(
      "Ada Lovelace — Birdie on 7 (3) · thru 5"
    );
  });
});
