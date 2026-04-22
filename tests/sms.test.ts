import { describe, expect, it } from "vitest";
import { smsSegments } from "@/lib/sms-segments";

describe("smsSegments", () => {
  it("counts a short GSM message as 1 segment", () => {
    expect(smsSegments("Hello")).toBe(1);
  });

  it("splits >160 GSM chars into 153-char segments", () => {
    const body = "a".repeat(161);
    expect(smsSegments(body)).toBe(2);
  });

  it("treats emoji as unicode (UCS-2 units)", () => {
    expect(smsSegments("hi 👋")).toBe(1);
    // Each emoji is a 2-unit surrogate pair; 40 emojis => 80 units => 2 segments.
    expect(smsSegments("👋".repeat(40))).toBe(Math.ceil(80 / 67));
  });
});
