import { BaseInstaller, BinSpec, PostInstallResult } from "./base.ts";
import { run, commandExists } from "../util/exec.ts";
import { log } from "../util/log.ts";

/** RPM：通过 dnf/rpm 安装，不落盘到 ~/.gri/apps，仅写 manifest 以便 remove 反向卸载 */
export class RpmInstaller extends BaseInstaller {
  detectType(): boolean {
    return this.assetPath.toLowerCase().endsWith(".rpm");
  }

  async extract(): Promise<void> {
    const pkg = commandExists("dnf") ? "dnf" : commandExists("rpm") ? "rpm" : "dnf";
    const useSudo = !commandExists("pkexec");
    const base = useSudo ? ["sudo"] : ["pkexec"];
    const sub = pkg === "rpm" ? ["-i", this.assetPath] : ["install", "-y", this.assetPath];
    const args = [...base, pkg, ...sub];
    log.info(`安装 RPM：${args.join(" ")}`);
    const res = run(args[0], args.slice(1));
    if (!res.ok) {
      throw new Error(`RPM 安装失败：${res.stderr.slice(0, 300)}`);
    }
  }

  async collectBins(): Promise<BinSpec[]> {
    return [];
  }

  async postInstall(): Promise<PostInstallResult> {
    return { binLinks: [], desktopLinks: [] };
  }
}
