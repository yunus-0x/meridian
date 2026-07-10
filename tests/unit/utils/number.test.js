import { describe, it, expect } from "vitest";
import { safeNumber } from "../../../utils/number.js";

describe("safeNumber", () => {
  it("returns the number for a valid integer", () => {
    expect(safeNumber(42)).toBe(42);
  });

  it("returns the number for a valid float", () => {
    expect(safeNumber(3.14)).toBe(3.14);
  });

  it("returns the number for a numeric string", () => {
    expect(safeNumber("42")).toBe(42);
  });

  it("returns the number for a float string", () => {
    expect(safeNumber("3.14")).toBe(3.14);
  });

  it("returns the number for negative values", () => {
    expect(safeNumber(-5)).toBe(-5);
  });

  it("returns 0 for zero", () => {
    expect(safeNumber(0)).toBe(0);
  });

  it("returns fallback for NaN", () => {
    expect(safeNumber(NaN, 0)).toBe(0);
  });

  it("returns fallback for Infinity", () => {
    expect(safeNumber(Infinity, -1)).toBe(-1);
  });

  it("returns fallback for -Infinity", () => {
    expect(safeNumber(-Infinity, 99)).toBe(99);
  });

  it("returns 0 for null (Number(null) = 0)", () => {
    expect(safeNumber(null, "default")).toBe(0);
  });

  it("returns null fallback for undefined", () => {
    expect(safeNumber(undefined)).toBeNull();
  });

  it("returns fallback for non-numeric string", () => {
    expect(safeNumber("abc", 0)).toBe(0);
  });

  it("returns 0 for empty string (Number('') = 0)", () => {
    expect(safeNumber("", 1)).toBe(0);
  });

  it("returns fallback for object", () => {
    expect(safeNumber({}, "fallback")).toBe("fallback");
  });

  it("returns 0 for array (Number([]) = 0)", () => {
    expect(safeNumber([], -1)).toBe(0);
  });

  it("returns 1 for boolean true (Number(true) = 1)", () => {
    expect(safeNumber(true, 10)).toBe(1);
  });

  it("returns 0 for boolean false (Number(false) = 0)", () => {
    expect(safeNumber(false, 10)).toBe(0);
  });

  it("returns null default fallback when none provided", () => {
    expect(safeNumber("not-a-number")).toBeNull();
  });
});
