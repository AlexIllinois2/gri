import { DownloadJob, ProgressEvent } from "../types.ts";
import { Downloader } from "./index.ts";
import { redactToken } from "../util/log.ts";

/** 原生下载：fetch 流式写入文件，支持 token 与私有库 raw 下载 */
export const nativeDownloader: Downloader = {
  name: "native",

  isAvailable() {
    return true;
  },

  async run(
    job: DownloadJob,
    _jobId: string,
    onProgress: (p: ProgressEvent) => void,
    _onLog: (line: string) => void,
  ): Promise<void> {
    const headers: Record<string, string> = { ...(job.headers ?? {}) };
    if (job.acceptRaw) headers["Accept"] = "application/octet-stream";

    const res = await fetch(job.url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`下载失败 ${res.status} ${job.url}\n${body.slice(0, 400)}`);
    }
    const total = res.headers.get("content-length") ? Number(res.headers.get("content-length")) : undefined;

    const file = Bun.file(job.dest);
    const writer = file.writer();
    if (!res.body) throw new Error("响应无正文");

    const reader = res.body.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        writer.write(value);
        bytes += value.length;
        onProgress({ bytes, total });
      }
    }
    await writer.end();
  },
};
