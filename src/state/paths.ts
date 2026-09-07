import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

/** XDG 基础目录：环境变量必须是绝对路径，否则回退到规范默认值 */
function xdgBase(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  if (v && isAbsolute(v)) return v;
  return join(homedir(), fallback);
}

/**
 * 目录布局遵循 XDG Base Directory Specification：
 * - config → $XDG_CONFIG_HOME/gri   (~/.config/gri)   配置、规则、token
 * - cache  → $XDG_CACHE_HOME/gri    (~/.cache/gri)    下载缓存、解压暂存
 * - data   → $XDG_DATA_HOME/gri     (~/.local/share/gri) 安装台账
 *
 * 设置 $GRI_HOME 时三者统一收敛到该目录下，便于测试与便携部署。
 */
const GRI_ROOT = process.env.GRI_HOME ? resolve(process.env.GRI_HOME) : undefined;

export const CONFIG_HOME = GRI_ROOT
  ? join(GRI_ROOT, "config")
  : join(xdgBase("XDG_CONFIG_HOME", ".config"), "gri");
export const CACHE_HOME = GRI_ROOT
  ? join(GRI_ROOT, "cache")
  : join(xdgBase("XDG_CACHE_HOME", ".cache"), "gri");
export const DATA_HOME = GRI_ROOT
  ? join(GRI_ROOT, "data")
  : join(xdgBase("XDG_DATA_HOME", ".local/share"), "gri");

export const CONFIG_FILE = join(CONFIG_HOME, "config.json");
export const APPS_FILE = join(CONFIG_HOME, "apps.json");
export const TOKEN_FILE = join(CONFIG_HOME, "token");
export const INSTALLED_FILE = join(DATA_HOME, "installed.json");

export const CACHE_DIR_DEFAULT = CACHE_HOME;
export const BIN_DIR_DEFAULT = join(homedir(), ".local", "bin");
export const APPS_DIR_DEFAULT = join(homedir(), ".local", "app");

export function ensureDirs(): void {
  Bun.spawnSync([
    "mkdir",
    "-p",
    CONFIG_HOME,
    CACHE_HOME,
    DATA_HOME,
    BIN_DIR_DEFAULT,
    APPS_DIR_DEFAULT,
  ]);
}
