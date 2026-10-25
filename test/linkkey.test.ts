// The link key: the challenge, the KEY0 answer, and a key that is missing, right or refused.

import * as crypto from "node:crypto";
import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceSession } from "../electron/device/session.cjs";
import { findLinkChallenge, linkAnswer } from "../electron/device/netlink.cjs";
import {
  answerLinkKey,
  forgetDeclinedLinkKeys,
  linkKeyRequest,
  linkKeyValid,
  requestLinkKey,
} from "../src/state/linkKey";
import { LinkKeyCard } from "../src/components/LinkKeyDialog";
import { clearTerminal, terminalLines } from "../src/state/terminal";
import { ascii, tlv, u32 } from "./bytes";

const KEY = "correct horse battery";
const CHALLENGE = Buffer.from(Array.from({ length: 16 }, (_, i) => i));

const frame = (meta: number[]) =>
  Buffer.from([...ascii("DNV0"), ...u32(0), ...u32(meta.length), ...u32(0), ...u32(0), ...meta]);
const challengeFrame = (challenge: Buffer) => frame(tlv(0x23, [...challenge]));
const expectedMac = (key: string, challenge: Buffer) =>
  crypto.createHmac("sha256", key).update("N6LINK1").update(challenge).digest();

describe("the KEY0 answer", () => {
  it("matches the core's bench tool (link_answer in n6bench.py)", () => {
    const answer = linkAnswer(Buffer.from(KEY), CHALLENGE);
    expect(answer.subarray(0, 4).toString("latin1")).toBe("KEY0");
    expect(answer.subarray(4).toString("hex")).toBe(
      "9c4f512176e1e33c285f07270aab52560248e14fddf99b48656eeb959e0511c2",
    );
  });

  it("recognises a challenge frame's metadata and nothing else", () => {
    expect(findLinkChallenge(Buffer.from(tlv(0x23, [...CHALLENGE])))).toEqual(CHALLENGE);
    expect(findLinkChallenge(Buffer.from(tlv(0x23, [1, 2, 3])))).toBeNull();
    expect(findLinkChallenge(Buffer.from(tlv(0x20, [...CHALLENGE])))).toBeNull();
    // The challenge alone: a second TLV makes it some other frame.
    expect(findLinkChallenge(Buffer.from([...tlv(0x23, [...CHALLENGE]), 0x17, 0, 0]))).toBeNull();
  });
});

/** No reconnect loops: the test drives every connect. */
class QuietSession extends DeviceSession {
  _startLoops() {}
}

interface Emitted {
  t: string;
  host?: string;
  wrong?: boolean;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function track() {
  const session = new QuietSession();
  cleanups.push(() => session.stop());
  const events: Emitted[] = [];
  session.on("event", (e: Emitted) => events.push(e));
  return { session, events, asked: () => events.filter((e) => e.t === "link_key_needed") };
}

/** A keyed board: its challenge on connect, then a stream for the right answer or a close. */
async function keyedBoard(key: string) {
  const answers: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.write(challengeFrame(CHALLENGE));
    let pending = Buffer.alloc(0);
    socket.on("data", (data) => {
      pending = Buffer.concat([pending, data]);
      if (pending.length < 20 + 36) return;
      const answer = pending.subarray(20, 56);
      answers.push(Buffer.from(answer));
      const right =
        pending.subarray(0, 4).toString("latin1") === "DNV0" &&
        pending.readUInt32LE(12) === 36 &&
        answer.subarray(0, 4).toString("latin1") === "KEY0" &&
        answer.subarray(4).equals(expectedMac(key, CHALLENGE));
      if (right) socket.write(frame(tlv(0x17, ascii("attached\n"))));
      else socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as net.AddressInfo).port, answers };
}

describe("the session and a keyed board", () => {
  it("answers with the key it holds for the board, and gets the stream", async () => {
    const board = await keyedBoard(KEY);
    const { session, events, asked } = track();
    session.setLinkKey("127.0.0.1", KEY);

    await session.openTcp({ host: "127.0.0.1", port: board.port });

    await vi.waitFor(() => expect(events.some((e) => e.t === "meta")).toBe(true));
    expect(board.answers).toHaveLength(1);
    expect(asked()).toEqual([]);
  });

  it("asks for a key it does not have, and answers the waiting challenge once given one", async () => {
    const board = await keyedBoard(KEY);
    const { session, events, asked } = track();

    await session.openTcp({ host: "127.0.0.1", port: board.port });
    await vi.waitFor(() =>
      expect(asked()).toEqual([{ t: "link_key_needed", host: "127.0.0.1", wrong: false }]),
    );
    expect(board.answers).toEqual([]);

    session.setLinkKey("127.0.0.1", KEY);
    await vi.waitFor(() => expect(events.some((e) => e.t === "meta")).toBe(true));
    expect(board.answers).toHaveLength(1);
  });

  it("reports a key the board refused, and stops offering it", async () => {
    const board = await keyedBoard(KEY);
    const { session, asked } = track();
    session.setLinkKey("127.0.0.1", "not the key at all");

    await session.openTcp({ host: "127.0.0.1", port: board.port });

    await vi.waitFor(() =>
      expect(asked()).toEqual([{ t: "link_key_needed", host: "127.0.0.1", wrong: true }]),
    );
    expect(session.linkKeys.has("127.0.0.1")).toBe(false);
  });
});

describe("the link key prompt", () => {
  const given: Array<[string, string]> = [];

  beforeEach(() => {
    given.length = 0;
    vi.stubGlobal("window", {
      neuro: { setLinkKey: (host: string, key: string) => given.push([host, key]) },
    });
    answerLinkKey(null);
    forgetDeclinedLinkKeys();
    clearTerminal();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("takes 8 to 64 bytes of text", () => {
    expect(linkKeyValid("1234567")).toBe(false);
    expect(linkKeyValid("12345678")).toBe(true);
    expect(linkKeyValid("x".repeat(64))).toBe(true);
    expect(linkKeyValid("x".repeat(65))).toBe(false);
    expect(linkKeyValid("éééé")).toBe(true); // 4 characters, 8 bytes
  });

  it("gives the typed key to the board that asked", () => {
    requestLinkKey("192.168.1.50", false);
    expect(linkKeyRequest.get()).toEqual({ host: "192.168.1.50", wrong: false });
    answerLinkKey(KEY);
    expect(given).toEqual([["192.168.1.50", KEY]]);
    expect(linkKeyRequest.get()).toBeNull();
  });

  it("asks once at a time", () => {
    requestLinkKey("192.168.1.50", false);
    requestLinkKey("192.168.1.51", false);
    expect(linkKeyRequest.get()!.host).toBe("192.168.1.50");
  });

  it("does not ask again about a board whose prompt was cancelled, unless it refused a key", () => {
    requestLinkKey("192.168.1.50", false);
    answerLinkKey(null);
    expect(terminalLines()).toContain("[host] 192.168.1.50 wants a link key; none given");

    requestLinkKey("192.168.1.50", false);
    expect(linkKeyRequest.get()).toBeNull();

    forgetDeclinedLinkKeys();
    requestLinkKey("192.168.1.50", false);
    expect(linkKeyRequest.get()).not.toBeNull();
  });

  it("says when the board refused the key", () => {
    const html = renderToStaticMarkup(
      createElement(LinkKeyCard, {
        request: { host: "192.168.1.50", wrong: true },
        onAnswer: () => undefined,
      }),
    );
    expect(html).toContain("The board at 192.168.1.50");
    expect(html).toContain("The board refused the key it was given.");
    expect(html).toContain('type="password"');
  });
});
