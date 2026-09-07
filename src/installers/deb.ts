import { BaseInstaller, BinSpec, PostInstallResult } from "./base.ts";
import { run, commandExists } from "../util/exec.ts";
import { log } from "../util/log.ts";

/** DEB：通过 apt-get/dpkg 安装 */
export class DebInstaller extends BaseInstaller {
  detectType(): boolean {
    return this.assetPath.toLowerCase().endsWith(".deb");
  }

  async extract(): Promise<void> {
    const useSudo = !commandExists("pkexec");
    const base = useSudo ? ["sudo"] : ["pkexec"];
    const sub = commandExists("apt-get")
      ? ["apt-get", "install", "-y", this.assetPath]
      : ["dpkg", "-i", this.assetPath];
    const args = [...base, ...sub];
    log.info(`安装 DEB：${args.join(" ")}`);
    const res = run(args[0], args.slice(1));
    if (!res.ok) {
      // dpkg 失败尝试 -f install 修复依赖
      if (sub[0] === "dpkg") {
        const fix = [...base, "apt-get", "install", "-f", "-y"];
        run(fix[0], fix.slice(1));
      }
      throw new Error(`DEB 安装失败：${res.stderr.slice(0, 300)}`);
    }
  }

  async collectBins(): Promise<BinSpec[]> {
    return [];
  }

  async postInstall(): Promise<PostInstallResult> {
    return { binLinks: [], desktopLinks: [] };
  }
}
