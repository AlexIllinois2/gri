import { Asset, GithubClient } from "./github-client.ts";
import { Release } from "./github-client.ts";
import { FilterCond, InstallType } from "../types.ts";
import { systemInfo } from "./osinfo.ts";
import { ConfigStore } from "../state/config.ts";
import { runDownload } from "../downloaders/index.ts";
import { ProgressEvent } from "../types.ts";
import { join, dirname } from "node:path";
import { untag, TAG_PLACEHOLDER } from "./untag.ts";
import { log } from "../util/log.ts";

export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return join(process.env.HOME ?? "", p.slice(1));
  return p;
}

/** 从文件名/资产名推导干净的应用短名（去掉归档后缀） */
export function deriveAppName(name: string): string {
  return name
    .replace(/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|zip|appimage|rpm|deb|exe)$/i, "")
    .replace(/\.tar$/, "");
}

/** 支持的压缩包扩展名（类型推断与解压共用同一份真源） */
export const ARCHIVE_EXTS = [
  ".tar.gz",
  ".tgz",
  ".tar.xz",
  ".tar.bz2",
  ".tbz2",
  ".tbz",
  ".zip",
] as const;

/** 从资产名推断类型：压缩包一律归为 archive，具体格式交给解压器按扩展名判断 */
export function detectTypeFromName(name: string): InstallType {
  const n = name.toLowerCase();
  if (n.endsWith(".appimage")) return "appimage";
  if (n.endsWith(".rpm")) return "rpm";
  if (n.endsWith(".deb")) return "deb";
  if (n.endsWith(".exe")) return "exe";
  if (ARCHIVE_EXTS.some((ext) => n.endsWith(ext))) return "archive";
  return "raw";
}

/** 下载资产到缓存目录，返回本地路径 */
export async function downloadAsset(
  asset: Asset,
  token: string | undefined,
  config: ConfigStore,
  jobId: string,
  onProgress?: (p: ProgressEvent) => void,
  onLog?: (line: string) => void,
): Promise<string> {
  const dest = join(config.get("cacheDir"), asset.name);
  Bun.spawnSync(["mkdir", "-p", dirname(dest)]);
  const headers: Record<string, string> = token ? { Authorization: `token ${token}` } : {};
  await runDownload(
    { url: asset.download_url, dest, headers },
    config.data,
    { jobId, onProgress, onLog },
  );
  return dest;
}

/** 构造可随版本升级复用的筛选条件 */
export function buildPersistedFilter(asset: Asset, release: Release): FilterCond[] {
  const sys = systemInfo;
  const conds: FilterCond[] = [
    { field: "os", op: "in", value: [sys.os] },
    { field: "arch", op: "in", value: sys.archAliases },
  ];
  if (sys.libc !== "unknown") {
    conds.push({ field: "libc", op: "in", value: [sys.libc] });
  }
  // 从 untag 模板切出稳定片段作为 contains 条件（版本段会被 {tag} 吸收）
  const template = untag(release.tag, asset.name);
  const segments = template
    .split(TAG_PLACEHOLDER)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  for (const seg of segments) {
    conds.push({ field: "contains", op: "contains", value: seg });
  }
  return conds;
}

export const RPM_DISTROS = ["fedora", "rhel", "centos", "rocky", "almalinux", "opensuse", "suse"];
export const DEB_DISTROS = ["debian", "ubuntu", "linuxmint", "pop", "kali", "deepin"];

export function isRpmDistro(): boolean {
  return RPM_DISTROS.includes(systemInfo.distro);
}
export function isDebDistro(): boolean {
  return DEB_DISTROS.includes(systemInfo.distro);
}
