import { InstalledStore_, repoToName } from "../state/installed.ts";
import { AppsStore } from "../state/apps.ts";
import { ConfigStore } from "../state/config.ts";
import { deriveAppName, detectTypeFromName } from "../core/install-utils.ts";
import { log } from "../util/log.ts";
import { run, commandExists } from "../util/exec.ts";
import { pConfirm } from "../ui/prompts.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";

/** 解析用户输入（可能是 owner/repo、短名或带扩展名的本地 id）为存储 key */
function resolveId(repo: string, store: InstalledStore_): string {
  if (store.has(repo)) return repo;
  const want = deriveAppName(repo);
  for (const k of store.ids()) {
    if (deriveAppName(k) === want) return k;
    if (repoToName(k) === repo) return k;
  }
  return repo;
}

function isSymlinkTo(p: string, targetPrefix: string): boolean {
  const r = run("readlink", ["-f", p]);
  if (!r.ok) return false;
  return r.stdout.trim().startsWith(targetPrefix);
}

export interface RemoveOptions {
  yes?: boolean;
}

export async function cmdRemove(repo: string, opts: RemoveOptions): Promise<void> {
  const store = InstalledStore_.load();
  const apps = AppsStore.load();
  const config = ConfigStore.load();
  const id = resolveId(repo, store);
  const app = store.get(id);
  if (!app) {
    log.error(`未找到已安装的应用：${repo}`);
    return;
  }
  const type = apps.get(id)?.type ?? detectTypeFromName(app.assetName);

  if (!opts.yes) {
    log.out(`即将移除：${id}`);
    log.out(`  版本：${app.version}  类型：${type}  安装目录：${app.installDir ?? "(系统包)"}`);
    const ok = await pConfirm("确认移除？", false);
    if (!ok) {
      log.info("已取消。");
      return;
    }
  }

  if (type === "rpm" || type === "deb") {
    await uninstallPackage(app.repo ?? id, type);
  } else {
    await uninstallLocal(app, config, id);
  }

  store.remove(id);
  log.info(`已移除：${id}`);
}

async function uninstallPackage(repo: string, type: string) {
  const name = repoToName(repo);
  if (type === "rpm") {
    const tool = commandExists("dnf") ? "dnf" : "rpm";
    const args = tool === "rpm" ? ["-e", name] : ["remove", "-y", name];
    const base = commandExists("pkexec") ? ["pkexec"] : ["sudo"];
    const r = run(base[0], [...base.slice(1), tool, ...args]);
    if (!r.ok) log.warn(`包管理器卸载可能未完成：${r.stderr.slice(0, 200)}`);
  } else {
    const tool = commandExists("apt-get") ? "apt-get" : "dpkg";
    const args = tool === "apt-get" ? ["remove", "-y", name] : ["-r", name];
    const base = commandExists("pkexec") ? ["pkexec"] : ["sudo"];
    const r = run(base[0], [...base.slice(1), tool, ...args]);
    if (!r.ok) log.warn(`包管理器卸载可能未完成：${r.stderr.slice(0, 200)}`);
  }
}

async function uninstallLocal(app: any, config: ConfigStore, id: string) {
  const binDir = config.get("binDir");
  const name = repoToName(id);

  // 1. bin 软链
  for (const b of app.bins ?? []) {
    const link = join(binDir, b);
    if (existsSync(link)) {
      Bun.spawnSync(["rm", "-f", link]);
      log.info(`移除软链：${link}`);
    }
  }

  // 2. service
  if (app.service) {
    run("systemctl", ["--user", "disable", `${name}.service`]);
    run("systemctl", ["--user", "stop", `${name}.service`]);
    const svc = join(process.env.HOME ?? "", ".config", "systemd", "user", `${name}.service`);
    Bun.spawnSync(["rm", "-f", svc]);
    const desktop = join(process.env.HOME ?? "", ".local", "share", "applications", `${name}.desktop`);
    Bun.spawnSync(["rm", "-f", desktop]);
    const autostart = join(process.env.HOME ?? "", ".config", "autostart", `${name}.desktop`);
    Bun.spawnSync(["rm", "-f", autostart]);
  }

  // 3. 安装目录
  if (app.installDir && existsSync(app.installDir)) {
    Bun.spawnSync(["rm", "-rf", app.installDir]);
    log.info(`移除目录：${app.installDir}`);
  }
}
