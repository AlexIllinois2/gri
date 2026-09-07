import { z } from "zod";
import { APPS_FILE, CONFIG_HOME } from "./paths.ts";
import {
  AppRule,
  AppsRules,
  FilterCond,
  FilterRule,
  InstallType,
  LayoutSpec,
} from "../types.ts";
import { readText, writeText } from "../util/io.ts";
import { ARCHIVE_EXTS } from "../core/install-utils.ts";

const INSTALL_TYPES = ["archive", "appimage", "rpm", "deb", "exe", "raw"] as const;

const FilterCondSchema = z.object({
  field: z.enum(["name", "arch", "os", "ext", "libc", "contains", "excludes"]),
  value: z.union([z.string(), z.array(z.string())]),
  op: z.enum(["match", "in", "eq", "contains", "excludes"]).optional(),
});

/** filter 元素：字符串（contains 子串）或结构化条件 */
const FilterRuleSchema = z.union([z.string(), FilterCondSchema]);

const BinSpecSchema = z.object({
  path: z.string(),
  as: z.string().optional(),
});

const LayoutSchema = z.object({
  rootDir: z.string().optional(),
  stripComponents: z.number().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  bins: z.array(BinSpecSchema).optional(),
  icons: z.array(z.string()).optional(),
  desktopFile: z.string().nullable().optional(),
  serviceExec: z.string().nullable().optional(),
  autoStart: z.boolean().optional(),
});

const AppRuleSchema = z
  .object({
    repo: z.string().optional(),
    suffix: z.string().optional(),
    type: z.enum(INSTALL_TYPES).optional(),
    filter: z.array(FilterRuleSchema).optional(),
    layout: LayoutSchema.optional(),
    bins: z.array(z.string()).optional(),
    icon: z.string().optional(),
    arch: z.string().optional(),
  })
  .passthrough();

/** 字符串条件归一化为结构化条件 */
export function normalizeFilter(filter?: FilterRule[]): FilterCond[] {
  if (!filter?.length) return [];
  return filter.map((f) =>
    typeof f === "string"
      ? { field: "contains" as const, op: "contains" as const, value: f }
      : (f as FilterCond),
  );
}

/** 旧版 suffix 推导 type（与 gri.py load_apps 一致）；压缩包一律归为 archive */
export function typeFromSuffix(suffix: string): InstallType | undefined {
  const s = suffix.toLowerCase();
  if (s.includes("rpm")) return "rpm";
  // suffix 可能带点也可能不带点（"tar.gz" / ".tar.gz"），统一去掉点比较
  if (ARCHIVE_EXTS.some((ext) => s.includes(ext.slice(1)))) return "archive";
  if (s.includes("appimage")) return "appimage";
  if (s.includes("deb")) return "deb";
  if (s.includes("exe")) return "exe";
  return undefined;
}

export class AppsStore {
  rules: AppsRules;

  constructor(rules: AppsRules) {
    this.rules = rules;
  }

  /** 加载 apps.json，并做 suffix→type/filter 兼容归一化（参考 gri.py load_apps） */
  static load(): AppsStore {
    let raw: Record<string, any> = {};
    const text = readText(APPS_FILE);
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = {};
      }
    }
    const result: AppsRules = {};
    for (const [key, val] of Object.entries(raw)) {
      if (typeof val !== "object" || val === null) continue;
      const item: any = { ...val };
      item.repo = val.repo ?? key;
      // 兼容旧版 suffix
      if (item.suffix) {
        if (!item.type) item.type = typeFromSuffix(item.suffix);
        if (!item.filter) item.filter = [item.suffix];
      }
      result[key] = AppRuleSchema.parse(item) as AppRule;
    }
    return new AppsStore(result);
  }

  static default(): AppsStore {
    return new AppsStore({});
  }

  get(repo: string): AppRule | undefined {
    return this.rules[repo];
  }

  /** 取规则，不存在则按 id 创建一条空规则（不落盘） */
  ensure(id: string, repo?: string): AppRule {
    let rule = this.rules[id];
    if (!rule) {
      rule = { repo: repo ?? id };
      this.rules[id] = rule;
    }
    if (repo && !rule.repo) rule.repo = repo;
    return rule;
  }

  list(): AppRule[] {
    return Object.values(this.rules);
  }

  set(repo: string, rule: AppRule): void {
    this.rules[repo] = rule;
    this.save();
  }

  save(): void {
    Bun.spawnSync(["mkdir", "-p", CONFIG_HOME]);
    writeText(APPS_FILE, JSON.stringify(this.rules, null, 2));
  }
}

/**
 * 解析出一条规则实际生效的布局：apps.json 里写了就用写的，
 * 否则按 bins/icon 等简写字段兜底构造。
 */
export function effectiveLayout(rule: AppRule | undefined): LayoutSpec | undefined {
  if (!rule) return undefined;
  if (rule.layout) return rule.layout;
  if (!rule.bins?.length && !rule.icon) return undefined;
  return {
    stripComponents: 1,
    bins: rule.bins?.map((b) => ({ path: b })),
    icons: rule.icon ? [rule.icon] : undefined,
  };
}
