import { log } from "./log.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

/** 运行系统命令，捕获输出。非 0 退出不算抛异常，由调用方判断。 */
export function run(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): RunResult {
  const proc = Bun.spawnSync([cmd, ...args], {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts?.env,
  });
  const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array());
  const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array());
  return { code: proc.exitCode ?? -1, stdout, stderr, ok: (proc.exitCode ?? -1) === 0 };
}

/** 异步运行（带实时输出到 stderr） */
export async function runAsync(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; onLog?: (line: string) => void },
): Promise<RunResult> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts?.env,
  });
  const collect = async (stream: ReadableStream<Uint8Array> | null, isErr: boolean) => {
    if (!stream) return "";
    const reader = stream.getReader();
    let buf = "";
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      out += text;
      buf += text;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (isErr && opts?.onLog) opts.onLog(line);
        else if (opts?.onLog) opts.onLog(line);
      }
    }
    if (buf && opts?.onLog) opts.onLog(buf);
    return out;
  };
  const [stdout, stderr] = await Promise.all([collect(proc.stdout, false), collect(proc.stderr, true)]);
  const code = await proc.exited;
  return { code, stdout, stderr, ok: code === 0 };
}

export function commandExists(cmd: string): boolean {
  const which = run("which", [cmd]);
  return which.ok && which.stdout.trim().length > 0;
}
