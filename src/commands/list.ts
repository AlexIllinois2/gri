import { InstalledStore_ } from "../state/installed.ts";
import { AppsStore } from "../state/apps.ts";
import { log } from "../util/log.ts";

export interface ListOptions {
  json?: boolean;
}

function width(s: string): number {
  return [...s].reduce((n, c) => {
    const cp = c.codePointAt(0)!;
    return n + (cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
    ) ? 2 : 1);
  }, 0);
}

function pad(s: string, n: number): string {
  let out = "";
  for (const c of s) {
    if (width(out + c) > n) break;
    out += c;
  }
  return out + " ".repeat(n - width(out));
}

export async function cmdList(opts: ListOptions): Promise<void> {
  const installedStore = InstalledStore_.load();
  const appsStore = AppsStore.load();

  const installedApps = installedStore
    .list()
    .sort((x, y) => (x.repo ?? x.assetName).localeCompare(y.repo ?? y.assetName));

  // 已 add 但尚未安装的应用（apps.json 中存在但 installed.json 中没有对应记录）
  const notInstalled = appsStore
    .list()
    .filter((r) => !installedStore.has(r.repo))
    .sort((x, y) => x.repo.localeCompare(y.repo));

  if (opts.json) {
    const merged = [
      // 已安装：台账 + apps.json 中的规则（type/filter/layout）
      ...installedApps.map((a) => {
        const rule = appsStore.get((a.repo ?? a.assetName) as string);
        return {
          ...a,
          type: rule?.type,
          filter: rule?.filter,
          layout: rule?.layout,
          installed: true,
        };
      }),
      ...notInstalled.map((r) => ({ ...r, installed: false })),
    ];
    log.out(JSON.stringify(merged, null, 2));
    return;
  }

  if (installedApps.length === 0 && notInstalled.length === 0) {
    log.info("尚未添加或安装任何应用。使用 `gri add <repo>` 添加，或 `gri install <repo>` 直接安装。");
    return;
  }

  const cols = [
    pad("REPO/ID", 34),
    pad("VERSION", 16),
    pad("TYPE", 10),
    pad("UPDATED", 22),
    pad("SOURCE", 8),
    pad("STATUS", 10),
  ];
  let out = cols.join(" ");
  out += "\n" + "-".repeat(105);

  // 已安装的在前
  for (const a of installedApps) {
    const id = (a.repo ?? a.assetName) as string;
    const type = appsStore.get(id)?.type ?? "-";
    out += "\n" + [
      pad(id, 34),
      pad(a.version, 16),
      pad(type, 10),
      pad(a.installedAt.slice(0, 19).replace("T", " "), 22),
      pad(a.source, 8),
      pad("已安装", 10),
    ].join(" ");
  }

  // 未安装的在后
  for (const r of notInstalled) {
    out += "\n" + [
      pad(r.repo, 34),
      pad("-", 16),
      pad(r.type ?? "-", 10),
      pad("-", 22),
      pad("-", 8),
      pad("未安装", 10),
    ].join(" ");
  }

  log.out(out);
}

