import { ConfigStore } from "../state/config.ts";
import { AppsStore } from "../state/apps.ts";
import { InstalledStore_ } from "../state/installed.ts";
import { taskBus } from "./ws-bus.ts";
import { installNonInteractive, updateNonInteractive, checkUpdates } from "../core/auto-install.ts";
import { cmdRemove } from "../commands/remove.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { log } from "../util/log.ts";

const WEB_INDEX = join(import.meta.dir, "..", "..", "web", "index.html");

let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleShutdown() {
  if (shutdownTimer) return;
  shutdownTimer = setTimeout(() => {
    if (taskBus.clientCount > 0) return;
    log.info("无客户端连接，正在关闭服务...");
    process.exit(0);
  }, 30_000);
}
function cancelShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

function json(data: any): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function apiRouter(req: Request, url: URL): Promise<Response> {
  const store = InstalledStore_.load();
  const apps = AppsStore.load();

  /** 台账 + apps.json 规则（type/filter/layout 在规则里） */
  const withRule = (a: any) => {
    const rule = apps.get(a.repo ?? a.assetName);
    return { ...a, type: rule?.type, filter: rule?.filter, layout: rule?.layout };
  };

  if (url.pathname === "/api/apps" && req.method === "GET") {
    const installed = store.list().map((a) => ({ ...withRule(a), installed: true }));
    const pending = apps
      .list()
      .filter((r) => !store.has(r.repo))
      .map((r) => ({ ...r, installed: false }));
    return json([...installed, ...pending]);
  }

  if (url.pathname === "/api/app" && req.method === "GET") {
    const id = url.searchParams.get("id")!;
    const app = store.get(id);
    return json(app ? withRule(app) : null);
  }

  if (url.pathname === "/api/install" && req.method === "POST") {
    const body = await readBody(req);
    const jobId = `install-${Date.now()}`;
    // 异步执行，立即返回 jobId
    (async () => {
      try {
        await installNonInteractive({
          repo: body.repo ?? body.local_archive_path,
          select: body.select,
          bins: body.bins,
          allBin: body.allBin ?? true,
          icon: body.icon,
          service: body.service,
          tag: body.tag,
        }, {
          onLog: (line) => taskBus.log(jobId, line),
          onProgress: (p) => taskBus.progress(jobId, p.bytes, p.total),
        });
        taskBus.done(jobId, { ok: true });
      } catch (e: any) {
        taskBus.error(jobId, e.message);
      }
    })();
    return json({ jobId });
  }

  if (url.pathname === "/api/check-update" && req.method === "POST") {
    const body = await readBody(req);
    const res = await checkUpdates(body.ids);
    return json(res);
  }

  if (url.pathname === "/api/update" && req.method === "POST") {
    const body = await readBody(req);
    const jobId = `update-${Date.now()}`;
    (async () => {
      try {
        await updateNonInteractive(body.ids ?? [], {
          onLog: (line) => taskBus.log(jobId, line),
          onProgress: (p) => taskBus.progress(jobId, p.bytes, p.total),
        });
        taskBus.done(jobId, { ok: true });
      } catch (e: any) {
        taskBus.error(jobId, e.message);
      }
    })();
    return json({ jobId });
  }

  if (url.pathname === "/api/remove" && req.method === "POST") {
    const body = await readBody(req);
    try {
      await cmdRemove(body.id, { yes: true });
      return json({ ok: true });
    } catch (e: any) {
      return json({ ok: false, error: e.message });
    }
  }

  if (url.pathname === "/api/token" && req.method === "GET") {
    const token = ConfigStore.load();
    return json({ ok: true });
  }

  return new Response("Not Found", { status: 404 });
}

export function startServer(openBrowser = true): void {
  const config = ConfigStore.load();
  const port = config.get("serverPort");

  const server = Bun.serve({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = srv.upgrade(req);
        return upgraded ? undefined : new Response("WS upgrade failed", { status: 400 });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (existsSync(WEB_INDEX)) return new Response(Bun.file(WEB_INDEX), { headers: { "Content-Type": "text/html" } });
        return new Response("Web UI 未构建（缺少 web/index.html）", { status: 404 });
      }
      if (url.pathname.startsWith("/api/")) return apiRouter(req, url);
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        taskBus.addClient(ws as any);
        cancelShutdown();
        log.info("Web 客户端已连接");
      },
      close(ws) {
        taskBus.removeClient(ws as any);
        if (taskBus.clientCount === 0) scheduleShutdown();
      },
      message() {},
    },
  });

  log.info(`GRI Web 服务已启动： http://localhost:${port}`);
  if (openBrowser) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe /c start" : "xdg-open";
    try {
      Bun.spawn([cmd, `http://localhost:${port}`]);
    } catch {
      /* ignore */
    }
  }
}
