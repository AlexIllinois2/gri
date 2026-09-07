import { BaseInstaller, BinSpec } from "./base.ts";
import { run } from "../util/exec.ts";
import { log } from "../util/log.ts";
import { join, basename } from "node:path";

/** 纯二进制 / .exe / 经压缩的可执行文件：直接 chmod +x 后链接 */
export class RawExeInstaller extends BaseInstaller {
  detectType(): boolean {
    const n = this.assetPath.toLowerCase();
    if (n.endsWith(".exe")) return true;
    // 兜底：无已知归档后缀
    return !/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|zip|deb|rpm|appimage)$/.test(n);
  }

  async extract(): Promise<void> {
    Bun.spawnSync(["mkdir", "-p", this.installDir]);
    const dst = join(this.installDir, this.ctx.appName);
    Bun.spawnSync(["cp", "-f", this.assetPath, dst]);
    run("chmod", ["+x", dst]);
    log.info(`二进制已就位：${dst}`);
  }

  async collectBins(): Promise<BinSpec[]> {
    return [{ path: this.ctx.appName, as: this.ctx.appName }];
  }
}
