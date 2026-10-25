// Board events, TLV 0x67: the 17-byte record, and folding repeated announces by id.

import { describe, expect, it } from "vitest";
import {
  boardEventSourcesLabel,
  boardEventStateLabel,
  kBoardEventsKept,
  kMetaEvent,
  mergeBoardEvent,
  parseOverlayMeta,
  type BoardEvent,
} from "../src/device/tlv";
import { bytes, tlv, u16, u32 } from "./bytes";

interface EventSpec {
  id: number;
  tMs?: number;
  sources?: number;
  state?: number;
  score?: number;
  preFrames?: number;
  postFrames?: number;
  sinksOk?: number;
}

function eventValue(e: EventSpec): number[] {
  return [
    ...u32(e.id),
    ...u32(e.tMs ?? 0),
    e.sources ?? 0,
    e.state ?? 0,
    ...u16(e.score ?? 0),
    ...u16(e.preFrames ?? 0),
    ...u16(e.postFrames ?? 0),
    e.sinksOk ?? 0,
  ];
}

const event = (e: EventSpec) => tlv(kMetaEvent, eventValue(e));

function boardEvent(id: number, receivedAt: number, state = 0): BoardEvent {
  return {
    id,
    tMs: id * 100,
    sources: 0,
    state,
    score: 0,
    preFrames: 0,
    postFrames: 0,
    sinksOk: 0,
    receivedAt,
  };
}

describe("META_EVENT (0x67) decode", () => {
  it("decodes every field of the 17-byte record", () => {
    const before = Date.now();
    const parsed = parseOverlayMeta(
      bytes(
        event({
          id: 0xfffffffe,
          tMs: 0x80000001,
          sources: 0b0000_0101,
          state: 2,
          score: 65535,
          preFrames: 30,
          postFrames: 90,
          sinksOk: 0b11,
        }),
      ),
    );

    expect(parsed.boardEvents).toHaveLength(1);
    const ev = parsed.boardEvents![0];
    expect(ev).toMatchObject({
      id: 0xfffffffe,
      tMs: 0x80000001,
      sources: 5,
      state: 2,
      score: 65535,
      preFrames: 30,
      postFrames: 90,
      sinksOk: 3,
    });
    expect(ev.receivedAt).toBeGreaterThanOrEqual(before);
    expect(ev.receivedAt).toBeLessThanOrEqual(Date.now());
  });

  it("ignores id 0 and a record shorter than 17 bytes", () => {
    expect(parseOverlayMeta(bytes(event({ id: 0, state: 1 }))).boardEvents).toBeUndefined();

    const value = eventValue({ id: 5 });
    expect(
      parseOverlayMeta(bytes(tlv(kMetaEvent, value.slice(0, 16)))).boardEvents,
    ).toBeUndefined();
  });

  it("reads the first 17 bytes of a longer record", () => {
    // The firmware may append fields.
    const value = eventValue({ id: 5, state: 3, sinksOk: 1 });
    const parsed = parseOverlayMeta(
      bytes(tlv(kMetaEvent, [...value, 0xaa, 0xbb]), event({ id: 6 })),
    );
    expect(parsed.boardEvents!.map((e) => e.id)).toEqual([5, 6]);
    expect(parsed.boardEvents![0]).toMatchObject({ state: 3, sinksOk: 1 });
  });

  it("keeps every event in a buffer, in wire order", () => {
    const parsed = parseOverlayMeta(bytes(event({ id: 3 }), event({ id: 0 }), event({ id: 4 })));
    expect(parsed.boardEvents!.map((e) => e.id)).toEqual([3, 4]);
  });

  it("labels sources and state", () => {
    const ev = boardEvent(1, 0);
    expect(boardEventSourcesLabel({ ...ev, sources: 0 })).toBe("none");
    expect(boardEventSourcesLabel({ ...ev, sources: 0b1000_0011 })).toBe("motion + NN + host");
    expect(boardEventStateLabel({ ...ev, state: 1 })).toBe("post-roll");
    expect(boardEventStateLabel({ ...ev, state: 9 })).toBe("state 9");
  });
});

describe("mergeBoardEvent", () => {
  it("puts a new id at the front", () => {
    let list: BoardEvent[] = [];
    list = mergeBoardEvent(list, boardEvent(1, 1000));
    list = mergeBoardEvent(list, boardEvent(2, 2000));
    expect(list.map((e) => e.id)).toEqual([2, 1]);
  });

  it("updates a re-announced id in place and keeps its first receivedAt", () => {
    let list = [boardEvent(2, 2000), boardEvent(1, 1000, 0)];
    list = mergeBoardEvent(list, boardEvent(1, 5000, 3));
    expect(list.map((e) => e.id)).toEqual([2, 1]);
    expect(list[1].state).toBe(3);
    expect(list[1].receivedAt).toBe(1000);
  });

  it("does not mutate the list it was given", () => {
    const list = [boardEvent(1, 1000)];
    const next = mergeBoardEvent(list, boardEvent(1, 2000, 2));
    expect(next).not.toBe(list);
    expect(list[0].state).toBe(0);
  });

  it(`keeps the newest ${kBoardEventsKept}`, () => {
    let list: BoardEvent[] = [];
    for (let id = 1; id <= kBoardEventsKept + 5; id++)
      list = mergeBoardEvent(list, boardEvent(id, id));
    expect(list).toHaveLength(kBoardEventsKept);
    expect(list[0].id).toBe(kBoardEventsKept + 5);
    expect(list[kBoardEventsKept - 1].id).toBe(6);

    // A re-announce of a kept id does not push anything out.
    list = mergeBoardEvent(list, boardEvent(6, 999, 2));
    expect(list).toHaveLength(kBoardEventsKept);
    expect(list[kBoardEventsKept - 1]).toMatchObject({ id: 6, state: 2, receivedAt: 6 });
  });
});
