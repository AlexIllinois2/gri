import { LayoutSpec } from "../types.ts";
import { systemInfo } from "../core/osinfo.ts";
import { log } from "../util/log.ts";
import { run } from "../util/exec.ts";
import { writeText } from "../util/io.ts";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { existsSync } from "node:fs";

export interface InstallContext {
  appName: string;
  version: string;
  appsRoot: string;
  binDir: string;
}

export interface BinSpec {
  path: string;
  as?: string;
}

export interface PostInstallResult {
  binLinks: string[];
  desktopLinks: string[];
  serviceLink?: string;
  autostartLink?: string;
  iconPath?: string;
}

/** 跨平台 XDG 目录 */
function xdgDirs() {
  const home = homedir();
  return {
    desktop: join(home, ".local", "share", "applications"),
    systemd: join(home, ".config", "systemd", "user"),
    autostart: join(home, ".config", "autostart"),
  };
}

export function createSymlink(source: string, target: string): boolean {
  if (!existsSync(source)) {
    log.warn(`源文件不存在，跳过软链：${source}`);
    return false;
  }
  try {
    if (existsSync(target) || isSymlink(target)) {
      const resolved = resolveSymlink(target);
      if (resolved === source) {
        log.step(`软链已指向正确目标，跳过：${target}`);
        return true;
      }
      Bun.spawnSync(["rm", "-f", target]);
    }
    Bun.spawnSync(["mkdir", "-p", dirname(target)]);
    Bun.spawnSync(["ln", "-s", source, target]);
    log.info(`创建软链：${target} -> ${source}`);
    return true;
  } catch (e) {
    log.warn(`创建软链失败 ${target}: ${String(e)}`);
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    const st = Bun.spawnSync(["test", "-L", p]);
    return st.exitCode === 0;
  } catch {
    return false;
  }
}
function resolveSymlink(p: string): string {
  const r = run("readlink", ["-f", p]);
  return r.stdout.trim();
}

export abstract class BaseInstaller {
  assetPath: string;
  layout: LayoutSpec;
  ctx: InstallContext;
  installDir: string;

  constructor(assetPath: string, layout: LayoutSpec, ctx: InstallContext) {
    this.assetPath = assetPath;
    this.layout = layout;
    this.ctx = ctx;
    this.installDir =
      layout.rootDir ?? join(ctx.appsRoot, ctx.appName, ctx.version);
  }

  abstract detectType(): boolean;
  /** 把资产解压/放置到 installDir */
  abstract extract(): Promise<void>;
  /** 收集待链接的可执行文件（相对 installDir 的路径） */
  abstract collectBins(): Promise<BinSpec[]>;

  /** 生成 desktop / service / 软链 */
  async postInstall(
    bins: BinSpec[],
    opts: { icon?: string | null; serviceExec?: string | null; autoStart?: boolean; iconSource?: string },
  ): Promise<PostInstallResult> {
    const result: PostInstallResult = { binLinks: [], desktopLinks: [] };
    if (!bins.length) return result;

    // 1. bin 软链
    for (const b of bins) {
      const src = join(this.installDir, b.path);
      const linkName = join(this.ctx.binDir, b.as ?? basename(b.path));
      if (createSymlink(src, linkName)) result.binLinks.push(linkName);
    }

    // 非 linux 跳过 desktop/service
    if (systemInfo.os !== "linux") return result;

    const dirs = xdgDirs();
    run("mkdir", ["-p", dirs.desktop, dirs.systemd, dirs.autostart]);

    // 2. 图标处理
    let iconPath: string | undefined;
    if (opts.iconSource) {
      const iconsDir = join(this.installDir, "share", "icons");
      Bun.spawnSync(["mkdir", "-p", iconsDir]);
      const srcIcon = opts.iconSource;
      const ext = srcIcon.includes(".") ? "." + srcIcon.split(".").pop() : "";
      const dst = join(iconsDir, `${this.ctx.appName}${ext}`);
      if (srcIcon.startsWith("/") || srcIcon.startsWith("~") || existsSync(srcIcon)) {
        // 外部图标
        try {
          Bun.spawnSync(["cp", "-f", srcIcon.replace(/^~/, homedir()), dst]);
          iconPath = dst;
        } catch {
          /* ignore */
        }
      } else {
        const inner = join(this.installDir, srcIcon);
        if (existsSync(inner)) {
          try {
            Bun.spawnSync(["cp", "-f", inner, dst]);
            iconPath = dst;
          } catch {
            /* ignore */
          }
        }
      }
    }

    // 3. desktop 文件（有图标或 serviceExec 时生成）
    const wantDesktop = !!iconPath || !!opts.serviceExec;
    if (wantDesktop) {
      const primaryBin = bins[0];
      const execPath = join(this.ctx.binDir, primaryBin.as ?? basename(primaryBin.path));
      const desktopPath = join(this.installDir, `${this.ctx.appName}.desktop`);
      const lines = [
        "[Desktop Entry]",
        "Type=Application",
        `Name=${this.ctx.appName}`,
        `Exec=${execPath}`,
        `Path=${this.installDir}`,
        "Terminal=false",
      ];
      if (iconPath) lines.push(`Icon=${iconPath}`);
      writeText(desktopPath, lines.join("\n") + "\n");
      Bun.spawnSync(["chmod", "755", desktopPath]);
      const link = join(dirs.desktop, `${this.ctx.appName}.desktop`);
      if (createSymlink(desktopPath, link)) result.desktopLinks.push(link);
    }

    // 4. systemd user service
    if (opts.serviceExec) {
      const servicePath = join(this.installDir, `${this.ctx.appName}.service`);
      const content = [
        "[Unit]",
        `Description=${this.ctx.appName}`,
        "",
        "[Service]",
        `ExecStart=${opts.serviceExec}`,
        `WorkingDirectory=${this.installDir}`,
        "Restart=on-failure",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n");
      writeText(servicePath, content);
      Bun.spawnSync(["chmod", "644", servicePath]);
      const link = join(dirs.systemd, `${this.ctx.appName}.service`);
      if (createSymlink(servicePath, link)) result.serviceLink = link;
      // 启用
      const en = run("systemctl", ["--user", "daemon-reload"]);
      if (en.ok) run("systemctl", ["--user", "enable", `${this.ctx.appName}.service`]);
    }

    // 5. autostart
    if (opts.autoStart && result.desktopLinks[0]) {
      const link = join(dirs.autostart, `${this.ctx.appName}.desktop`);
      if (createSymlink(result.desktopLinks[0], link)) result.autostartLink = link;
    }

    return result;
  }
}
