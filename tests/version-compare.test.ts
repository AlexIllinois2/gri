import { describe, it, expect } from "bun:test";
import { compareVersions, isNewer, isUpToDate } from "../src/core/version-compare.ts";

describe("version-compare", () => {
  it("数值段比较", () => {
    expect(compareVersions("1.5.3", "1.5.2")).toBe(1);
    expect(compareVersions("1.5.2", "1.5.3")).toBe(-1);
    expect(compareVersions("1.5.3", "1.5.3")).toBe(0);
  });

  it("忽略 v 前缀", () => {
    expect(compareVersions("v1.5.3", "1.5.3")).toBe(0);
    expect(compareVersions("v2.0.0", "1.9.9")).toBe(1);
  });

  it("非 semver 形式也能比较", () => {
    expect(compareVersions("2026.08.15", "2026.08.14")).toBe(1);
    expect(compareVersions("b10545", "b10544")).toBe(1);
    // 数字/正式版优先于字母后缀的预发布：1.0 晚于 1.0a
    expect(compareVersions("v1.0", "v1.0a")).toBe(1);
  });

  it("数字段长于字母段", () => {
    expect(compareVersions("1.0", "rc1")).toBe(1);
  });

  it("辅助函数", () => {
    expect(isNewer("2.0", "1.0")).toBe(true);
    expect(isUpToDate("2.0", "1.0")).toBe(true);
    expect(isUpToDate("1.0", "2.0")).toBe(false);
  });
});
