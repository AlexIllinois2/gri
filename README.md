# GRI · GitHub Release 应用管理器 (TypeScript / Bun)

结合 [dra](https://github.com/devmatteini/dra) 的 **Release 资产模式匹配** 与 [gri](https://github.com/AlexIllinois2/gri) 的 **Linux 桌面软件生命周期管理**，用 **Bun + TypeScript** 重写的新一代 GitHub Release 应用管理器。

## 功能特性

- **多源下载**：原生 `fetch`（带 token）、`aria2c` 多线程、以及 `gh` CLI 兜底；下载前统一打印可点击的下载链接。
- **智能资产匹配**：移植 dra 的 OS/Arch/Libc/扩展名 自动收敛逻辑，并对交互筛选做「提交一次、验证一次」的收敛。
- **包管理器自动优先**：Fedora/RHEL 优先 `.rpm`、Debian/Ubuntu 优先 `.deb`、否则归档/AppImage。
- **多类型安装器**：压缩包（`tar.gz` / `tgz` / `zip` / `tar.xz` / `tar.bz2`，统一为 `archive` 类型）、`AppImage`、`rpm`、`deb`、纯二进制 `exe/raw`；自动软链到 `~/.local/bin`、生成 `.desktop`、systemd 用户服务与开机自启。
- **规则与状态分离**：`~/.config/gri/apps.json` 保存「怎么装」（type / filter / layout），`~/.local/share/gri/installed.json` 只记「装了什么、装在哪」；`update` 按 id 取回规则，跨版本复用同一套筛选与布局。

## 快速开始

```bash
bun install
bun run dev install junegunn/fzf          # 交互式安装
bun run dev list                          # 列出已装
bun run dev update -y                     # 批量升级
bun run dev token <your_pat>              # 配置 GitHub Token
```

> `bun run dev` 等价于 `bun run src/index.ts`。

## 子命令

| 命令 | 说明 |
|---|---|
| `list [--json]` | 列出已安装应用 |
| `install <owner/repo\|本地文件> [--select …] [-b/--bin …] [--all-bin] [-i/--icon] [-s/--service] [-p] [-y]` | 安装（强制交互收敛到唯一资产） |
| `down <owner/repo> [--select …] [--tag …] [-o …]` | 仅下载一个资产：不写入 apps.json / installed.json，不解压不安装；最终路径打印到 stdout（便于管道） |
| `update [repo…] [-y]` | 升级；`-y` 静默批量，缺失平台包末尾汇总 |
| `remove <repo> [-y]` | 移除并清理软链/服务/目录（rpm/deb 触发包管理器卸载） |
| `token [<token>]` | 查看或设置 PAT（权限 600） |

## 数据目录（遵循 XDG Base Directory）

```
$XDG_CONFIG_HOME/gri/   默认 ~/.config/gri
  config.json           全局配置
  apps.json             安装规则：type / filter / layout（每个应用的唯一真源）
  token                 GitHub PAT（chmod 600）

$XDG_CACHE_HOME/gri/    默认 ~/.cache/gri
  下载缓存与解压暂存（可安全删除）

$XDG_DATA_HOME/gri/     默认 ~/.local/share/gri
  installed.json        安装台账：版本、资产、bin、安装目录

~/.local/bin/           所有 app 二进制软链汇入处
~/.local/app/<name>/<ver>/  各应用安装根目录
```

设置 `$GRI_HOME` 可把上述三类目录统一收敛到该目录下（`config/`、`cache/`、`data/`），便于测试与便携部署。

## 开发

```bash
bun test            # 单元测试
bun run typecheck   # 类型检查
bun run build       # 编译 CLI 到 dist/
```

## 架构

```
src/
  core/        github-client · asset-selector(dra) · osinfo · version-compare · untag · pipeline
  downloaders/ native · aria2 · gh-cli
  installers/  base · archive · appimage · rpm · deb · exe
  state/       config · apps · installed  (XDG 三目录)
  ui/          @clack 交互封装
  commands/    list · install · down · update · remove · token
```
