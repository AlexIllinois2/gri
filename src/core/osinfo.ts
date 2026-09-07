import { OS } from "../types.ts";
import { readFileSync } from "node:fs";

export interface SystemInfo {
  os: OS;
  /** 原始 machine 字符串，如 x86_64 / aarch64 */
  platform: string;
  /** 归一化架构：x86_64 | arm64 | arm */
  arch: string;
  archAliases: string[];
  /** linux 发行版 id（ubuntu/fedora...），非 linux 同 os */
  distro: string;
  libc: "gnu" | "musl" | "unknown";
}

/** 字符串是否包含某 arch 的任一别名（dra 的 is_same_arch 移植） */
const ARCH_ALIASES: Record<string, string[]> = {
  x86_64: ["x86_64", "x86-64", "amd64", "x64"],
  arm64: ["aarch64", "arm64"],
  arm: ["arm", "armv6", "armv7", "armhf"],
};

export function archAliasesFor(arch: string): string[] {
  return ARCH_ALIASES[arch] ?? [arch];
}

function detectLibc(): "gnu" | "musl" | "unknown" {
  try {
    const out = Bun.spawnSync(["ldd", "--version"], { stderr: "pipe", stdout: "pipe" });
    const text = new TextDecoder().decode(out.stderr ?? new Uint8Array());
    if (/musl/i.test(text)) return "musl";
  } catch {
    /* ignore */
  }
  if (Bun.env.LIBC === "musl") return "musl";
  return "gnu";
}

function detectPlatform(): string {
  try {
    const out = Bun.spawnSync(["uname", "-m"], { stdout: "pipe" });
    const text = new TextDecoder().decode(out.stdout ?? new Uint8Array()).trim();
    if (text) return text;
  } catch {
    /* ignore */
  }
  return "x86_64";
}

function detectDistro(os: OS): string {
  if (os !== "linux") return os;
  try {
    const text = readFileSync("/etc/os-release", "utf8");
    const idLine = text.split("\n").find((l) => l.startsWith("ID="));
    if (idLine) return idLine.split("=")[1].trim().replace(/"/g, "").toLowerCase();
  } catch {
    /* ignore */
  }
  return "unknown";
}

function buildSystemInfo(): SystemInfo {
  const rawPlatform = process.platform; // "linux" | "darwin" | "win32"
  const os: OS = rawPlatform === "linux" ? "linux" : rawPlatform === "darwin" ? "macos" : "windows";
  const platform = detectPlatform();

  let arch = "x86_64";
  if (/aarch64|arm64/i.test(platform)) arch = "arm64";
  else if (/arm/i.test(platform)) arch = "arm";
  else arch = "x86_64";

  return {
    os,
    platform,
    arch,
    archAliases: archAliasesFor(arch),
    distro: detectDistro(os),
    libc: detectLibc(),
  };
}

export const systemInfo: SystemInfo = buildSystemInfo();
