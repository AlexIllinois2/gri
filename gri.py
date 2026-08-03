#!/usr/bin/env python3

"""
ldr.py — Linux Desktop Release Manager

参数:
  list: 打印已安装的repo和版本信息. 数据源: installed.json
  update [repo...]: 不传参: 查询所有可升级repo, 传参: 升级对应repo...

数据源: conf.json -> apps.json

用gh_down.py下载软件包（--filter 可多次传参，匹配资产名）
sudo dnf install 安装rpm
mv <name> ~/.local/bin/<name> 安装appimage
用app_install.py安装tar.gz
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

from gh_down import download_release
from app_install import install_package as app_install_package

# ── 路径常量 ──────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR
CONF_FILE = DATA_DIR / "conf.json"
APPS_FILE = DATA_DIR / "apps.json"
INSTALLED_FILE = DATA_DIR / "installed.json"
BIN_DIR = Path.home() / ".local" / "bin"
DOWNLOAD_DIR = "/tmp/gh"


# ── 工具函数 ──────────────────────────────────────────────────────

def ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)


def repo_to_name(repo: str) -> str:
    """从 repo 提取短名称，如 'astral-sh/uv' → 'uv'"""
    return repo.split("/")[-1] if "/" in repo else repo


def log(msg: str):
    print(f"[+] {msg}", file=sys.stderr)


def warn(msg: str):
    print(f"[!] {msg}", file=sys.stderr)


def err(msg: str):
    print(f"[-] {msg}", file=sys.stderr)


# ── 数据加载 ──────────────────────────────────────────────────────

def load_apps() -> list[dict]:
    """加载 apps.json，返回 app 列表。格式：{"repo": {"suffix": "rpm", ...}, ...}"""
    apps_path = APPS_FILE

    if CONF_FILE.exists():
        with open(CONF_FILE) as f:
            conf = json.load(f)
        custom_path = conf.get("apps_file")
        if custom_path:
            apps_path = Path(custom_path).expanduser().resolve()

    if not apps_path.exists():
        err(f"apps.json not found at {apps_path}")
        sys.exit(1)

    with open(apps_path) as f:
        data = json.load(f)

    if not isinstance(data, dict):
        err("apps.json: expected dict with repo as keys")
        sys.exit(1)

    # 归一化：dict → list，补充 repo，suffix 转 filter 和 type
    result = []
    for key, val in data.items():
        if not isinstance(val, dict):
            continue
        val.setdefault("repo", key)
        item = val

        # 兼容旧版 suffix 字段
        suffix = item.get("suffix")
        if suffix:
            if "type" not in item:
                if "rpm" in suffix:
                    item["type"] = "rpm"
                elif "tar.gz" in suffix:
                    item["type"] = "tar.gz"
                elif "appimage" in suffix.lower() or "AppImage" in suffix:
                    item["type"] = "appimage"
            if "filter" not in item:
                item["filter"] = [item.pop("suffix")]
            else:
                del item["suffix"]

        result.append(item)

    return result


def load_installed() -> dict:
    if not INSTALLED_FILE.exists():
        return {}
    with open(INSTALLED_FILE) as f:
        return json.load(f)


def save_installed(installed: dict):
    ensure_dir(DATA_DIR)
    with open(INSTALLED_FILE, "w") as f:
        json.dump(installed, f, indent=2, ensure_ascii=False)


def get_latest_version(repo: str) -> Optional[str]:
    """查询 latest release 的 tag 名称。"""
    cmd = [
        "gh", "release", "view",
        "--repo", repo,
        "--json", "tagName",
        "--jq", ".tagName",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except FileNotFoundError:
        err("gh CLI not found, please install GitHub CLI")
        sys.exit(1)
    except subprocess.CalledProcessError:
        return None


# ── gh-down.py 封装 ──────────────────────────────────────────────

def run_gh_down(repo: str, filters: list[str], arch: str) -> tuple[str, str]:
    """调用 gh-down.py，返回 (filename, version)。"""
    return download_release(repo, filters, arch, DOWNLOAD_DIR)


# ── 安装方法 ──────────────────────────────────────────────────────

def install_rpm(app: dict):
    """sudo dnf install <rpm_file>"""
    repo = app["repo"]
    name = repo_to_name(repo)
    filters = app.get("filter", [".rpm$"])
    arch = app.get("arch", "x86_64|x86-64|amd64")

    log(f"Downloading {name} ({repo})...")
    filename, version = run_gh_down(repo, filters, arch)
    filepath = os.path.join(DOWNLOAD_DIR, filename)

    log(f"Installing RPM: {filename}")
    try:
        subprocess.run(["sudo", "dnf", "install", "-y", filepath], check=True)
    except subprocess.CalledProcessError as e:
        err(f"dnf install failed: {e}")
        sys.exit(1)

    os.remove(filepath)

    return version


def install_appimage(app: dict):
    """mv <file> ~/.local/bin/<name>"""
    repo = app["repo"]
    name = repo_to_name(repo)
    filters = app.get("filter", [".AppImage$"])
    arch = app.get("arch", "x86_64|x86-64|amd64")

    log(f"Downloading {name} ({repo})...")
    filename, version = run_gh_down(repo, filters, arch)
    src = os.path.join(DOWNLOAD_DIR, filename)

    ensure_dir(BIN_DIR)
    dst = BIN_DIR / name

    os.chmod(src, 0o755)
    os.rename(src, str(dst))
    log(f"Installed AppImage: {src} -> {dst}")

    return version


def install_targz(app: dict):
    """用 app-install.py 安装 tar.gz 包"""
    repo = app["repo"]
    name = repo_to_name(repo)
    filters = app.get("filter", [r"\.tar\.gz$"])
    arch = app.get("arch", "x86_64|x86-64|x64|amd64")

    log(f"Downloading {name} ({repo})...")
    filename, version = run_gh_down(repo, filters, arch)
    filepath = os.path.join(DOWNLOAD_DIR, filename)

    # 收集 bins 参数
    bins = app.get("bins")
    if not bins and "bin" in app:
        bins = [app["bin"]]

    log(f"Installing {name} via app_install.py...")
    app_install_package(
        pkg_path=filepath,
        name=name,
        bins=bins,
        icon=app.get("icon"),
        cicon=app.get("cicon"),
        service=app.get("service"),
        autostart=app.get("autostart", False),
    )

    os.remove(filepath)

    return version


# ── 命令实现 ──────────────────────────────────────────────────────

def cmd_list():
    apps = load_apps()
    installed = load_installed()

    print(f"{'Repo':<30} {'Version':<20} {'Type':<10}")
    print("-" * 60)
    # for app in sorted(apps, key=lambda a: a["repo"]):
    for app in sorted(apps, key=lambda a: (a["repo"] not in installed, a["repo"])):
        repo = app["repo"]
        info = installed.get(repo, {})
        ver = info.get("version", "")
        typ = info.get("type", "")
        print(f"{repo:<30} {ver:<20} {typ:<10}")


def cmd_update(repos: list[str], yes: bool = False):
    apps = load_apps()
    installed = load_installed()

    if repos:
        names = {a.get("repo") for a in apps}
        missing = set(repos) - names
        if missing:
            err(f"Unknown apps: {', '.join(missing)}")
            sys.exit(1)
        apps_to_update = [a for a in apps if a.get("repo") in repos]
    else:
        apps_to_update = apps

    type_handlers = {
        "rpm": install_rpm,
        "appimage": install_appimage,
        "tar.gz": install_targz,
    }

    print('如果您在使用dev-sidecar, 请先执行: `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy` 以确保gh能够正常下载release')
    for app in apps_to_update:
        repo = app["repo"]
        app_type = app.get("type", "rpm")
        current_version = installed.get(repo, {}).get("version")

        log(f"Checking ({repo})...")

        latest_version = get_latest_version(repo)
        if not latest_version:
            warn(f"Failed to get latest version for {repo}, skipping")
            continue

        if current_version == latest_version:
            log(f"{repo} is already up-to-date ({current_version})")
            continue

        log(f"{repo}: {current_version or 'not installed'} -> {latest_version}")

        handler = type_handlers.get(app_type)
        if not handler:
            err(f"Unknown type: {app_type} for {repo}")
            continue

        if not yes:
            try:
                answer = input("Proceed with update? [y/N] ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                answer = "n"
            if answer != "y":
                log(f"Skipping {repo}")
                continue

        handler(app)

        installed[repo] = {
            "version": latest_version,
            "type": app_type,
        }
        save_installed(installed)
        log(f"{repo} updated successfully")


# ── CLI ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Linux Desktop Release Manager — 管理已安装应用的更新"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list", help="打印已安装的 repo 和版本信息")

    update_parser = subparsers.add_parser("update", help="查询/执行升级")
    update_parser.add_argument(
        "repos", nargs="*", metavar="repo",
        help="要升级的 repo 名称（不传则升级全部）",
    )
    update_parser.add_argument(
        "-y", "--yes", action="store_true",
        help="自动确认更新，跳过提示",
    )

    args = parser.parse_args()

    if args.command == "list":
        cmd_list()
    elif args.command == "update":
        cmd_update(args.repos, yes=args.yes)


if __name__ == "__main__":
    main()
