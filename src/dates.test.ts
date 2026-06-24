import { describe, expect, it } from "vitest";
import { parseNaturalDate } from "./dates";

const now = new Date(2026, 5, 18); // jueves 2026-06-18 (local)

describe("parseNaturalDate", () => {
  it("resolves today and tomorrow", () => {
    expect(parseNaturalDate("hoy", now)).toBe("2026-06-18");
    expect(parseNaturalDate("mañana", now)).toBe("2026-06-19");
    expect(parseNaturalDate("pasado mañana", now)).toBe("2026-06-20");
  });
  it("resolves the next weekday", () => {
    expect(parseNaturalDate("viernes", now)).toBe("2026-06-19");
    expect(parseNaturalDate("jueves", now)).toBe("2026-06-25"); // próximo, no hoy
  });
  it("resolves 'en N días' and 'in N days'", () => {
    expect(parseNaturalDate("en 3 días", now)).toBe("2026-06-21");
    expect(parseNaturalDate("in 3 days", now)).toBe("2026-06-21");
  });
  it("accepts ISO literals and rejects garbage", () => {
    expect(parseNaturalDate("2026-07-01", now)).toBe("2026-07-01");
    expect(parseNaturalDate("zzz", now)).toBeNull();
    expect(parseNaturalDate("", now)).toBeNull();
  });
});
