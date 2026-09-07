/** 统一日志输出到 stderr，避免污染 stdout（--json / 管道场景） */

const useColor = Boolean(process.stdout.isTTY);
const ESC = "\x1b[";

function paint(code: number, s: string): string {
  return useColor ? `${ESC}${code}m${s}${ESC}0m` : s;
}

export const log = {
  info(msg: string) {
    console.error(paint(32, "[+]") + " " + msg);
  },
  step(msg: string) {
    console.error(paint(36, "[*]") + " " + msg);
  },
  warn(msg: string) {
    console.error(paint(33, "[!]") + " " + msg);
  },
  error(msg: string) {
    console.error(paint(31, "[-]") + " " + msg);
  },
  /** 普通信息到 stdout（如表格） */
  out(msg: string) {
    console.log(msg);
  },
};

/** 抹去 token 子串，避免泄漏 */
export function redactToken(text: string, token?: string): string {
  if (!token) return text;
  return text.replaceAll(token, "***REDACTED***");
}
