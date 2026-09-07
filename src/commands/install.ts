import { GithubClient, Asset, Release } from "../core/github-client.ts";
import { ConfigStore } from "../state/config.ts";
import { AppsStore, effectiveLayout, normalizeFilter } from "../state/apps.ts";
import { InstalledStore_, repoToName } from "../state/installed.ts";
import {
  buildPersistedFilter,
  detectTypeFromName,
  downloadAsset,
  expandHome,
  deriveAppName,
} from "../core/install-utils.ts";
import { runInstallPipeline } from "../core/pipeline.ts";
import { narrowToUnique } from "../core/asset-picker.ts";
import {
  pMulti,
  pConfirm,
  pText,
  newSpinner,
} from "../ui/prompts.ts";
import { log } from "../util/log.ts";
import { LayoutSpec, FilterCond } from "../types.ts";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { findExecutables, extractArchive } from "../installers/archive.ts";

export interface InstallOptions {
  select?: string;
  tag?: string;
  bins?: string[];
  allBin?: boolean;
  icon?: string;
  service?: string;
  yes?: boolean;
}

export async function cmdInstall(arg: string, opts: InstallOptions): Promise<void> {
  const config = ConfigStore.load();
  const installed = InstalledStore_.load();
  const apps = AppsStore.load();
  const client = GithubClient.fromEnvironment();

  const localPath = expandHome(arg);
  const isLocal = existsSync(localPath);

  let asset: Asset | null = null;
  let release: Release | null = null;
  let repo: string | undefined;
  let id: string;

  if (isLocal) {
    // ── 本地归档流程 ──
    const name = basename(localPath);
    asset = { name, download_url: localPath };
    release = { tag: "local", name: "local", prerelease: false, assets: [asset] };
    id = repoToName(name);
    log.info(`检测到本地文件，进入本地归档安装流程：${localPath}`);
  } else {
    // ── Repo 流程 ──
    const m = arg.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!m) {
      log.error(`无法解析参数，请传入 owner/repo 或本地文件路径：${arg}`);
      return;
    }
    repo = `${m[1]}/${m[2]}`;
    id = repo;
    if (installed.has(repo)) {
      log.warn(`${repo} 已安装（${installed.get(repo)!.version}）。如需升级请使用 \`gri update ${repo}\`。`);
      if (!opts.yes && !(await pConfirm("仍要重新安装当前版本？", false))) return;
    }
    log.info(`查询 ${repo} 的 release...`);
    try {
      release = opts.tag
        ? await client.getReleaseByTag(m[1], m[2], opts.tag)
        : await client.getLatestRelease(m[1], m[2]);
    } catch (e: any) {
      log.error(e.message);
      return;
    }
    if (!release.assets.length) {
      log.error(`该 release 没有可用资产：${release.tag}`);
      return;
    }
    asset = await narrowToUnique(release, opts);
  }

  if (!asset || !release) return;
  const type = detectTypeFromName(asset.name);
  const appName = repo ? repoToName(repo) : deriveAppName(asset.name);
  log.info(`选定资产：${asset.name}  (类型推断：${type})`);

  // 下载（本地文件跳过）
  let assetPath: string;
  if (isLocal) {
    assetPath = localPath;
  } else {
    const sp = newSpinner();
    sp.start(`下载 ${asset.name}`);
    try {
      assetPath = await downloadAsset(asset, client.token, config, `install:${id}`, (p) => {
        if (p.total) sp.message(`下载 ${((p.bytes / p.total) * 100).toFixed(0)}%`);
      });
    } catch (e: any) {
      sp.stop("下载失败", 1);
      log.error(e.message);
      return;
    }
    sp.stop(`下载完成：${asset.name}`);
  }

  // 布局/部署参数：优先复用 apps.json 里已固化的规则
  const rule = apps.get(id);
  const isArchive = type === "archive";
  let layout: LayoutSpec | undefined;
  if (!isArchive) {
    layout = undefined;
  } else if (rule?.layout) {
    log.info(`复用 apps.json 中已保存的 layout：${id}`);
    layout = rule.layout;
  } else if (effectiveLayout(rule)) {
    layout = effectiveLayout(rule);
  } else {
    layout = await layoutWizard(assetPath, appName, opts);
  }

  const declared = normalizeFilter(rule?.filter);
  const filter: FilterCond[] = declared.length
    ? declared
    : repo
      ? buildPersistedFilter(asset, release)
      : [{ field: "contains", op: "contains", value: asset.name }];

  try {
    await runInstallPipeline({
      assetPath,
      appName,
      version: release.tag,
      tag: release.tag,
      type,
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
    });
    log.info(`✅ ${id}@${release.tag} 安装成功`);
  } catch (e: any) {
    log.error(`安装失败：${e.message}`);
  }
}

/** 归档布局向导：strip → bins → icon → service → rootDir */
async function layoutWizard(
  assetPath: string,
  appName: string,
  opts: InstallOptions,
): Promise<LayoutSpec> {
  const layout: LayoutSpec = { stripComponents: 1 };

  // 先解压到临时区以便探测可执行文件
  const stage = join(await tempDir(), `${appName}.stage`);
  Bun.spawnSync(["rm", "-rf", stage]);
  await extractArchive(assetPath, stage, layout.stripComponents ?? 1);
  const exes = findExecutables(stage).sort();

  // bins
  if (opts.allBin) {
    layout.bins = exes.map((p) => ({ path: p }));
  } else if (opts.bins && opts.bins.length) {
    layout.bins = opts.bins.map((b) => ({ path: b }));
  } else if (exes.length) {
    const chosen = await pMulti<string>(
      `选择要暴露为命令的二进制（共 ${exes.length} 个可执行文件）`,
      exes.map((e) => ({ value: e, label: e })),
    );
    layout.bins = chosen.length ? chosen.map((c) => ({ path: c })) : exes.map((e) => ({ path: e }));
  } else {
    log.warn("未检测到可执行文件，请确认包内容。");
    layout.bins = [];
  }

  // icon
  if (opts.icon) {
    layout.icons = [opts.icon];
  } else if (!opts.yes) {
    const want = await pConfirm("是否配置图标（用于生成 .desktop）？", false);
    if (want) {
      const ip = await pText("输入包内图标相对路径（如 share/icons/logo.png），或外部绝对路径");
      layout.icons = [ip];
    }
  }

  // service
  if (opts.service) {
    layout.serviceExec = opts.service;
  } else if (!opts.yes) {
    const want = await pConfirm("是否生成 systemd 用户服务（后台常驻）？", false);
    if (want) {
      const exec = await pText("输入服务启动命令（如 /path/to/bin --foreground）", layout.bins?.[0]?.path);
      layout.serviceExec = exec;
    }
  }

  if (layout.serviceExec && !opts.yes) {
    layout.autoStart = await pConfirm("是否开机自启？", false);
  }

  // rootDir 默认 appsDir/appName/version，这里不覆盖
  // 清理临时区
  Bun.spawnSync(["rm", "-rf", stage]);
  return layout;
}

async function tempDir(): Promise<string> {
  const d = join(ConfigStore.load().get("cacheDir"), "stage");
  Bun.spawnSync(["mkdir", "-p", d]);
  return d;
}
