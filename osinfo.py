#!/usr/bin/env python3

import platform
import sys

def get_system_info():
    info = {}

    # 1. OS 大类：linux / darwin(mac) / windows
    sys_plat = sys.platform
    if sys_plat.startswith("linux"):
        info["os"] = "linux"
    elif sys_plat == "darwin":
        info["os"] = "macos"
    elif sys_plat == "win32":
        info["os"] = "windows"
    else:
        info["os"] = sys_plat

    # 2. CPU 架构: x86_64 / aarch64 / armv7 ...
    info["platform"] = platform.machine()

    # 3. 发行版名称（Linux专用，如 fedora、ubuntu、debian；其他系统填自身系统名）
    if info["os"] == "linux":
        try:
            # 获取 Linux 发行版
            dist = platform.linux_distribution()
            distro_name = dist[0].strip().lower()
            if distro_name:
                info["distro"] = distro_name
            else:
                info["distro"] = "unknown"
        except:
            # python3.7+ linux_distribution 被移除，改用读取 /etc/os-release
            try:
                with open("/etc/os-release", "r") as f:
                    lines = f.readlines()
                    for line in lines:
                        if line.startswith("ID="):
                            distro_id = line.split("=")[1].strip().strip('"').lower()
                            info["distro"] = distro_id
                            break
                    else:
                        info["distro"] = "unknown"
            except:
                info["distro"] = "unknown"
    else:
        # mac / windows 没有Linux发行版概念
        info["distro"] = info["os"]

    return info


if __name__ == "__main__":
    sys_info = get_system_info()
    # 格式化打印
    print(f"platform: {sys_info['platform']}, os: {sys_info['os']}, distro: {sys_info['distro']}")
    # 也可以打印字典方便程序调用
    # print(sys_info)
