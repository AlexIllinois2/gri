#!/usr/bin/env python3
"""
app-installer.py — 通用应用安装器

将 tar.gz 应用包安装到 ~/.local/app/<app_name>/，
自动生成 .desktop、.service 文件并创建相关软链接。
"""

import argparse
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import List, Optional

# ── 第一阶段：路径常量 ──────────────────────────────────────────────

HOME = Path.home()
APP_ROOT = HOME / ".local" / "app"
BIN_DIR = HOME / ".local" / "bin"
DESKTOP_DIR = HOME / ".local" / "share" / "applications"
SYSTEMD_DIR = HOME / ".config" / "systemd" / "user"
AUTOSTART_DIR = HOME / ".config" / "autostart"


# ── 工具函数 ────────────────────────────────────────────────────────

def log_step(msg: str):
    print(f"[+] {msg}")


def log_warn(msg: str):
    print(f"[!] {msg}")


def log_error(msg: str):
    print(f"[-] {msg}")


def ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)


def derive_name(pkg_path: str) -> str:
    """从包文件名推导应用名：取 '-' 分隔的第一个字符串"""
    basename = Path(pkg_path).name
    name = basename.split("-")[0]
    return name


# ── 第一阶段：CLI 参数解析 ─────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install a tar.gz application package into ~/.local/app/"
    )
    parser.add_argument("--pkg", required=True, help="Path to tar.gz package")
    parser.add_argument("--bin", required=True, help="Relative path of the executable inside the package (e.g. bin/myapp)")
    parser.add_argument("--icon", default=None, help="Relative path of the icon inside the package")
    parser.add_argument("--cicon", default=None, help="Path to an external icon file (copied into app dir)")
    parser.add_argument("--name", default=None, help="Application name (default: derived from package filename)")
    parser.add_argument("--service", action="store_true", help="Generate a systemd user service")
    parser.add_argument("--autostart", action="store_true", help="Enable autostart via .desktop symlink")
    return parser.parse_args()


# ── 第二阶段：解压逻辑 ──────────────────────────────────────────────

def get_common_prefix(members: List[tarfile.TarInfo]) -> Optional[str]:
    """检测所有文件是否共享同一个顶层目录，如果是则返回该目录名。"""
    prefixes = set()
    for m in members:
        if m.name.startswith("/"):
            return None
        parts = m.name.split("/", 1)
        if len(parts) > 1:
            prefixes.add(parts[0])
        else:
            prefixes.add(parts[0])
    return prefixes.pop() if len(prefixes) == 1 else None


def extract_package(pkg_path: Path, target_dir: Path):
    """解压 tar.gz 包，自动剥离顶层共用目录。"""
    log_step(f"Extracting package: {pkg_path}")
    with tarfile.open(pkg_path, "r:gz") as tar:
        members = tar.getmembers()
        prefix = get_common_prefix(members)

        if prefix:
            log_step(f"Detected common top-level directory '{prefix}', stripping it")
            for m in members:
                parts = m.name.split("/", 1)
                if len(parts) > 1:
                    m.name = parts[1]
                else:
                    m.name = os.path.basename(m.name)
                tar.extract(m, path=target_dir)
        else:
            log_step("No common top-level directory, extracting as-is")
            tar.extractall(path=target_dir)


# ── 第三阶段：激活逻辑 ──────────────────────────────────────────────

def generate_desktop(app_dir: Path, app_name: str, bin_rel_path: str,
                     icon_rel_path: Optional[str], cicon_path: Optional[str],
                     autostart: bool) -> Path:
    """生成 .desktop 文件，返回文件路径。"""
    desktop_path = app_dir / f"{app_name}.desktop"
    exec_path = app_dir / bin_rel_path
    icon_path: Optional[Path] = None

    if cicon_path:
        icons_dir = app_dir / "share" / "icons"
        ensure_dir(icons_dir)
        ext = Path(cicon_path).suffix
        icon_name = f"{app_name}{ext}"
        icon_path = icons_dir / icon_name
        shutil.copy2(cicon_path, icon_path)
        log_step(f"Copied external icon: {cicon_path} -> {icon_path}")
    elif icon_rel_path:
        icon_path = app_dir / icon_rel_path

    log_step(f"Generating desktop file: {desktop_path}")
    lines = [
        "[Desktop Entry]",
        "Type=Application",
        f"Name={app_name}",
        f"Exec={exec_path}",
        f"Path={app_dir}",
        "Terminal=false",
    ]
    if icon_path and icon_path.exists():
        lines.append(f"Icon={icon_path}")

    desktop_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    desktop_path.chmod(0o755)
    return desktop_path


def generate_service(app_dir: Path, app_name: str, bin_rel_path: str) -> Path:
    """生成 systemd user service 文件，返回文件路径。"""
    service_path = app_dir / f"{app_name}.service"
    exec_path = app_dir / bin_rel_path

    log_step(f"Generating service file: {service_path}")
    content = f"""[Unit]
Description={app_name}

[Service]
ExecStart={exec_path}
WorkingDirectory={app_dir}
Restart=on-failure

[Install]
WantedBy=default.target
"""
    service_path.write_text(content, encoding="utf-8")
    service_path.chmod(0o644)
    return service_path


def create_symlink(source: Path, target: Path, description: str) -> bool:
    """创建软链接 target -> source，处理冲突。"""
    if target.is_symlink() or target.exists():
        resolved = target.resolve()
        if resolved == source:
            log_warn(f"{description} already points to the correct target, skipping")
            return True
        else:
            log_error(f"Conflict: {target} already exists and points to {resolved}")
            log_error(f"         expected: {source}")
            return False
    ensure_dir(target.parent)
    os.symlink(source, target)
    log_step(f"Created symlink: {target} -> {source}")
    return True


def enable_service(app_name: str):
    """启用并重载 systemd user service。"""
    try:
        log_step("Reloading systemd daemon...")
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, capture_output=True)
        log_step(f"Enabling service: {app_name}.service")
        subprocess.run(["systemctl", "--user", "enable", f"{app_name}.service"],
                       check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        log_warn(f"systemctl command failed (non-fatal): {e.stderr.decode().strip()}")


def write_uninstall_script(app_dir: Path, app_name: str, symlink_paths: List[Path],
                           has_service: bool):
    """在 app 目录内生成 uninstall.sh。"""
    uninstall_path = app_dir / "uninstall.sh"
    log_step(f"Writing uninstall script: {uninstall_path}")

    lines = ["#!/usr/bin/env bash", "set -e", ""]

    if has_service:
        lines.append(f'echo "[+] Stopping and disabling service: {app_name}.service"')
        lines.append(f"systemctl --user stop {app_name}.service 2>/dev/null || true")
        lines.append(f"systemctl --user disable {app_name}.service 2>/dev/null || true")
        lines.append("systemctl --user daemon-reload 2>/dev/null || true")
        lines.append("")

    lines.append(f'echo "[+] Removing symlinks..."')
    for link in symlink_paths:
        lines.append(f'rm -f "{link}"')
    lines.append("")

    lines.append(f'echo "[+] Removing app directory: {app_dir}"')
    lines.append(f'rm -rf "{app_dir}"')
    lines.append("")

    lines.append('echo "[+] Uninstallation completed successfully."')

    uninstall_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    uninstall_path.chmod(0o755)


# ── 主流程 ──────────────────────────────────────────────────────────

def main():
    args = parse_args()

    # ── 名称推导 ──
    app_name = args.name if args.name else derive_name(args.pkg)
    log_step(f"Application name: {app_name}")

    pkg_path = Path(args.pkg).resolve()
    if not pkg_path.exists():
        log_error(f"Package not found: {pkg_path}")
        sys.exit(1)

    # ── 路径准备 ──
    app_dir = APP_ROOT / app_name
    bin_rel = args.bin

    log_step(f"App directory: {app_dir}")

    # ── 第二阶段：创建目录并解压 ──
    if app_dir.exists():
        log_warn(f"App directory already exists: {app_dir}")
        answer = input("Overwrite? [y/N] ").strip().lower()
        if answer != "y":
            log_step("Installation cancelled.")
            sys.exit(0)
        shutil.rmtree(app_dir)

    ensure_dir(app_dir)

    try:
        extract_package(pkg_path, app_dir)
    except (tarfile.TarError, PermissionError) as e:
        log_error(f"Failed to extract package: {e}")
        shutil.rmtree(app_dir, ignore_errors=True)
        sys.exit(1)

    bin_path = app_dir / bin_rel
    if not bin_path.exists():
        log_error(f"Binary not found at expected path: {bin_path}")
        shutil.rmtree(app_dir, ignore_errors=True)
        sys.exit(1)

    # ── 第三阶段：配置生成 ──

    # 3a. 生成 .desktop 文件
    desktop_path = generate_desktop(
        app_dir=app_dir,
        app_name=app_name,
        bin_rel_path=bin_rel,
        icon_rel_path=args.icon,
        cicon_path=args.cicon,
        autostart=args.autostart,
    )

    # 3b. 生成 .service 文件
    service_path: Optional[Path] = None
    if args.service:
        service_path = generate_service(app_dir, app_name, bin_rel)

    # 3c. 创建基础目录
    for d in [BIN_DIR, DESKTOP_DIR, SYSTEMD_DIR, AUTOSTART_DIR]:
        ensure_dir(d)

    # 3d. 创建软链接
    symlink_targets: List[Path] = []
    success = True

    # bin 软链接
    bin_link = BIN_DIR / app_name
    symlink_targets.append(bin_link)
    if not create_symlink(bin_path, bin_link, f"bin symlink {bin_link}"):
        success = False

    # desktop 软链接
    desktop_link = DESKTOP_DIR / f"{app_name}.desktop"
    symlink_targets.append(desktop_link)
    if not create_symlink(desktop_path, desktop_link, f"desktop symlink {desktop_link}"):
        success = False

    # service 软链接
    if service_path:
        service_link = SYSTEMD_DIR / f"{app_name}.service"
        symlink_targets.append(service_link)
        if not create_symlink(service_path, service_link, f"service symlink {service_link}"):
            success = False

    # autostart 软链接
    if args.autostart:
        autostart_link = AUTOSTART_DIR / f"{app_name}.desktop"
        symlink_targets.append(autostart_link)
        if not create_symlink(desktop_path, autostart_link, f"autostart symlink {autostart_link}"):
            success = False

    if not success:
        log_error("Installation failed due to conflicts. Run uninstall.sh to clean up.")
        sys.exit(1)

    # 3e. 启用 service
    if service_path:
        enable_service(app_name)

    # 3f. 生成卸载脚本
    write_uninstall_script(app_dir, app_name, symlink_targets, has_service=bool(service_path))

    log_step(f"Installation completed successfully!")
    log_step(f"  App directory: {app_dir}")
    log_step(f"  Uninstall:     {app_dir / 'uninstall.sh'}")
    log_step(f"  Binary:        {bin_link}")
    log_step(f"  Desktop:       {desktop_link}")
    if args.service:
        log_step(f"  Service:       {SYSTEMD_DIR / f'{app_name}.service'}")
        log_step("  Run: systemctl --user start {}.service".format(app_name))
    if args.autostart:
        log_step(f"  Autostart:     {AUTOSTART_DIR / f'{app_name}.desktop'}")


if __name__ == "__main__":
    main()