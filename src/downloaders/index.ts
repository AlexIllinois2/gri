import { DownloadJob, DownloadSource, ProgressEvent } from "../types.ts";
import { nativeDownloader } from "./native.ts";
import { aria2Downloader } from "./aria2.ts";
import { ghDownloader } from "./gh-cli.ts";
import { ConfigData } from "../types.ts";
import { log } from "../util/log.ts";

export type { DownloadJob, ProgressEvent } from "../types.ts";

export interface Downloader {
  name: DownloadSource;
  isAvailable(): Promise<boolean> | boolean;
  run(
    job: DownloadJob,
    jobId: string,
    onProgress: (p: ProgressEvent) => void,
    onLog: (line: string) => void,
  ): Promise<void>;
}

export const DOWNLOADERS: Record<DownloadSource, Downloader> = {
  native: nativeDownloader,
  aria2: aria2Downloader,
  gh: ghDownloader,
};

/** 统一把下载链接打印成一行，供 stdout / WS 推送 */
export function formatDownloadLine(source: DownloadSource, job: DownloadJob): string {
  return `[source=${source}] GET ${job.url}`;
}

/** 根据 config 选择实际下载后端（auto=按可用性挑选） */
export async function selectDownloader(config: ConfigData, prefer?: DownloadSource): Promise<Downloader> {
  const want = prefer ?? config.downloadBackend;
  if (want === "auto") {
    // 优先 aria2（多线程），否则 native
    if (await aria2Downloader.isAvailable()) return aria2Downloader;
    return nativeDownloader;
  }
  const d = DOWNLOADERS[want];
  if (d && (await d.isAvailable())) return d;
  log.warn(`${want} 下载后端不可用，回退到 native`);
  return nativeDownloader;
}

export async function runDownload(
  job: DownloadJob,
  config: ConfigData,
  opts: {
    jobId: string;
    onProgress?: (p: ProgressEvent) => void;
    onLog?: (line: string) => void;
    prefer?: DownloadSource;
  },
): Promise<void> {
  const dl = await selectDownloader(config, opts.prefer);
  log.info(formatDownloadLine(dl.name, job));
  opts.onLog?.(formatDownloadLine(dl.name, job));
  await dl.run(job, opts.jobId, opts.onProgress ?? (() => {}), opts.onLog ?? (() => {}));
}
