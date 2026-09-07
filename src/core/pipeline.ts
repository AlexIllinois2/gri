import { pickInstaller } from "../installers/index.ts";
import { BaseInstaller, BinSpec } from "../installers/base.ts";
import { ConfigStore } from "../state/config.ts";
import { AppsStore } from "../state/apps.ts";
import { InstalledStore_, repoToName } from "../state/installed.ts";
import { FilterCond, InstallType, InstalledApp, LayoutSpec, ProgressEvent } from "../types.ts";
import { log } from "../util/log.ts";
import { ensureBinInPath } from "../util/io.ts";
import { join, basename } from "node:path";
import { existsSync, readdirSync, statSync, unlinkSync, mkdirSync } from "node:fs";

export interface InstallPipelineInput {
  assetPath: string;
  appName: string;
  version: string;
  tag: string;
  type: InstallType;
  filter: FilterCond[];
  layout?: LayoutSpec;
  repo?: string;
  source: "repo" | "local";
  assetName: string;
  assetUrl: string;
  id: string; // installed.json 与 apps.json 共用的 key
  config: ConfigStore;
  installedStore: InstalledStore_;
  /** type/filter/layout 落到 apps.json */
  appsStore: AppsStore;
  onProgress?: (p: ProgressEvent) => void;
  onLog?: (line: string) => void;
}

/** 安装管线的核心实现，install 与 update 共用 */
export async function runInstallPipeline(input: InstallPipelineInput): Promise<InstalledApp> {
  const { assetPath, appName, version, tag, type, filter, layout, repo, source, assetName, assetUrl, id, config, installedStore, appsStore, onLog } = input;

  const ctx = {
    appName,
    version,
    appsRoot: config.get("appsDir"),
    binDir: config.get("binDir"),
  };

  const installer: BaseInstaller | null = pickInstaller(assetPath, layout ?? {}, ctx);
  if (!installer) {
    throw new Error(`无法确定安装器：${assetPath}`);
  }

  log.info(`使用安装器：${installer.constructor.name}`);
  onLog?.(`使用安装器：${installer.constructor.name}`);

  // 1. 解压/放置
  await installer.extract();

  // 2. 确定要暴露的二进制
  let bins: BinSpec[] = [];
  if (layout?.bins && layout.bins.length) {
    bins = layout.bins.map((b) => (typeof b === "string" ? { path: b } : b));
  } else {
    bins = await installer.collectBins();
  }

  // 3. 后置（软链 / desktop / service / icon）
  const iconSource = layout?.icons?.[0];
  const post = await installer.postInstall(bins, {
    iconSource,
    serviceExec: layout?.serviceExec ?? null,
    autoStart: layout?.autoStart ?? false,
  });

  // 4. 把「怎么装」写回 apps.json 规则
  const rule = appsStore.ensure(id, repo);
  rule.type = type;
  rule.filter = filter;
  if (layout && type === "archive") rule.layout = layout;
  appsStore.set(id, rule);

  // 5. 写台账（只记录装了什么、装在哪）
  const record: InstalledApp = {
    version,
    tag,
    assetName,
    assetUrl,
    bins: bins.map((b) => b.as ?? basename(b.path)),
    icon: iconSource ?? null,
    service: layout?.serviceExec ?? null,
    installDir: installer.installDir && existsSync(installer.installDir) ? installer.installDir : null,
    installedAt: new Date().toISOString(),
    source,
    repo,
  };
  installedStore.upsert(id, record);
  log.info(`已记录到 installed.json：${id}@${version}`);
  onLog?.(`安装完成：${id}@${version}`);

  // 6. 保留缓存，每个 repo 最多保留最近 2 个版本
  pruneCache(config, id, 2);

  // 7. 确保 binDir 在 PATH 中（首次）
  ensureBinInPath(config.get("binDir"));

  return record;
}

/** 清理缓存：每个 repo 保留最近 keep 个版本，删除更早的 */
function pruneCache(config: ConfigStore, repoId: string, keep: number): void {
  const cacheDir = config.get("cacheDir");
  if (!existsSync(cacheDir)) return;

  const installed = InstalledStore_.load().get(repoId);
  if (!installed) return;

  // 找到该 repo 的 assetName 关键词用于匹配缓存文件
  // assetName 格式如 uv-0.12.7-x86_64-unknown-linux-gnu.tar.gz
  // 用 repo 短名做粗匹配
  const shortName = repoToName(repoId);
  try {
    const files = readdirSync(cacheDir)
      .filter((f) => f.toLowerCase().includes(shortName.toLowerCase()))
      .map((f) => {
        const fp = join(cacheDir, f);
        const st = statSync(fp);
        return { name: f, path: fp, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime); // 最新的在前

    // 保留最近 keep 个，删除其余
    for (let i = keep; i < files.length; i++) {
      try {
        unlinkSync(files[i].path);
        log.info(`清理旧缓存：${files[i].name}`);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** 清空全部缓存目录 */
export function cleanCache(config: ConfigStore): void {
  const cacheDir = config.get("cacheDir");
  if (!existsSync(cacheDir)) {
    log.info("缓存目录不存在，无需清理。");
    return;
  }
  try {
    const files = readdirSync(cacheDir);
    let removed = 0;
    for (const f of files) {
      const fp = join(cacheDir, f);
      try {
        const st = statSync(fp);
        if (st.isFile()) {
          unlinkSync(fp);
          removed++;
        }
      } catch { /* ignore */ }
    }
    log.info(`已清理 ${removed} 个缓存文件。`);
  } catch (e: any) {
    log.error(`清理缓存失败：${e.message}`);
  }
}
