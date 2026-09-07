/**
 * 通用版本/标签比较，覆盖 semver 无法表达的形如 2026.08.15 / v1.0a / b10545 等情况。
 * 规则（gri 通用做法）：
 *   1. 按非数字/数字切分为段；
 *   2. 逐段比较：数字段按数值，字母/字符串段按字典序；
 *   3. 数字永远大于非数字（"1" > "rc"）；
 *   4. 前缀 'v' 忽略。
 * 返回 1 = a 更新, -1 = b 更新, 0 = 相等。
 */

function splitSegments(v: string): { num: boolean; val: string | number }[] {
  const cleaned = v.replace(/^v/i, "");
  const parts = cleaned.split(/(\d+)/);
  const segs: { num: boolean; val: string | number }[] = [];
  for (const p of parts) {
    if (p === "") continue;
    if (/^\d+$/.test(p)) segs.push({ num: true, val: Number(p) });
    else segs.push({ num: false, val: p });
  }
  return segs;
}

export function compareVersions(a: string, b: string): number {
  const sa = splitSegments(a);
  const sb = splitSegments(b);
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const x = sa[i];
    const y = sb[i];
    if (!x && !y) return 0;
    if (!x) return y!.num ? -1 : 1; // 短的缺失段视为 0
    if (!y) return x.num ? 1 : -1;
    if (x.num && y.num) {
      if (x.val !== y.val) return (x.val as number) > (y.val as number) ? 1 : -1;
    } else if (x.num && !y.num) {
      return 1; // 数字 > 字母
    } else if (!x.num && y.num) {
      return -1;
    } else {
      if (x.val !== y.val) return (x.val as string) > (y.val as string) ? 1 : -1;
    }
  }
  return 0;
}

export function isNewer(a: string, b: string): boolean {
  return compareVersions(a, b) > 0;
}

/** a 是否严格晚于 b */
export function isUpToDate(current: string, latest: string): boolean {
  return compareVersions(latest, current) <= 0;
}
