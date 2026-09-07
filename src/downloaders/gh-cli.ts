import { DownloadJob, ProgressEvent } from "../types.ts";
import { Downloader } from "./index.ts";
import { commandExists, runAsync } from "../util/exec.ts";
import { resolveToken } from "../core/github-client.ts";
import { log } from "../util/log.ts";

/** 从 browser_download_url 解析 owner/repo/tag/assetname */
function parseGithubUrl(url: string): { owner: string; repo: string; tag: string; asset: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], tag: decodeURIComponent(m[3]), asset: decodeURIComponent(m[4]) };
}

/** 兜底下载：明确不使用 gh 自己的筛选，pattern 传通配符下全量后由我们侧筛选 */
export const ghDownloader: Downloader = {
  name: "gh",

  isAvailable() {
    return commandExists("gh");
  },

  async run(
    job: DownloadJob,
    _jobId: string,
    _onProgress: (p: ProgressEvent) => void,
    onLog: (line: string) => void,
  ): Promise<void> {
    const parsed = parseGithubUrl(job.url);
    if (!parsed) {
      throw new Error(`gh 下载器无法解析非 GitHub 链接：${job.url}`);
    }
    const dir = job.dest.substring(0, job.dest.lastIndexOf("/")) || ".";
    const outName = job.dest.substring(job.dest.lastIndexOf("/") + 1);

    const token = resolveToken();
    const env = token ? { ...(process.env as Record<string, string>), GITHUB_TOKEN: token } : (process.env as Record<string, string>);

    const args = [
      "release",
      "download",
      parsed.tag,
      "--repo",
      `${parsed.owner}/${parsed.repo}`,
      "--pattern",
      parsed.asset,
      "--dir",
      dir,
      "--clobber",
    ];

    const res = await runAsync("gh", args, {
      env,
      onLog: (line) => onLog(line),
    });
    if (!res.ok) {
      throw new Error(`gh 下载失败：${res.stderr.slice(0, 300)}`);
    }
    // gh 下载的文件名可能与 outName 不同，做个重命名兜底
    const downloaded = `${dir}/${parsed.asset}`;
    if (downloaded !== job.dest && Bun.file(downloaded).size > 0n) {
      try {
        Bun.spawnSync(["mv", "-f", downloaded, job.dest]);
      } catch {
        /* ignore */
      }
    }
  },
};
