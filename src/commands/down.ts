import { GithubClient } from "../core/github-client.ts";
import { narrowToUnique } from "../core/asset-picker.ts";
import { ConfigStore } from "../state/config.ts";
import { runDownload } from "../downloaders/index.ts";
import { expandHome } from "../core/install-utils.ts";
import { newSpinner } from "../ui/prompts.ts";
import { log } from "../util/log.ts";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface DownOptions {
  /** 资产名子串预筛选 */
  select?: string;
  /** 指定 tag（默认 latest） */
  tag?: string;
  /** 输出路径：目录或文件路径 */
  out?: string;
}

/**
 * 只挑一个资产并下载，不写 apps.json / installed.json，不解压、不安装。
 * 最终路径打印到 stdout，便于管道消费。
 */
export async function cmdDown(arg: string, opts: DownOptions): Promise<void> {
  const m = arg.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) {
    log.error(`无法解析参数，请传入 owner/repo：${arg}`);
    return;
  }
  const repo = `${m[1]}/${m[2]}`;

  const config = ConfigStore.load();
  const client = GithubClient.fromEnvironment();

  log.info(`查询 ${repo} 的 release...`);
  let release;
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

  const asset = await narrowToUnique(release, { select: opts.select });
  const dest = resolveDest(asset.name, opts.out);
  log.info(`选定资产：${asset.name} (${release.tag})`);

  const sp = newSpinner();
  sp.start(`下载到 ${dest}`);
  try {
    Bun.spawnSync(["mkdir", "-p", dirname(dest)]);
    await runDownload(
      {
        url: asset.download_url,
        dest,
        headers: client.token ? { Authorization: `token ${client.token}` } : {},
      },
      config.data,
      {
        jobId: `down:${repo}`,
        onProgress: (p) => {
          if (p.total) sp.message(`下载 ${((p.bytes / p.total) * 100).toFixed(0)}%`);
        },
      },
    );
  } catch (e: any) {
    sp.stop("下载失败", 1);
    log.error(e.message);
    return;
  }
  sp.stop(`下载完成：${asset.name}`);

  // 纯路径到 stdout，日志走 stderr
  log.out(dest);
}

/**
 * 解析输出路径：
 * - 未指定 → 当前目录下的资产名
 * - 指向已存在目录或以分隔符结尾 → 目录 + 资产名
 * - 否则视为文件路径
 */
function resolveDest(assetName: string, out?: string): string {
  if (!out) return join(process.cwd(), assetName);
  const p = expandHome(out);
  const isDir = p.endsWith("/") || (existsSync(p) && statSync(p).isDirectory());
  const full = isDir ? join(p, assetName) : p;
  return isAbsolute(full) ? full : resolve(process.cwd(), full);
}
