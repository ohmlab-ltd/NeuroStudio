// The network link: command framing.

import { describe, expect, it } from "vitest";
import { frameHostCommand } from "../electron/device/netlink.cjs";

describe("frameHostCommand", () => {
  it("puts the command behind a header with meta_len 0 and payload_len its length", () => {
    const frame = frameHostCommand(Buffer.from("TUN0\x01\x00\x10\x27\x00\x00", "latin1"));
    expect(frame.length).toBe(30);
    expect(frame.subarray(0, 4).toString("latin1")).toBe("DNV0");
    expect(frame.readUInt32LE(8)).toBe(0);
    expect(frame.readUInt32LE(12)).toBe(10);
    expect(frame.subarray(20).toString("latin1")).toBe("TUN0\x01\x00\x10\x27\x00\x00");
  });
});
