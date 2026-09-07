import { DownloadJob, ProgressEvent } from "../types.ts";
import { Downloader } from "./index.ts";
import { commandExists, runAsync } from "../util/exec.ts";
import { log } from "../util/log.ts";

/** 调用 aria2c 多线程下载；命令不存在时不可用（由 selectDownloader 回退） */
export const aria2Downloader: Downloader = {
  name: "aria2",

  isAvailable() {
    return commandExists("aria2c");
  },

  async run(
    job: DownloadJob,
    _jobId: string,
    onProgress: (p: ProgressEvent) => void,
    onLog: (line: string) => void,
  ): Promise<void> {
    const dir = job.dest.substring(0, job.dest.lastIndexOf("/")) || ".";
    const outName = job.dest.substring(job.dest.lastIndexOf("/") + 1);
    const args = [
      "-x16",
      "-s16",
      "-k1M",
      "--dir=" + dir,
      "--out=" + outName,
      "--summary-interval=5",
    ];
    for (const [k, v] of Object.entries(job.headers ?? {})) {
      args.push(`--header=${k}: ${v}`);
    }
    args.push(job.url);

    const proc = Bun.spawn(["aria2c", ...args], { stdout: "pipe", stderr: "pipe" });
    const reader = proc.stdout?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      let buf = "";
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value);
        buf += text;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          onLog(line);
          const m = line.match(/\(([\d.]+[KMG]?B)\)/);
          if (m) {
            bytes = parseSize(m[1]);
            onProgress({ bytes });
          }
        }
      }
    }
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`aria2c 下载失败，退出码 ${code}`);
    }
  },
};

function parseSize(s: string): number {
  const m = s.match(/^([\d.]+)\s*([KMG]?)B$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return n * (unit === "K" ? 1024 : unit === "M" ? 1024 ** 2 : unit === "G" ? 1024 ** 3 : 1);
}
