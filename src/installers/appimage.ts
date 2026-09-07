import { BaseInstaller, BinSpec } from "./base.ts";
import { run } from "../util/exec.ts";
import { log } from "../util/log.ts";
import { join, basename } from "node:path";

export class AppImageInstaller extends BaseInstaller {
  detectType(): boolean {
    return this.assetPath.toLowerCase().endsWith(".appimage");
  }

  async extract(): Promise<void> {
    Bun.spawnSync(["mkdir", "-p", this.installDir]);
    Bun.spawnSync(["cp", "-f", this.assetPath, join(this.installDir, basename(this.assetPath))]);
    run("chmod", ["+x", join(this.installDir, basename(this.assetPath))]);
    log.info(`AppImage 已就位：${this.installDir}`);
  }

  async collectBins(): Promise<BinSpec[]> {
    return [{ path: basename(this.assetPath), as: this.ctx.appName }];
  }
}
