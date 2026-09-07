import { describe, it, expect } from "bun:test";
import { untag, tag } from "../src/core/untag.ts";

describe("untag", () => {
  it("把版本段替换为 {tag}", () => {
    expect(untag("1.5.3", "file-1.5.3-linux.deb")).toBe("file-{tag}-linux.deb");
    expect(untag("v1.5.3", "file-v1.5.3-linux.deb")).toBe("file-v{tag}-linux.deb");
    expect(untag("v1.5.3", "file-1.5.3-linux.deb")).toBe("file-{tag}-linux.deb");
  });

  it("无版本时不替换", () => {
    expect(untag("v1.5.3", "file-linux.deb")).toBe("file-linux.deb");
  });

  it("tag 反向还原", () => {
    expect(tag("1.5.3", "file-{tag}-linux.deb")).toBe("file-1.5.3-linux.deb");
  });
});
