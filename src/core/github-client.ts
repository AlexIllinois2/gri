import { TOKEN_FILE, CONFIG_HOME } from "../state/paths.ts";
import { MatchError } from "../types.ts";
import { log } from "../util/log.ts";
import { readText, writeText } from "../util/io.ts";

export interface Asset {
  name: string;
  /** browser_download_url */
  download_url: string;
  size?: number;
  contentType?: string;
}

export interface Release {
  tag: string;
  name: string;
  prerelease: boolean;
  assets: Asset[];
}

const IGNORED_ASSETS = ["sha256", "sha512", "checksums", ".sig", ".pem"];

function skipIgnored(asset: Asset): boolean {
  return !IGNORED_ASSETS.some((ig) => asset.name.toLowerCase().includes(ig.toLowerCase()));
}

/** token 来源优先级：--token > $GRI_GITHUB_TOKEN > $GITHUB_TOKEN > $XDG_CONFIG_HOME/gri/token */
export function resolveToken(cliToken?: string): string | undefined {
  if (cliToken && cliToken.trim()) return cliToken.trim();
  if (Bun.env.GRI_GITHUB_TOKEN) return Bun.env.GRI_GITHUB_TOKEN;
  if (Bun.env.GITHUB_TOKEN) return Bun.env.GITHUB_TOKEN;
  try {
    const text = readText(TOKEN_FILE);
    if (text && text.trim()) return text.trim();
  } catch {
    /* ignore */
  }
  return undefined;
}

function authHeader(token?: string): Record<string, string> {
  return token ? { Authorization: `token ${token}` } : {};
}

function apiHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "gri-ts",
    ...authHeader(token),
  };
}

export class GithubClient {
  token?: string;

  constructor(token?: string) {
    this.token = token;
  }

  static fromEnvironment(cliToken?: string): GithubClient {
    return new GithubClient(resolveToken(cliToken));
  }

  private async request(url: string, headers: Record<string, string>): Promise<any> {
    const res = await fetch(url, { headers });
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      if (remaining === "0") {
        const resetAt = reset ? Number(reset) * 1000 : undefined;
        const when = resetAt ? new Date(resetAt).toLocaleString() : "unknown";
        throw new MatchError(
          "rate-limit",
          `GitHub API 速率限制已用完，重置时间：${when}`,
          { resetAt },
        );
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MatchError(
        "not-found",
        `GitHub 请求失败 ${res.status}: ${url}\n${body.slice(0, 300)}`,
      );
    }
    return res.json();
  }

  /** 获取 latest release（带分页/速率处理） */
  async getLatestRelease(owner: string, repo: string): Promise<Release> {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const json = await this.request(url, apiHeaders(this.token));
    return this.toRelease(json);
  }

  /** 按 tag 获取指定 release */
  async getReleaseByTag(owner: string, repo: string, tag: string): Promise<Release> {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
    const json = await this.request(url, apiHeaders(this.token));
    return this.toRelease(json);
  }

  /** 列出所有 release（用于 update 检查，最多取前几页） */
  async listReleases(owner: string, repo: string, perPage = 10): Promise<Release[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${perPage}`;
    const json = await this.request(url, apiHeaders(this.token));
    if (!Array.isArray(json)) return [];
    return json.map((r: any) => this.toRelease(r));
  }

  private toRelease(json: any): Release {
    return {
      tag: json.tag_name ?? json.tag ?? "",
      name: json.name ?? json.tag_name ?? "",
      prerelease: !!json.prerelease,
      assets: (json.assets ?? [])
        .filter((a: any) => skipIgnored({ name: a.name } as Asset))
        .map(
          (a: any): Asset => ({
            name: a.name,
            download_url: a.browser_download_url,
            size: a.size,
            contentType: a.content_type,
          }),
        ),
    };
  }

  /** 校验 token 有效性：GET /user */
  async validateToken(): Promise<boolean> {
    if (!this.token) return false;
    try {
      const res = await fetch("https://api.github.com/user", { headers: apiHeaders(this.token) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 保存 token 到 $XDG_CONFIG_HOME/gri/token，权限 600 */
  async saveToken(token: string): Promise<void> {
    Bun.spawnSync(["mkdir", "-p", CONFIG_HOME]);
    writeText(TOKEN_FILE, token.trim());
    try {
      Bun.spawnSync(["chmod", "600", TOKEN_FILE]);
    } catch {
      /* ignore on non-unix */
    }
    log.info(`Token 已保存至 ${TOKEN_FILE}（权限 600）`);
  }
}
