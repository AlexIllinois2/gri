import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.ts";

/** 同步读取文本文件，不存在返回 null */
export function readText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 同步写文本（先确保父目录存在由调用方负责） */
export function writeText(path: string, content: string): void {
  writeFileSync(path, content);
}

/** 首次安装时把 binDir 追加到 shell rc 的 PATH（幂等、仅追加一次） */
export function ensureBinInPath(binDir: string): void {
  const pathEnv = process.env.PATH ?? "";
  if (pathEnv.split(":").includes(binDir)) return;
  const rc = join(homedir(), ".bashrc");
  if (!existsSync(rc)) return;
  const content = readText(rc) ?? "";
  if (content.includes(binDir)) return;
  appendFileSync(rc, `\n# gri: 让安装的应用命令可用\nexport PATH="${binDir}:$PATH"\n`);
  log.info(`已将 ${binDir} 加入 ${rc} 的 PATH，请重开终端或执行 source ${rc} 生效`);
}
