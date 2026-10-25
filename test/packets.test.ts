import { describe, expect, it } from "vitest";
import { kEvidenceCrop, buildEvidenceSubscriptionPacket } from "../src/device/packets";

describe("SUB0 evidence subscription", () => {
  it("writes the magic then the mask, both u32 LE", () => {
    expect(kEvidenceCrop).toBe(1);
    expect([...buildEvidenceSubscriptionPacket(kEvidenceCrop)]).toEqual([
      0x53,
      0x55,
      0x42,
      0x30, // 'SUB0'
      0x01,
      0x00,
      0x00,
      0x00,
    ]);
  });

  it("unsubscribes with mask 0", () => {
    expect([...buildEvidenceSubscriptionPacket(0)]).toEqual([0x53, 0x55, 0x42, 0x30, 0, 0, 0, 0]);
  });

  it("carries the full 32-bit mask", () => {
    expect([...buildEvidenceSubscriptionPacket(0x80000102)].slice(4)).toEqual([
      0x02, 0x01, 0x00, 0x80,
    ]);
  });
});
