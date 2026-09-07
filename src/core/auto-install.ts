import { GithubClient, Asset, Release } from "./github-client.ts";
import { systemInfo } from "./osinfo.ts";
import { autoCandidates, assetPriority, filterByConditions } from "./asset-selector.ts";
import { compareVersions } from "./version-compare.ts";
import {
  buildPersistedFilter,
  detectTypeFromName,
  downloadAsset,
  deriveAppName,
  isRpmDistro,
  isDebDistro,
} from "./install-utils.ts";
import { ConfigStore } from "../state/config.ts";
import { AppsStore, effectiveLayout, normalizeFilter } from "../state/apps.ts";
import { InstalledStore_, repoToName } from "../state/installed.ts";
import { runInstallPipeline } from "./pipeline.ts";
import { LayoutSpec, FilterCond, InstallType, ProgressEvent } from "../types.ts";
import { log as clog } from "../util/log.ts";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { findExecutables, extractArchive } from "../installers/archive.ts";

export interface InstallParams {
  repo: string;
  select?: string;
  bins?: string[];
  allBin?: boolean;
  icon?: string;
  service?: string;
  tag?: string;
}

/** 非交互式收敛：优先自动匹配，落空则按优先级取第一个 */
export function pickCandidateNonInteractive(release: Release, params: InstallParams): Asset | null {
  let candidates = release.assets;
  if (params.select) candidates = candidates.filter((a) => a.name.includes(params.select!));
  const auto = autoCandidates(candidates, systemInfo);
  if (auto.length) candidates = auto;

  const rpm = candidates.filter((a) => a.name.toLowerCase().endsWith(".rpm"));
  const deb = candidates.filter((a) => a.name.toLowerCase().endsWith(".deb"));
  if (rpm.length && isRpmDistro()) candidates = rpm;
  else if (deb.length && isDebDistro()) candidates = deb;

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return [...candidates].sort((a, b) => assetPriority(a) - assetPriority(b))[0];
}

async function buildLayoutNonInteractive(
  assetPath: string,
  appName: string,
  type: string,
  params: InstallParams,
): Promise<LayoutSpec | undefined> {
  if (type !== "archive") return undefined;
  const layout: LayoutSpec = { stripComponents: 1 };
  const stage = join(ConfigStore.load().get("cacheDir"), "stage", `${appName}.stage`);
  Bun.spawnSync(["rm", "-rf", stage]);
  await extractArchive(assetPath, stage, layout.stripComponents ?? 1);
  const exes = findExecutables(stage).sort();
  if (params.allBin || !params.bins?.length) {
    layout.bins = exes.map((p) => ({ path: p }));
  } else {
    layout.bins = params.bins.map((b) => ({ path: b }));
  }
  if (params.icon) layout.icons = [params.icon];
  if (params.service) layout.serviceExec = params.service;
  Bun.spawnSync(["rm", "-rf", stage]);
  return layout;
}

export interface RunCallbacks {
  onLog?: (line: string) => void;
  onProgress?: (p: ProgressEvent) => void;
}

/** 服务端/无头安装入口（供 Web 与 -y 场景复用） */
export async function installNonInteractive(
  params: InstallParams,
  cb: RunCallbacks = {},
): Promise<void> {
  const config = ConfigStore.load();
  const installed = InstalledStore_.load();
  const apps = AppsStore.load();
  const client = GithubClient.fromEnvironment();
  const localPath = params.repo.startsWith("/") || params.repo.startsWith("~") || params.repo.startsWith(".");
  const isLocal = localPath && existsSync(params.repo);

  let asset: Asset;
  let release: Release;
  let repo: string | undefined;
  let id: string;

  if (isLocal) {
    const name = basename(params.repo);
    asset = { name, download_url: params.repo };
    release = { tag: "local", name: "local", prerelease: false, assets: [asset] };
    id = repoToName(name);
  } else {
    const m = (params.repo).match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!m) throw new Error(`无法解析 repo：${params.repo}`);
    repo = `${m[1]}/${m[2]}`;
    id = repo;
    release = params.tag
      ? await client.getReleaseByTag(m[1], m[2], params.tag)
      : await client.getLatestRelease(m[1], m[2]);
    if (!release.assets.length) throw new Error(`release ${release.tag} 无资产`);
    const cand = pickCandidateNonInteractive(release, params);
    if (!cand) throw new Error("无法自动匹配资产，请使用更具体的 select 参数");
    asset = cand;
  }

  const type = detectTypeFromName(asset.name);
  const appName = repo ? repoToName(repo) : deriveAppName(asset.name);
  cb.onLog?.(`选定资产：${asset.name} (${type})`);

  let assetPath: string;
  if (isLocal) {
    assetPath = params.repo;
  } else {
    cb.onLog?.(`下载 ${asset.name}...`);
    assetPath = await downloadAsset(asset, client.token, config, `install:${id}`, cb.onProgress, cb.onLog);
  }

  // 优先复用 apps.json 中已固化的 layout / filter
  const rule = apps.get(id);
  const layout =
    type === "archive"
      ? (rule?.layout ??
        effectiveLayout(rule) ??
        (await buildLayoutNonInteractive(assetPath, appName, type, params)))
      : undefined;
  const declared = normalizeFilter(rule?.filter);
  const filter: FilterCond[] = declared.length
    ? declared
    : repo
      ? buildPersistedFilter(asset, release)
      : [{ field: "contains", op: "contains", value: asset.name }];

  await runInstallPipeline({
    assetPath,
    appName,
    version: release.tag,
    tag: release.tag,
    type: type as InstallType,
    filter,
    layout,
    repo,
    source: isLocal ? "local" : "repo",
    assetName: asset.name,
    assetUrl: asset.download_url,
    id,
    config,
    installedStore: installed,
    appsStore: apps,
    onLog: cb.onLog,
    onProgress: cb.onProgress,
  });
  cb.onLog?.(`✅ ${id}@${release.tag} 安装完成`);
}

/** 检查可升级状态（用于 Web 控制台） */
export async function checkUpdates(ids?: string[]): Promise<any[]> {
  const config = ConfigStore.load();
  const installed = InstalledStore_.load();
  const client = GithubClient.fromEnvironment();
  let apps = installed.list();
  if (ids && ids.length) {
    const set = new Set(ids);
    apps = apps.filter((a) => (a.repo && set.has(a.repo)) || set.has(a.assetName));
  }
  const out = [];
  for (const app of apps) {
    const id = app.repo ?? app.assetName;
    if (app.source === "local") {
      out.push({ id, status: "uptodate", current: app.version });
      continue;
    }
    const [owner, repo] = (app.repo ?? id).split("/");
    try {
      const release = await client.getLatestRelease(owner, repo);
      const cmp = compareVersions(release.tag, app.version);
      out.push({
        id,
        status: cmp > 0 ? "ok" : "uptodate",
        current: app.version,
        latest: release.tag,
      });
    } catch (e: any) {
      out.push({ id, status: "missing", current: app.version, error: e.message });
    }
  }
  return out;
}

/** 非交互式升级（供 Web 调用；等价于 update -y） */
export async function updateNonInteractive(ids: string[], cb: RunCallbacks = {}): Promise<void> {
  const config = ConfigStore.load();
  const installed = InstalledStore_.load();
  const apps = AppsStore.load();
  const client = GithubClient.fromEnvironment();

  let targets = installed.list();
  if (ids && ids.length) {
    const set = new Set(ids);
    targets = targets.filter((a) => (a.repo && set.has(a.repo)) || set.has(a.assetName));
  }

  for (const app of targets) {
    const id = app.repo ?? app.assetName;
    if (app.source === "local") continue;
    if (!app.repo) continue;
    const [owner, repo] = app.repo.split("/");
    let release;
    try {
      release = await client.getLatestRelease(owner, repo);
    } catch (e: any) {
      cb.onLog?.(`查询 ${id} 失败：${e.message}`);
      continue;
    }
    if (compareVersions(release.tag, app.version) <= 0) {
      cb.onLog?.(`${id} 已是最新 (${app.version})`);
      continue;
    }
    const rule = apps.get(id);
    const filter = normalizeFilter(rule?.filter);
    const matched = filterByConditions(release.assets, filter);
    let candidate: Asset | undefined = matched.length
      ? [...matched].sort((a, b) => assetPriority(a) - assetPriority(b))[0]
      : undefined;
    if (!candidate) {
      cb.onLog?.(`${id}: 新版本未包含当前平台资产，跳过`);
      continue;
    }
    try {
      cb.onLog?.(`升级 ${id} → ${release.tag}`);
      const assetPath = await downloadAsset(candidate, client.token, config, `update:${id}`, cb.onProgress, cb.onLog);
      await runInstallPipeline({
        assetPath,
        appName: repoToName(id),
        version: release.tag,
        tag: release.tag,
        type: rule?.type ?? (detectTypeFromName(candidate.name) as InstallType),
        filter,
        layout: rule?.layout,
        repo: app.repo,
        source: "repo",
        assetName: candidate.name,
        assetUrl: candidate.download_url,
        id,
        config,
        installedStore: installed,
        appsStore: apps,
        onLog: cb.onLog,
        onProgress: cb.onProgress,
      });
      cb.onLog?.(`✅ ${id} 升级完成`);
    } catch (e: any) {
      cb.onLog?.(`升级失败 ${id}: ${e.message}`);
    }
  }
}
