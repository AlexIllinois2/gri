// 共享类型定义 —— 被 CLI、核心逻辑、Web 后端与前端复用。

/** 操作系统大类 */
export type OS = "linux" | "macos" | "windows";

/**
 * 安装类型。描述「这个文件是什么」，而不是具体的压缩格式：
 * - `archive`：压缩包。tar.gz / tgz / zip / tar.xz / tar.bz2 等统一归为这一类，
 *   具体用哪条解压命令由扩展名决定（见 ARCHIVE_EXTS），挑选哪个资产由 filter 决定。
 * - `appimage` / `rpm` / `deb` / `exe`：特定封装或交给包管理器的包。
 * - `raw`：裸二进制。
 */
export type InstallType =
  | "archive"
  | "appimage"
  | "rpm"
  | "deb"
  | "exe"
  | "raw";

/**
 * apps.json 中书写的筛选条件：
 * - 字符串等价于 `{ field: "contains", op: "contains", value }`
 * - 对象为结构化条件 FilterCond
 */
export type FilterRule = string | FilterCond;

/** 资产筛选单个条件（持久化到 apps.json 的 filter 字段） */
export interface FilterCond {
  field: "name" | "arch" | "os" | "ext" | "libc" | "contains" | "excludes";
  /** 匹配子串 / 正则 / glob；arch/os 为数组 */
  value: string | string[];
  op?: "match" | "in" | "eq" | "contains" | "excludes";
}

/** 归档安装的资源布局（持久化到 apps.json 的 layout 字段） */
export interface LayoutSpec {
  rootDir?: string;
  /** 剥离顶层目录层数，默认 1 */
  stripComponents?: number;
  include?: string[];
  exclude?: string[];
  /** 需要暴露的二进制：包内相对路径 + 链接名 */
  bins?: { path: string; as?: string }[];
  icons?: string[];
  desktopFile?: string | null;
  /** systemd user service 的 Exec 命令；null 表示不生成 */
  serviceExec?: string | null;
  autoStart?: boolean;
}

/**
 * 已安装应用的台账记录（installed.json 的 value）。
 * 只描述"装了什么、装在哪"；"怎么选资产、怎么部署"（type/filter/layout）属于
 * apps.json 中的 AppRule，升级时按 id 去那边取。
 */
export interface InstalledApp {
  version: string;
  tag: string;
  assetName: string;
  assetUrl: string;
  bins: string[];
  icon?: string | null;
  service?: string | null;
  /** 本地安装根目录（archive/appimage/exe 有值；rpm/deb 为 null） */
  installDir?: string | null;
  installedAt: string;
  /** 来源：repo 或 local 路径 */
  source: "repo" | "local";
  repo?: string;
}

export type InstalledStore = Record<string, InstalledApp>;

/**
 * apps.json 中单个预置规则。
 * 描述"这个应用该怎么装"：装什么类型、如何挑选资产、归档如何布局。
 */
export interface AppRule {
  repo: string;
  /** 旧版兼容：由 suffix 推导 type 与 filter */
  suffix?: string;
  type?: InstallType;
  /** 资产筛选条件，字符串视为 contains 子串 */
  filter?: FilterRule[];
  /** 归档安装的资源布局，仅压缩包需要 */
  layout?: LayoutSpec;
  bins?: string[];
  icon?: string;
  arch?: string;
}

export type AppsRules = Record<string, AppRule>;

/** config.json 全局配置 */
export interface ConfigData {
  /** token 文件或内存来源的兜底；实际 token 优先从环境变量/文件读取 */
  downloadBackend: "native" | "aria2" | "gh" | "auto";
  cacheDir: string;
  binDir: string;
  appsDir: string;
  deleteAfterInstall: boolean;
  openBrowserOnUi: boolean;
  serverPort: number;
}

/** 下载来源 */
export type DownloadSource = "native" | "aria2" | "gh";

/** 下载任务 */
export interface DownloadJob {
  url: string;
  dest: string;
  headers?: Record<string, string>;
  /** 私有库 asset 下载需走 raw api */
  acceptRaw?: boolean;
}

/** 进度事件 */
export interface ProgressEvent {
  bytes: number;
  total?: number;
}

/** 匹配错误 */
export type MatchErrorKind = "no-match" | "multi-match" | "rate-limit" | "not-found";
export class MatchError extends Error {
  kind: MatchErrorKind;
  candidates?: string[];
  resetAt?: number;
  constructor(kind: MatchErrorKind, message: string, extra?: { candidates?: string[]; resetAt?: number }) {
    super(message);
    this.name = "MatchError";
    this.kind = kind;
    this.candidates = extra?.candidates;
    this.resetAt = extra?.resetAt;
  }
}
