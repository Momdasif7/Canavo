import { describe, expect, it } from "vitest";
import { ipAllowed, ipMatches, normalizeIp } from "./ip-whitelist";

describe("ip whitelist matching", () => {
  it("normalizes IPv4-mapped IPv6", () => {
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp("::1")).toBe("::1");
  });
  it("matches exact addresses and CIDRs", () => {
    expect(ipMatches("::ffff:192.168.1.20", "192.168.1.0/24")).toBe(true);
    expect(ipMatches("192.168.2.20", "192.168.1.0/24")).toBe(false);
    expect(ipMatches("10.1.2.3", "10.1.2.3")).toBe(true);
    expect(ipMatches("10.1.2.3", "0.0.0.0/0")).toBe(true);
    expect(ipMatches("::1", "::1")).toBe(true);
    expect(ipMatches("2001:db8::5", "2001:db8::/32")).toBe(true);
    expect(ipMatches("2001:db9::5", "2001:db8::/32")).toBe(false);
    expect(ipMatches("10.0.0.1", "::1")).toBe(false);
  });
  it("allows everything when the list is empty", () => {
    expect(ipAllowed("1.2.3.4", [])).toBe(true);
    expect(ipAllowed("1.2.3.4", ["5.6.7.8"])).toBe(false);
  });
});
