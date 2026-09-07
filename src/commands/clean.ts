import { ConfigStore } from "../state/config.ts";
import { cleanCache } from "../core/pipeline.ts";
import { log } from "../util/log.ts";

export interface CleanOptions {
  /** 是否同时清理已安装应用目录（appsDir） */
  apps?: boolean;
}

export async function cmdClean(opts: CleanOptions): Promise<void> {
  const config = ConfigStore.load();

  // 清理缓存
  cleanCache(config);

  if (opts.apps) {
    const appsDir = config.get("appsDir");
    try {
      const { readdirSync, rmSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      if (readdirSync(appsDir).length === 0) {
        log.info("应用目录为空，无需清理。");
      } else {
        rmSync(appsDir, { recursive: true, force: true });
        log.info(`已清理应用目录：${appsDir}`);
      }
    } catch (e: any) {
      log.error(`清理应用目录失败：${e.message}`);
    }
  }
}
