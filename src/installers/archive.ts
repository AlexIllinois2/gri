import { BaseInstaller, BinSpec } from "./base.ts";
import { ARCHIVE_EXTS } from "../core/install-utils.ts";
import { run, commandExists } from "../util/exec.ts";
import { log } from "../util/log.ts";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";

type ArchiveFormat = (typeof ARCHIVE_EXTS)[number];

function detectFormat(p: string): ArchiveFormat | null {
  const n = p.toLowerCase();
  return ARCHIVE_EXTS.find((ext) => n.endsWith(ext)) ?? null;
}

/** 解压归档到 installDir，并应用 stripComponents */
export async function extractArchive(assetPath: string, installDir: string, strip: number): Promise<void> {
  Bun.spawnSync(["mkdir", "-p", installDir]);
  const fmt = detectFormat(assetPath);
  if (!fmt) throw new Error(`无法识别的归档格式：${assetPath}`);

  if (fmt === ".zip") {
    if (commandExists("unzip")) {
      const tmp = installDir + ".extract";
      Bun.spawnSync(["rm", "-rf", tmp]);
      Bun.spawnSync(["mkdir", "-p", tmp]);
      const r = run("unzip", ["-o", assetPath, "-d", tmp]);
      if (!r.ok) throw new Error(`unzip 失败：${r.stderr.slice(0, 200)}`);
      moveUp(tmp, installDir, strip);
    } else {
      // 无 unzip：尝试 python
      const r = run("python3", ["-c", `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, assetPath, installDir]);
      if (!r.ok) throw new Error("缺少 unzip 且 python3 不可用，无法解压 zip");
    }
    return;
  }

  // tar 系列：xz 走 tar 自动识别，bz2 用 -j，其余 gzip
  const flag = fmt === ".tar.xz" ? "xf" : fmt.endsWith("bz2") || fmt.endsWith("bz") ? "xjf" : "xzf";
  const r = run("tar", [`-${flag}`, assetPath, "-C", installDir, "--strip-components", String(strip)]);
  if (!r.ok) {
    // 失败再尝试不 strip
    const r2 = run("tar", [`-${flag}`, assetPath, "-C", installDir]);
    if (!r2.ok) throw new Error(`tar 解压失败：${r.stderr.slice(0, 200)}`);
  }
}

function moveUp(srcDir: string, destDir: string, strip: number) {
  // 收集 srcDir 顶层条目
  let entries = listDir(srcDir);
  for (let i = 0; i < strip && entries.length === 1 && existsSync(join(srcDir, entries[0])); i++) {
    srcDir = join(srcDir, entries[0]);
    entries = listDir(srcDir);
  }
  Bun.spawnSync(["mkdir", "-p", destDir]);
  for (const e of entries) {
    Bun.spawnSync(["mv", "-f", join(srcDir, e), join(destDir, e)]);
  }
  Bun.spawnSync(["rm", "-rf", srcDir]);
}

function listDir(d: string): string[] {
  const r = run("ls", ["-A", d]);
  return r.ok ? r.stdout.split("\n").filter(Boolean) : [];
}

/** 扫描 installDir 下可执行文件，返回相对路径 */
export function findExecutables(installDir: string): string[] {
  const r = run("find", [installDir, "-type", "f", "-perm", "-u+x"]);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(installDir + "/", ""))
    .filter((p) => !p.endsWith(".desktop") && !p.endsWith(".service") && !p.includes("/."));
}

export class ArchiveInstaller extends BaseInstaller {
  detectType(): boolean {
    return detectFormat(this.assetPath) !== null;
  }

  async extract(): Promise<void> {
    const strip = this.layout.stripComponents ?? 1;
    await extractArchive(this.assetPath, this.installDir, strip);
  }

  async collectBins(): Promise<BinSpec[]> {
    if (this.layout.bins && this.layout.bins.length) {
      return this.layout.bins.map((b) => (typeof b === "string" ? { path: b } : b));
    }
    const exes = findExecutables(this.installDir);
    if (exes.length === 0) return [];
    // 优先 bin/ 下或名称含 appName 的
    const preferred = exes.filter((p) => p.startsWith("bin/") || p.toLowerCase().includes(this.ctx.appName.toLowerCase()));
    const chosen = preferred.length ? preferred : exes;
    return chosen.map((p) => ({ path: p }));
  }
}
