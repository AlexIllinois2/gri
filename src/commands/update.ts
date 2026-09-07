import { GithubClient, Asset } from "../core/github-client.ts";
import { filterByConditions, assetPriority } from "../core/asset-selector.ts";
import { compareVersions } from "../core/version-compare.ts";
import { ConfigStore } from "../state/config.ts";
import { AppsStore, normalizeFilter } from "../state/apps.ts";
import { InstalledStore_, repoToName } from "../state/installed.ts";
import { detectTypeFromName, downloadAsset } from "../core/install-utils.ts";
import { runInstallPipeline } from "../core/pipeline.ts";
import { pMulti, pConfirm, newSpinner } from "../ui/prompts.ts";
import { log } from "../util/log.ts";
import { InstalledApp, InstallType } from "../types.ts";

type UpdateStatus = "ok" | "missing" | "uptodate";
interface CheckResult {
  id: string;
  app: InstalledApp;
  status: UpdateStatus;
  latest?: string;
  candidate?: Asset;
}

export interface UpdateOptions {
  yes?: boolean;
}

export async function cmdUpdate(repos: string[], opts: UpdateOptions): Promise<void> {
  const config = ConfigStore.load();
  const installed = InstalledStore_.load();
  const apps = AppsStore.load();
  const client = GithubClient.fromEnvironment();

  let targets = installed.list();
  if (repos.length) {
    const ids = new Set(repos);
    const byName = new Set(repos.map(repoToName));
    targets = targets.filter(
      (a) => (a.repo && (ids.has(a.repo) || byName.has(repoToName(a.repo)))) || ids.has(a.assetName),
    );
    if (!targets.length) {
      log.error(`未找到匹配已安装应用的 repo：${repos.join(", ")}`);
      return;
    }
  }

  // 1. 检查
  log.info(`检查 ${targets.length} 个应用的可升级状态...`);
  const checks: CheckResult[] = [];
  for (const app of targets) {
    const id = app.repo ?? app.assetName;
    if (app.source === "local") {
      checks.push({ id, app, status: "uptodate", latest: app.version });
      continue;
    }
    const [owner, repo] = (app.repo ?? id).split("/");
    let release;
    try {
      release = await client.getLatestRelease(owner, repo);
    } catch (e: any) {
      log.warn(`查询 ${id} 失败：${e.message}`);
      checks.push({ id, app, status: "missing", latest: undefined });
      continue;
    }
    const cmp = compareVersions(release.tag, app.version);
    if (cmp <= 0) {
      checks.push({ id, app, status: "uptodate", latest: release.tag });
      continue;
    }
    // 用 apps.json 中保存的 filter 重新匹配新 release 的资产
    const matched = filterByConditions(release.assets, normalizeFilter(apps.get(id)?.filter));
    let candidate: Asset | undefined;
    if (matched.length === 1) candidate = matched[0];
    else if (matched.length > 1) {
      const sorted = [...matched].sort((a, b) => assetPriority(a) - assetPriority(b));
      candidate = sorted[0];
    }
    if (candidate) checks.push({ id, app, status: "ok", latest: release.tag, candidate });
    else checks.push({ id, app, status: "missing", latest: release.tag });
  }

  const ok = checks.filter((c) => c.status === "ok");
  const missing = checks.filter((c) => c.status === "missing");
  const upToDate = checks.filter((c) => c.status === "uptodate");

  log.out(`可升级：${ok.length}  缺失平台包：${missing.length}  已是最新：${upToDate.length}`);

  let toUpdate: CheckResult[];
  if (opts.yes) {
    toUpdate = ok;
  } else {
    if (ok.length === 0) {
      log.info("没有可升级的应用。");
      if (missing.length) missing.forEach((c) => log.warn(`${c.id}: 新版本未包含当前平台资产（可能为补丁发布）`));
      return;
    }
    const chosen = await pMulti<string>(
      "选择要升级的应用（仅显示可升级项）",
      ok.map((c) => ({
        value: c.id,
        label: `${c.id}  ${c.app.version} → ${c.latest}`,
      })),
    );
    toUpdate = ok.filter((c) => chosen.includes(c.id));
    if (!toUpdate.length) {
      log.info("未选择任何应用，退出。");
      return;
    }
  }

  // 2. 执行升级 = 复用安装管线
  for (const c of toUpdate) {
    if (!c.candidate) continue;
    const sp = newSpinner();
    sp.start(`升级 ${c.id} → ${c.latest}`);
    try {
      const assetPath = await downloadAsset(c.candidate, client.token, config, `update:${c.id}`);
      await runInstallPipeline({
        assetPath,
        appName: repoToName(c.id),
        version: c.latest!,
        tag: c.latest!,
        type: (apps.get(c.id)?.type ?? detectTypeFromName(c.candidate.name)) as InstallType,
        filter: normalizeFilter(apps.get(c.id)?.filter),
        layout: apps.get(c.id)?.layout,
        repo: c.app.repo,
        source: "repo",
        assetName: c.candidate.name,
        assetUrl: c.candidate.download_url,
        id: c.id,
        config,
        installedStore: installed,
        appsStore: apps,
      });
      sp.stop(`✅ ${c.id} 已升级到 ${c.latest}`);
    } catch (e: any) {
      sp.stop(`升级失败：${c.id}`, 1);
      log.error(e.message);
    }
  }

  // 3. 末尾统一提示缺失项
  if (missing.length) {
    log.warn("以下应用的新版本未包含当前平台资产（可能为补丁发布），已跳过：");
    missing.forEach((c) => log.warn(`  ${c.id}: ${c.app.version} → ${c.latest ?? "?"}`));
  }
}
