import { describe, expect, it } from "vitest";
import { isPositiveNumberField, parseNumberField } from "../src/lib/number-field";

describe("parseNumberField", () => {
  it("returns empty string for empty input", () => {
    expect(parseNumberField("")).toBe("");
  });

  it("parses a positive integer string", () => {
    expect(parseNumberField("120")).toBe(120);
  });

  it("parses zero", () => {
    expect(parseNumberField("0")).toBe(0);
  });

  it("parses a decimal string", () => {
    expect(parseNumberField("12.5")).toBe(12.5);
  });
});

describe("isPositiveNumberField", () => {
  it("returns false for empty string", () => {
    expect(isPositiveNumberField("")).toBe(false);
  });

  it("returns false for zero", () => {
    expect(isPositiveNumberField(0)).toBe(false);
  });

  it("returns false for a negative number", () => {
    expect(isPositiveNumberField(-3)).toBe(false);
  });

  it("returns false for NaN", () => {
    expect(isPositiveNumberField(NaN)).toBe(false);
  });

  it("returns true for 1", () => {
    expect(isPositiveNumberField(1)).toBe(true);
  });

  it("returns true for a positive number", () => {
    expect(isPositiveNumberField(120)).toBe(true);
  });
});
