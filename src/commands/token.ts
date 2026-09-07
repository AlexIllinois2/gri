import { GithubClient } from "../core/github-client.ts";
import { TOKEN_FILE } from "../state/paths.ts";
import { log } from "../util/log.ts";

export async function cmdToken(token?: string): Promise<void> {
  if (!token) {
    // 显示当前配置状态
    const resolved = GithubClient.fromEnvironment().token;
    if (!resolved) {
      log.info("当前未配置 GitHub Token。");
      log.info("可通过 `gri token <your_pat>` 写入，或设置环境变量 $GITHUB_TOKEN / $GRI_GITHUB_TOKEN。");
      return;
    }
    const last4 = resolved.slice(-4);
    const masked = "*".repeat(Math.max(0, resolved.length - 4)) + last4;
    log.info(`已配置 Token：${masked}`);
    const valid = await GithubClient.fromEnvironment().validateToken();
    log.info(valid ? "Token 有效 ✓" : "Token 可能无效或已过期 ✗");
    return;
  }

  const client = new GithubClient(token.trim());
  log.info("正在校验 Token...");
  const valid = await client.validateToken();
  if (!valid) {
    log.warn(`Token 校验失败（无效或网络不可达）。仍会保存，但你可在 ${TOKEN_FILE} 手动修正。`);
  } else {
    log.info("Token 校验通过 ✓");
  }
  await client.saveToken(token);
}
