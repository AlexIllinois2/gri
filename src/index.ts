#!/usr/bin/env bun
import { Command } from "commander";
import { cmdList } from "./commands/list.ts";
import { cmdInstall, InstallOptions } from "./commands/install.ts";
import { cmdAdd } from "./commands/add.ts";
import { cmdClean } from "./commands/clean.ts";
import { cmdUpdate } from "./commands/update.ts";
import { cmdRemove } from "./commands/remove.ts";
import { cmdDown } from "./commands/down.ts";
import { cmdToken } from "./commands/token.ts";
import { ensureDirs } from "./state/paths.ts";
import { log } from "./util/log.ts";

const program = new Command();

program
  .name("gri")
  .description("GitHub Release 应用管理器 · 基于 Bun + TypeScript")
  .version("1.0.0");

program
  .command("list")
  .description("列出已安装的应用")
  .option("--json", "以 JSON 格式输出")
  .action(async (opts) => {
    await cmdList({ json: opts.json });
  });

program
  .command("add")
  .description("添加一个或多个 repo 到管理列表（不安装）")
  .argument("<repos...>", "owner/repo 格式的仓库地址（可多个）")
  .option("-f, --force", "已存在时覆盖更新")
  .action(async (repos: string[], opts) => {
    await cmdAdd(repos, { force: opts.force });
  });

program
  .command("clean")
  .description("清除缓存（下载的包文件）")
  .option("--apps", "同时清理已安装应用目录")
  .action(async (opts) => {
    await cmdClean({ apps: opts.apps });
  });

program
  .command("install")
  .description("安装应用：gri install <owner/repo|本地文件>")
  .argument("<arg>", "owner/repo 或本地归档文件路径")
  .option("--select <selector>", "资产名子串预筛选")
  .option("--tag <tag>", "安装指定 tag 的 release")
  .option("-b, --bin <path...>", "指定要暴露的二进制（可多次）")
  .option("--all-bin", "自动暴露所有可执行文件")
  .option("-i, --icon <path>", "图标路径（包内相对或外部绝对）")
  .option("-s, --service <exec>", "生成 systemd 用户服务")
  .option("-y", "跳过确认，使用默认布局")
  .action(async (arg: string, opts) => {
    const o: InstallOptions = {
      select: opts.select,
      tag: opts.tag,
      bins: opts.bin,
      allBin: opts.allBin,
      icon: opts.icon,
      service: opts.service,
      yes: opts.y,
    };
    await cmdInstall(arg, o);
  });

program
  .command("down")
  .description("仅下载一个 release 资产（不添加、不安装、不记录任何状态）")
  .argument("<repo>", "owner/repo 格式的仓库地址")
  .option("--select <selector>", "资产名子串预筛选")
  .option("--tag <tag>", "下载指定 tag 的 release")
  .option("-o, --out <path>", "输出文件路径；已存在目录或以 / 结尾则视为目录")
  .action(async (repo: string, opts) => {
    await cmdDown(repo, { select: opts.select, tag: opts.tag, out: opts.out });
  });

program
  .command("update")
  .description("升级应用（默认全部，可指定 repo；-y 静默批量）")
  .argument("[repos...]", "要升级的 repo（不传则全部）")
  .option("-y, --yes", "自动确认更新")
  .action(async (repos: string[], opts) => {
    await cmdUpdate(repos, { yes: opts.yes });
  });

program
  .command("remove")
  .description("移除已安装的应用")
  .argument("<repo>", "owner/repo 或应用名")
  .option("-y, --yes", "跳过确认")
  .action(async (repo: string, opts) => {
    await cmdRemove(repo, { yes: opts.yes });
  });

program
  .command("token")
  .description("查看或设置 GitHub Token")
  .argument("[token]", "要保存的 PAT（省略则查看当前状态）")
  .action(async (token?: string) => {
    await cmdToken(token);
  });

program
  .command("help", { isDefault: false })
  .description("显示帮助")
  .action(() => {
    program.outputHelp();
  });

// 全局错误兜底
process.on("uncaughtException", (e) => {
  log.error(String(e));
  process.exit(1);
});

ensureDirs();
program.parseAsync(process.argv).catch((e) => {
  log.error(e?.message ?? String(e));
  process.exit(1);
});
