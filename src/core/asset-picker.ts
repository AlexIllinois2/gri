import { Asset, Release } from "./github-client.ts";
import { systemInfo } from "./osinfo.ts";
import { autoCandidates, keywordCond, excludeCond, matches } from "./asset-selector.ts";
import { isRpmDistro, isDebDistro } from "./install-utils.ts";
import { pSelect, pText } from "../ui/prompts.ts";
import { log } from "../util/log.ts";
import { FilterCond } from "../types.ts";

export interface NarrowOptions {
  /** 资产名子串预筛选 */
  select?: string;
}

/**
 * 交互式收敛到唯一资产（提交一次验证一次）。
 * 系统/包管理器自动优先后仍有多于一个候选时，逐轮让用户按
 * 架构/扩展名/libc/关键词/排除 收敛，直到只剩一个。
 */
export async function narrowToUnique(
  release: Release,
  opts: NarrowOptions = {},
): Promise<Asset> {
  let candidates = release.assets;
  const sys = systemInfo;

  // 预筛选
  if (opts.select) candidates = candidates.filter((a) => a.name.includes(opts.select!));

  // 按系统自动优先排序/过滤
  const auto = autoCandidates(candidates, sys);
  if (auto.length) candidates = auto;

  // 包管理器类型自动优先
  const rpm = candidates.filter((a) => a.name.toLowerCase().endsWith(".rpm"));
  const deb = candidates.filter((a) => a.name.toLowerCase().endsWith(".deb"));
  if (rpm.length && isRpmDistro()) candidates = rpm;
  else if (deb.length && isDebDistro()) candidates = deb;

  const history: Asset[][] = [candidates];

  while (candidates.length !== 1) {
    if (candidates.length === 0) {
      throw new Error("没有匹配的资产，请放宽 --select 条件后重试");
    }

    log.step(`当前候选 ${candidates.length} 个：`);
    candidates.forEach((c) => log.info(`  · ${c.name}`));

    const facet = await pSelect<string>(
      `还剩 ${candidates.length} 个候选，按哪类条件继续收敛？`,
      [
        { value: "arch", label: "架构", hint: sys.archAliases.join("/") },
        { value: "ext", label: "扩展名", hint: "tar.gz/zip/deb/rpm/appimage/exe" },
        { value: "libc", label: "libc", hint: "gnu/musl/any" },
        { value: "keyword", label: "关键词", hint: "子串模糊匹配" },
        { value: "exclude", label: "排除", hint: "排除含某关键词的项" },
        ...(history.length > 1 ? [{ value: "back", label: "↩ 退回上一步", hint: "" }] : []),
      ],
    );

    if (facet === "back") {
      history.pop();
      candidates = history[history.length - 1];
      continue;
    }

    let cond: FilterCond;
    if (facet === "arch") {
      const choice = await pSelect<string>("选择架构", [
        ...sys.archAliases.map((a) => ({ value: a, label: a })),
        { value: "", label: "any（不限）" },
      ]);
      cond = { field: "arch", op: "in", value: choice ? [choice] : sys.archAliases };
    } else if (facet === "ext") {
      const choice = await pSelect<string>("选择扩展名", [
        { value: "tar.gz", label: "tar.gz" },
        { value: "tgz", label: "tgz" },
        { value: "zip", label: "zip" },
        { value: "deb", label: "deb" },
        { value: "rpm", label: "rpm" },
        { value: "appimage", label: "appimage" },
        { value: "exe", label: "exe" },
      ]);
      cond = { field: "ext", op: "eq", value: [choice] };
    } else if (facet === "libc") {
      const choice = await pSelect<string>("选择 libc", [
        { value: "gnu", label: "gnu" },
        { value: "musl", label: "musl" },
        { value: "any", label: "any" },
      ]);
      cond = { field: "libc", op: "in", value: choice === "any" ? ["gnu", "musl"] : [choice] };
    } else if (facet === "keyword") {
      const kw = await pText("输入要匹配的子串");
      cond = keywordCond(kw);
    } else if (facet === "exclude") {
      const kw = await pText("输入要排除的子串");
      cond = excludeCond(kw);
    } else {
      continue;
    }

    const next = candidates.filter((a) => matches(a, cond));

    if (next.length === 0) {
      log.warn("当前条件无匹配，已忽略该条件，请换一个条件或退回上一步。");
      continue;
    }
    candidates = next;
    history.push(candidates);
  }

  return candidates[0];
}
