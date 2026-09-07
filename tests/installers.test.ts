import { describe, it, expect } from "bun:test";
import { pickInstaller } from "../src/installers/index.ts";
import { ConfigStore } from "../src/state/config.ts";
import { join } from "node:path";

const ctx = { appName: "test", version: "1.0", appsRoot: "/tmp/gri-test/apps", binDir: "/tmp/gri-test/bin" };

describe("installers detection", () => {
  it("按扩展名选择安装器", () => {
    expect(pickInstaller("/tmp/x.AppImage", {}, ctx)?.constructor.name).toBe("AppImageInstaller");
    expect(pickInstaller("/tmp/x.rpm", {}, ctx)?.constructor.name).toBe("RpmInstaller");
    expect(pickInstaller("/tmp/x.deb", {}, ctx)?.constructor.name).toBe("DebInstaller");
    expect(pickInstaller("/tmp/x.tar.gz", {}, ctx)?.constructor.name).toBe("ArchiveInstaller");
    expect(pickInstaller("/tmp/x.zip", {}, ctx)?.constructor.name).toBe("ArchiveInstaller");
    expect(pickInstaller("/tmp/x", {}, ctx)?.constructor.name).toBe("RawExeInstaller");
  });

  it("installDir 默认路径", () => {
    const inst = pickInstaller("/tmp/x.tar.gz", {}, ctx)!;
    expect(inst.installDir).toBe(join(ctx.appsRoot, "test", "1.0"));
  });

  it("layout.rootDir 覆盖安装目录", () => {
    const inst = pickInstaller("/tmp/x.tar.gz", { rootDir: "/custom/dir" }, ctx)!;
    expect(inst.installDir).toBe("/custom/dir");
  });
});
