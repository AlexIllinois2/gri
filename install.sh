#!/usr/bin/env bash
# GRI 安装脚本：下载并安装到 ~/.local/bin/gri
set -e

REPO="your-org/gri-ts"   # 发布时替换为实际仓库
INSTALL_DIR="${HOME}/.local/bin"
BIN="${INSTALL_DIR}/gri"

mkdir -p "${INSTALL_DIR}"

# 优先尝试本地构建产物，否则提示用 bun 直接运行
if [ -f "./dist/gri" ]; then
  cp ./dist/gri "${BIN}"
  chmod +x "${BIN}"
  echo "已安装到 ${BIN}"
else
  echo "未找到预编译产物，请先执行 'bun run build:cli' 或直接使用 'bun run src/index.ts'。"
  echo "也可通过 bun 全局链接： bun link  (在仓库目录执行)"
fi

# 确保 ~/.local/bin 在 PATH 中（gri 的应用命令软链汇入处）
case ":${PATH}:" in
  *":${HOME}/.local/bin:"*) ;;
  *) echo "提示：将 ${HOME}/.local/bin 加入 PATH 以使用安装的应用命令。" ;;
esac
