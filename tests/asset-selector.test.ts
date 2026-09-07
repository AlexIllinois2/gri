import { describe, it, expect } from "bun:test";
import { Asset } from "../src/core/github-client.ts";
import { matches, autoCandidates, assetPriority, filterByConditions } from "../src/core/asset-selector.ts";
import { FilterCond } from "../src/types.ts";
import { systemInfo } from "../src/core/osinfo.ts";

const a = (name: string): Asset => ({ name, download_url: "https://x/" + name });

describe("asset-selector", () => {
  it("arch 别名匹配", () => {
    const cond: FilterCond = { field: "arch", op: "in", value: ["x86_64", "amd64", "x86-64"] };
    expect(matches(a("app-linux-amd64.tar.gz"), cond)).toBe(true);
    expect(matches(a("app-linux-arm64.tar.gz"), cond)).toBe(false);
  });

  it("ext 匹配", () => {
    const cond: FilterCond = { field: "ext", op: "eq", value: ["tar.gz"] };
    expect(matches(a("app.tar.gz"), cond)).toBe(true);
    expect(matches(a("app.zip"), cond)).toBe(false);
    const deb: FilterCond = { field: "ext", op: "eq", value: ["deb"] };
    expect(matches(a("app.deb"), deb)).toBe(true);
  });

  it("os 匹配", () => {
    const cond: FilterCond = { field: "os", op: "in", value: [systemInfo.os] };
    expect(matches(a("app-linux.tar.gz"), cond)).toBe(systemInfo.os === "linux");
  });

  it("contains / excludes", () => {
    expect(matches(a("app-linux_amd64.tar.gz"), { field: "contains", op: "contains", value: "linux" })).toBe(true);
    expect(matches(a("app-linux_amd64.tar.gz"), { field: "excludes", op: "excludes", value: "musl" })).toBe(true);
    expect(matches(a("app-musl.tar.gz"), { field: "excludes", op: "excludes", value: "musl" })).toBe(false);
  });

  it("autoCandidates 收敛到当前系统", () => {
    const assets = [
      a("mypackage-x86_64-unknown-linux-musl.tar.gz"),
      a("mypackage-x86_64-apple-darwin.tar.gz"),
      a("mypackage-arm-unknown-linux-gnueabihf.tar.gz"),
    ];
    const r = autoCandidates(assets, systemInfo);
    if (systemInfo.os === "linux" && systemInfo.arch === "x86_64") {
      expect(r[0].name).toBe("mypackage-x86_64-unknown-linux-musl.tar.gz");
    } else {
      // 至少不报错且返回数组
      expect(Array.isArray(r)).toBe(true);
    }
  });

  it("优先级：musl+archive 最优先", () => {
    expect(assetPriority(a("x-musl.tar.gz"))).toBeLessThan(assetPriority(a("x.tar.gz")));
    expect(assetPriority(a("x.tar.gz"))).toBeLessThan(assetPriority(a("x")));
  });

  it("filterByConditions 组合", () => {
    const assets = [a("fzf-0.55.0-linux_amd64.tar.gz"), a("fzf-0.55.0-darwin_arm64.tar.gz")];
    const conds: FilterCond[] = [
      { field: "contains", op: "contains", value: "linux" },
      { field: "arch", op: "in", value: ["amd64", "x86_64"] },
    ];
    expect(filterByConditions(assets, conds).length).toBe(1);
  });
});
