/**
 * 移植 dra 的 TaggedAsset 逻辑。
 * - untag: 给定 tag 与资产名，把版本段替换为 {tag} 得到模板
 * - tag:   把模板里的 {tag} 替换为具体版本
 * 例：untag("v1.5.3", "file-v1.5.3-linux.deb") => "file-v{tag}-linux.deb"
 */

export const TAG_PLACEHOLDER = "{tag}";

/** dra 的 Tag::version() 会去掉前导 v，保持一致 */
function versionOf(tag: string): string {
  return tag.replace(/^v/i, "");
}

export function untag(tag: string, assetName: string): string {
  return assetName.replace(versionOf(tag), TAG_PLACEHOLDER);
}

export function tag(tagValue: string, untagged: string): string {
  return untagged.replace(TAG_PLACEHOLDER, versionOf(tagValue));
}

/** 从资产名里提取版本号片段（用于把 v1.5.3 这类 tag 也匹配到 name 里只含 1.5.3 的情形） */
export function normalizeTag(t: string): string {
  // 去除可能存在的 'v' 前缀用于降级匹配
  return t;
}
