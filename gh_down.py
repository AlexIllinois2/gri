#!/usr/bin/env python3
"""
传参: repo(jswysnemc/mark-shot), --filter(.rpm$), 下载文件夹

查询release lastest信息命令: gh release view --repo jswysnemc/mark-shot --json assets --jq '.assets[] | select(.name | test(".rpm$"; "i") and test("x86_64|x86-64|amd64"; "i"))'

json:
{
  "apiUrl": "https://api.github.com/repos/jswysnemc/mark-shot/releases/assets/479066173",
  "contentType": "application/x-redhat-package-manager",
  "createdAt": "2026-07-16T10:50:48Z",
  "digest": "sha256:91577bde8b8f10b5364684e4bb33b5a4a10b11c837b1cca876e6908602964c54",
  "downloadCount": 16,
  "id": "RA_kwDOSSHiS84cjfg9",
  "label": "",
  "name": "mark-shot_0.1.41_fedora_x86_64.rpm",
  "size": 1241053,
  "state": "uploaded",
  "updatedAt": "2026-07-16T10:50:48Z",
  "url": "https://github.com/jswysnemc/mark-shot/releases/download/v0.1.41/mark-shot_0.1.41_fedora_x86_64.rpm"
}

下载命令: gh release download --repo "$REPO" "$FILENAME" -O /tmp/gh/"$FILENAME"

返回文件名和版本
"""

import argparse
import json
import os
import subprocess
import sys


def build_jq_filter(filters: list[str], arch_pattern: str) -> str:
    """构建 jq filter：所有 filter 条件 + arch 条件用 and 连接。"""
    conditions = [f'test("{f}"; "i")' for f in filters]
    conditions.append(f'test("{arch_pattern}"; "i")')
    return ".assets[] | select(.name |" + " and ".join(conditions) + ")"


def run_gh_cmd(cmd: list[str]) -> subprocess.CompletedProcess:
    try:
        #print("查询资产: {}".format(' '.join(cmd)))
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError:
        print("错误: 未找到 gh 命令，请先安装 GitHub CLI", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f"错误: gh 命令执行失败: {e}", file=sys.stderr)
        if e.stderr:
            print(e.stderr.strip(), file=sys.stderr)
        sys.exit(1)
    return result


def find_asset(repo: str, filters: list[str], arch_pattern: str) -> dict | None:
    jq_filter = build_jq_filter(filters, arch_pattern)
    cmd = [
        "gh", "release", "view",
        "--repo", repo,
        "--json", "assets",
        "--jq", jq_filter,
    ]
    result = run_gh_cmd(cmd)

    output = result.stdout.strip()
    if not output:
        return None

    # gh 可能返回多行 JSON（每行一个对象），也可能返回单个对象
    return choose_from_results(output)


def choose_from_results(output):
    lines = output.strip().splitlines()
    if not lines:
        print("错误: 没有收到任何结果", file=sys.stderr)
        sys.exit(1)

    items = []
    for idx, line in enumerate(lines, start=1):
        try:
            data = json.loads(line)
            # 根据你的实际数据结构，选择一个有意义的字段展示
            # 这里假设 data 中有 "name" 或 "title" 或 "tag_name"
            display = data.get("name") or data.get("title") or data.get("tag_name") or data.get("id") or f"条目 {idx}"
            items.append((idx, display, data))
        except json.JSONDecodeError:
            print(f"警告: 第 {idx} 行不是有效 JSON，已跳过: {line[:50]}...", file=sys.stderr)
            continue

    if not items:
        print("错误: 没有可解析的有效 JSON 结果", file=sys.stderr)
        sys.exit(1)

    # 只有一条结果，直接返回，不交互
    if len(items) == 1:
        return items[0][2]

    # 多条结果，让用户选择
    print("\n找到以下结果，请选择序号：")
    for idx, display, _ in items:
        print(f"  [{idx}] {display}")

    while True:
        try:
            choice = input("请输入序号 (输入 q 退出): ").strip()
            if choice.lower() == 'q':
                print("已取消", file=sys.stderr)
                sys.exit(0)
            num = int(choice)
            for idx, display, data in items:
                if idx == num:
                    return data
            print(f"无效序号，请输入 1 ~ {len(items)} 之间的数字", file=sys.stderr)
        except ValueError:
            print("请输入有效的数字", file=sys.stderr)
        except KeyboardInterrupt:
            print("\n已取消", file=sys.stderr)
            sys.exit(1)


def download_asset(repo: str, filename: str, download_dir: str) -> str:
    os.makedirs(download_dir, exist_ok=True)
    dest_path = os.path.join(download_dir, filename)
    if os.path.exists(dest_path):
        return dest_path

    cmd = [
        "gh", "release", "download",
        "--repo", repo,
        "--pattern", filename,
        "--dir", download_dir,
        "--clobber",
    ]
    run_gh_cmd(cmd)
    return dest_path


def get_release_tag(repo: str) -> str:
    """获取 latest release 的 tag 名称（如 v0.1.41）。"""
    cmd = [
        "gh", "release", "view",
        "--repo", repo,
        "--json", "tagName",
        "--jq", ".tagName",
    ]
    result = run_gh_cmd(cmd)
    return result.stdout.strip()


def download_release(repo: str, filters: list[str], arch: str, download_dir: str) -> tuple[str, str]:
    """从 GitHub Release 下载匹配的资产。返回 (filename, version)。"""
    print(f"查询 {repo} 的 latest release 匹配资产...", file=sys.stderr)
    asset = find_asset(repo, filters, arch)

    if asset is None:
        print(
            f"未找到匹配 filter '{filters}' 且架构匹配的资产",
            file=sys.stderr,
        )
        sys.exit(1)

    filename = asset["name"]
    print(f"找到资产: {filename}", file=sys.stderr)
    print(f"下载链接: {asset['url']}", file=sys.stderr)

    dest = download_asset(repo, filename, download_dir)
    print(f"下载完成: {dest}", file=sys.stderr)

    # 返回文件名和版本号（标准输出，每行一个）
    tag = get_release_tag(repo)
    return filename, tag


def main():
    parser = argparse.ArgumentParser(description="从 GitHub Release 下载匹配的资产文件")
    parser.add_argument("repo", help="GitHub 仓库, 如 jswysnemc/mark-shot")
    parser.add_argument(
        "--filter", action="append", dest="filters",
        metavar="PATTERN",
        help="Regex filter for asset name. Can be specified multiple times. All filters combined with AND.",
    )
    parser.add_argument(
        "--download-dir", "-O", default="/tmp/gh",
        help="下载目录 (默认: /tmp/gh)",
    )
    parser.add_argument(
        "--arch", default="x86_64|x86-64|amd64",
        help="架构匹配模式 (默认: x86_64|x86-64|amd64)",
    )
    args = parser.parse_args()

    filename, tag = download_release(args.repo, args.filters, args.arch, args.download_dir)
    print(filename)
    print(tag)


if __name__ == "__main__":
    main()