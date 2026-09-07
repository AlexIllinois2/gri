import { Asset } from "./github-client.ts";
import { FilterCond, OS } from "../types.ts";
import { SystemInfo, archAliasesFor } from "./osinfo.ts";

/**
 * 移植 dra 的资产匹配逻辑，并在此之上泛化出可持久化的 FilterCond 体系。
 */

const ARCHIVES = [".gz", ".tgz", ".bz2", ".tbz", ".xz", ".txz", ".zip"];

const EXT_MAP: Record<string, RegExp> = {
  "tar.gz": /\.tar\.gz$/i,
  tgz: /\.tgz$/i,
  gz: /\.tar\.gz$/i,
  "tar.xz": /\.tar\.xz$/i,
  "tar.bz2": /\.tar\.bz2$/i,
  zip: /\.zip$/i,
  deb: /\.deb$/i,
  rpm: /\.rpm$/i,
  appimage: /\.appimage$/i,
  exe: /\.exe$/i,
  raw: /(^|[^\.])(?!.*\.(tar\.gz|tgz|tar\.xz|tar\.bz2|zip|deb|rpm|appimage|exe)$)/i,
};

const OS_TOKENS: Record<OS, string[]> = {
  linux: ["linux"],
  macos: ["macos", "darwin", "osx", "apple"],
  windows: ["windows", "win32", "win64", "mingw"],
};

function detectLibcFromName(name: string): "gnu" | "musl" | "any" {
  const n = name.toLowerCase();
  if (n.includes("musl")) return "musl";
  if (n.includes("gnu")) return "gnu";
  return "any";
}

/** 单个条件匹配（对应 plan 附录 pseudocode） */
export function matches(asset: Asset, cond: FilterCond): boolean {
  const name = asset.name.toLowerCase();
  const value = cond.value;
  switch (cond.field) {
    case "name":
      return typeof value === "string" ? name.includes(value.toLowerCase()) : false;
    case "arch":
      return Array.isArray(value) && value.some((a) => name.includes(a.toLowerCase()));
    case "os":
      return Array.isArray(value) && value.some((o) => OS_TOKENS[o as OS]?.some((t) => name.includes(t)));
    case "ext": {
      const exts = Array.isArray(value) ? value : [value];
      return exts.some((e) => {
        const re = EXT_MAP[e.toLowerCase()];
        return re ? re.test(name) : name.endsWith(e.toLowerCase());
      });
    }
    case "libc": {
      const libc = detectLibcFromName(asset.name);
      const allowed = Array.isArray(value) ? value : [value];
      if (libc === "any") return true;
      return allowed.includes(libc);
    }
    case "contains":
      return typeof value === "string" ? asset.name.toLowerCase().includes(value.toLowerCase()) : false;
    case "excludes":
      return typeof value === "string" ? !asset.name.toLowerCase().includes(value.toLowerCase()) : false;
    default:
      return true;
  }
}

export function matchesAll(asset: Asset, conds: FilterCond[]): boolean {
  return conds.every((c) => matches(asset, c));
}

/** 应用一组条件筛选资产 */
export function filterByConditions(assets: Asset[], conds: FilterCond[]): Asset[] {
  if (conds.length === 0) return assets;
  return assets.filter((a) => matchesAll(a, conds));
}

/** dra 的 asset_priority：值越小越优先 */
export function assetPriority(a: Asset): number {
  const name = a.name.toLowerCase();
  const isArchive = ARCHIVES.some((x) => name.endsWith(x));
  const isMusl = name.includes("musl");
  if (isMusl && isArchive) return 1;
  if (isMusl) return 2;
  if (isArchive) return 3;
  return 4;
}

/** 移植 dra find_asset_by_system：按当前系统自动筛选并排序 */
export function autoCandidates(assets: Asset[], sys: SystemInfo): Asset[] {
  const osName = sys.os;
  const archAliases = sys.archAliases;
  const osTokens = OS_TOKENS[osName] ?? [osName];

  const isSameArch = (name: string) => archAliases.some((a) => name.includes(a.toLowerCase()));
  const isSameOs = (name: string) => osTokens.some((t) => name.includes(t));
  const containsAppimage = (name: string) => name.endsWith(".appimage");

  const filtered = assets.filter((a) => {
    const name = a.name.toLowerCase();
    const sameArch = isSameArch(name);
    const sameSystem = isSameOs(name) && sameArch;
    const sameArchExt = sameArch && containsAppimage(name);
    return sameSystem || sameArchExt;
  });

  return filtered.sort((x, y) => assetPriority(x) - assetPriority(y));
}

/** 生成用于持久化的默认条件（按当前系统） */
export function defaultConditions(sys: SystemInfo, extra?: Partial<FilterCond>[]): FilterCond[] {
  const conds: FilterCond[] = [
    { field: "os", op: "in", value: [sys.os] },
    { field: "arch", op: "in", value: sys.archAliases },
  ];
  if (sys.libc !== "unknown") {
    conds.push({ field: "libc", op: "in", value: [sys.libc] });
  }
  if (extra) conds.push(...extra.filter((c): c is FilterCond => Boolean(c.field && c.value !== undefined)));
  return conds;
}

/** 把通配/正则后缀筛选转换为 contains 条件（用于交互关键词） */
export function keywordCond(keyword: string): FilterCond {
  return { field: "contains", op: "contains", value: keyword };
}

export function excludeCond(keyword: string): FilterCond {
  return { field: "excludes", op: "excludes", value: keyword };
}

export { archAliasesFor };
