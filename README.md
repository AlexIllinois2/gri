# gri — GitHub Release Installer

Linux 桌面应用发布管理工具。从 GitHub Release 下载并安装软件包，跟踪已安装版本，支持增量更新。

## 依赖

- **GitHub CLI (`gh`)** — 查询 release、下载资产。需先[安装](https://cli.github.com/)并登录。
- **Python 3.8+**
- RPM 安装需要 `sudo dnf install`
- **PATH**: 将`$HOME/.local/bin`添加到`PATH`环境变量中

## 安装方式

gri 支持三种安装类型，通过 `apps.json` 中 `type` 字段指定（兼容旧版 `suffix` 字段自动推断）：

| 类型         | 安装方式                                                               | 适用场景             |
| ---------- | ------------------------------------------------------------------ | ---------------- |
| `rpm`      | `sudo dnf install -y`                                              | Fedora/RHEL 系原生包 |
| `appimage` | 移动到 `~/.local/bin/<name>`                                          | 免安装 AppImage     |
| `tar.gz`   | 解压到 `~/.local/app/<name>/`，自动处理 bin 软链接、desktop 文件、systemd service | 通用压缩包            |

## 配置

### apps.json

定义要跟踪的仓库和匹配规则：

```json
{
    "owner/repo": {
        "type": "rpm",
        "filter": [".rpm$"],
        "arch": "x86_64|x86-64|amd64"
    }
}
```

- `type`: `rpm` / `appimage` / `tar.gz`
- `filter`: 资产名匹配的正则列表（多项取 AND）, 参考jq
- `arch`: 架构匹配正则（默认 `x86_64|x86-64|amd64`）
- `bins`: tar.gz 包内可执行文件路径（相对包内根目录）
- `icon`: desktop 文件图标路径（相对包内根目录）
- `cicon`: 外部图标文件路径（会被复制到应用目录）
- `service`: systemd user service 的执行命令
- `autostart`: 是否开机自启

### conf.json

可选配置，默认路径在 `gri.py` 同目录：

```json
{
    "apps-conf": "apps.json",
    "down-dir": "/tmp/gh",
    "del-after-install": true
}
```

- `apps-conf`: apps.json 的自定义路径
- `down-dir`: 下载目录

## 使用

```bash
# 列出所有已安装应用及版本
python3 gri.py list

# 检查所有应用是否有新版本（交互式确认更新）
python3 gri.py update

# 直接更新指定应用，跳过确认
python3 gri.py update -y owner/repo

# 更新多个应用
python3 gri.py update owner/repo1 owner/repo2
```

更新流程：

1. 查询每个仓库的 latest release tag
2. 与 `installed.json` 记录的版本比较
3. 有更新时下载匹配 filter + arch 的资产文件
4. 按类型执行安装（dnf / mv / 解压 + 配置）
5. 写入 `installed.json`

## 文件结构

```
gri/
├── gri.py          # 主入口 CLI
├── gh_down.py      # GitHub Release 下载模块
├── app_install.py  # tar.gz 应用安装器
├── osinfo.py       # 系统信息工具
├── apps.json       # 应用仓库配置
├── conf.json       # 可选配置
├── installed.json  # 已安装版本记录（自动生成）
└── .gitignore
```

