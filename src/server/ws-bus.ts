import { WebSocket } from "bun";

export type BusEvent =
  | { kind: "progress"; jobId: string; bytes: number; total?: number }
  | { kind: "log"; jobId: string; line: string }
  | { kind: "done"; jobId: string; result?: any }
  | { kind: "error"; jobId: string; message: string };

type Listener = (e: BusEvent) => void;

class TaskBus {
  private listeners: Listener[] = [];
  private clients = new Set<WebSocket>();

  on(fn: Listener) {
    this.listeners.push(fn);
  }

  addClient(ws: WebSocket) {
    this.clients.add(ws);
  }
  removeClient(ws: WebSocket) {
    this.clients.delete(ws);
  }
  get clientCount() {
    return this.clients.size;
  }

  emit(e: BusEvent) {
    for (const fn of this.listeners) fn(e);
    const msg = JSON.stringify(e);
    for (const ws of this.clients) {
      try {
        ws.send(msg);
      } catch {
        /* ignore */
      }
    }
  }

  /** 任务进度/日志便捷方法 */
  log(jobId: string, line: string) {
    this.emit({ kind: "log", jobId, line });
  }
  progress(jobId: string, bytes: number, total?: number) {
    this.emit({ kind: "progress", jobId, bytes, total });
  }
  done(jobId: string, result?: any) {
    this.emit({ kind: "done", jobId, result });
  }
  error(jobId: string, message: string) {
    this.emit({ kind: "error", jobId, message });
  }
}

export const taskBus = new TaskBus();
