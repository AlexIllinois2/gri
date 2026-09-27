import * as readline from "node:readline";

/**
 * 自包含 TTY 交互层，替代 @clack/prompts。
 * 使用输入数字的方式交互，而非方向键。
 */

const ESC = "\x1b[";
const GRAY = ESC + "90m";
const CYAN = ESC + "36m";
const GREEN = ESC + "32m";
const RED = ESC + "31m";
const RESET = ESC + "0m";

function write(s: string) {
  process.stdout.write(s);
}

export class CancelledError extends Error {
  constructor() {
    super("用户已取消");
    this.name = "CancelledError";
  }
}

interface Opt<T> {
  value: T;
  label: string;
  hint?: string;
}

// TTY 模式下用 readline.question 交互；非 TTY（管道）模式下预读所有行。
let _lines: string[] | null = null;
let _linesDone = false;

function rlQuestion(question: string): Promise<string> {
  if (process.stdin.isTTY) {
    // TTY：每次提问创建独立的 readline，答完即关闭
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(question, (ans) => {
        rl.close();
        resolve(ans);
      });
    });
  }
  // 非 TTY：从预读队列取行
  if (!_lines) {
    _lines = [];
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => _lines!.push(line));
    rl.on("close", () => { _linesDone = true; });
  }
  return new Promise((resolve) => {
    const tryGet = () => {
      if (_lines!.length > 0) {
        resolve(_lines!.shift()!);
      } else if (_linesDone) {
        resolve("");
      } else {
        setTimeout(tryGet, 10);
      }
    };
    tryGet();
  });
}

/** 单选（输入数字选择） */
export async function pSelect<T>(message: string, options: Opt<T>[], initialValue?: T): Promise<T> {
  if (!options.length) throw new Error("pSelect: 无可选项错误");

  // 显示选项列表
  write(message + "\n");
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    const hint = o.hint ? " (" + o.hint + ")" : "";
    write("  " + (i + 1) + ". " + o.label + hint + "\n");
  }
  const ans = await rlQuestion("选择序号> ");
  const idx = parseInt(ans, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= options.length) {
    write(RED + "无效序号" + RESET + "\n");
    throw new Error("无效的选项序号");
  }
  return options[idx].value;
}

/** 多选（输入数字选择，逗号分隔） */
export async function pMulti<T>(message: string, options: Opt<T>[]): Promise<T[]> {
  if (!options.length) return [];

  write(message + "\n");
  for (let i = 0; i < options.length; i++) {
    write("  " + (i + 1) + ". " + options[i].label + "\n");
  }
  const ans = await rlQuestion("选择序号(逗号分隔)> ");
  const idxs = ans
    .split(",")
    .map((x) => parseInt(x.trim(), 10) - 1)
    .filter((i) => !isNaN(i) && i >= 0 && i < options.length);
  return idxs.map((i) => options[i].value);
}

/** 确认 (y/n) */
export async function pConfirm(message: string, initial = false): Promise<boolean> {
  const def = initial ? "Y/n" : "y/N";
  const ans = (await rlQuestion(message + " (" + def + ") ")).trim().toLowerCase();
  if (ans === "y" || ans === "yes") return true;
  if (ans === "n" || ans === "no") return false;
  return initial;
}

/** 文本输入 */
export async function pText(message: string, placeholder?: string): Promise<string> {
  const hint = placeholder ? " " + GRAY + "(" + placeholder + ")" + RESET : "";
  const ans = (await rlQuestion(message + hint + " ")).trim();
  return ans;
}

/** 简易旋转 spinner */
export function newSpinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let msg = "";
  let i = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  // 进度与状态一律走 stderr，保证 stdout 只承载数据输出（可被管道消费）
  const draw = () => process.stderr.write("\r" + ESC + "K" + frames[i] + " " + msg);
  return {
    start(m: string) {
      msg = m;
      i = 0;
      if (process.stdout.isTTY) {
        timer = setInterval(() => {
          i = (i + 1) % frames.length;
          draw();
        }, 80);
      } else {
        process.stderr.write("… " + msg + "\n");
      }
    },
    message(m: string) {
      msg = m;
      if (!timer) process.stderr.write("… " + m + "\n");
    },
    stop(m?: string, code?: number) {
      if (timer) clearInterval(timer);
      timer = null;
      const icon = code ? ESC + "31m✗" + RESET : GREEN + "✔" + RESET;
      process.stderr.write("\r" + ESC + "K" + icon + " " + (m ?? msg) + "\n");
    },
  };
}

// 兼容旧调用场景的占位导出
export function intro(msg: string) {
  process.stdout.write("\n" + CYAN + "◆" + RESET + " " + msg + "\n");
}
export function outro(msg: string) {
  process.stdout.write(GREEN + "◆" + RESET + " " + msg + "\n");
}
export function note(msg: string, title?: string) {
  process.stdout.write((title ? title + "\n" : "") + msg + "\n");
}
export const pLog = {
  info: (m: string) => process.stdout.write("[+] " + m + "\n"),
  error: (m: string) => process.stdout.write("[-] " + m + "\n"),
};

/** 从候选资产里挑一个（兼容导出） */
export async function selectAsset<T extends { name: string }>(candidates: T[], message: string): Promise<T> {
  return pSelect<T>(
    message,
    candidates.map((a) => ({ value: a, label: a.name })),
  );
}
