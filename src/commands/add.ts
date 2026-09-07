import { AppsStore } from "../state/apps.ts";
import { log } from "../util/log.ts";

export interface AddOptions {
  /** 已存在时是否覆盖更新 */
  force?: boolean;
}

/**
 * 添加一个或多个 repo 到 apps.json（仅记录，不安装）
 */
export async function cmdAdd(repos: string[], opts: AddOptions): Promise<void> {
  if (!repos.length) {
    log.error("请指定至少一个 owner/repo，例如：gri add astral-sh/uv");
    return;
  }

  // 校验格式
  const invalid = repos.filter((r) => !/^[\w.-]+\/[\w.-]+$/.test(r));
  if (invalid.length) {
    log.error("格式错误（应为 owner/repo）：" + invalid.join(", "));
    return;
  }

  const store = AppsStore.load();
  let added = 0;
  let skipped = 0;

  for (const repo of repos) {
    if (store.get(repo) && !opts.force) {
      log.warn(`${repo} 已存在，跳过（用 --force 覆盖）`);
      skipped++;
      continue;
    }
    store.set(repo, { repo });
    log.info(`✅ 已添加：${repo}`);
    added++;
  }

  if (added > 0) {
    log.out(`共添加 ${added} 个 repo，跳过 ${skipped} 个`);
  } else {
    log.out("没有新增 repo");
  }
}
