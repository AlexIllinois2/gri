#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gri — GitHub Release Installer (aria2 edition, 隐式命令版)

gri                        已安装应用 -> 全量检查更新; 没有已安装 -> 安装 apps.json 全部
gri <app|owner/repo>       已安装 -> 更新; 未安装 (含从未 add) -> 安装并自动写入 apps.json
gri list / ls              已安装在前, 未安装在后
gri remove / rm <app|repo>...
gri download / dl <repo>   只下载 latest 收敛出的资产到当前目录, 不安装不记录
gri add <owner/repo>       只写入 apps.json, 不安装
gri update [names] [-y] / gri install <names>   显式形式

# ==== 本地压缩包交互式安装 ====
gri <本地文件路径>            安装本地 tar.gz/tgz/tar.xz/txz/tar.bz2/tar/zip/appimage/rpm
                              交互式布局向导: 选二进制 / 图标 / systemd 服务 / 自启
gri <本地文件> -b bin/foo     指定暴露的二进制 (可多次 -b)
gri <本地文件> --all-bin      暴露包内全部可执行文件
gri <本地文件> -i logo.png    配置图标 (包内相对路径或绝对路径)
gri <本地文件> -s "x --d"     生成 systemd 用户服务
gri <本地文件> -y             跳过交互, 使用默认布局

# ==== debug ====
默认 debug 级输出 (候选资产清单 / 下载链接与路径 / 解压文件列表 / 软链去向)。
GRI_DEBUG=0 gri ... 可临时关闭。
"""

import argparse, json, os, platform, re, shutil, subprocess, sys, tarfile, unicodedata
import urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

HOME = Path.home()
GR_HOME = HOME / ".config" / "gri"
APPS_FILE = GR_HOME / "apps.json"
STATE_FILE = GR_HOME / "installed.json"
CACHE_DIR = HOME / ".cache" / "gri" / "downloads"
DATA_DIR = HOME / ".local" / "share" / "gri"
BIN_DIR = HOME / ".local" / "bin"
DESKTOP_DIR = HOME / ".local" / "share" / "applications"
SYSTEMD_DIR = HOME / ".config" / "systemd" / "user"
AUTOSTART_DIR = HOME / ".config" / "autostart"
API = "https://api.github.com"
MACHINE = platform.machine().lower()

ARCH_TOKENS = {"x86_64": ["x86_64", "amd64", "x64", "linux64"],
               "aarch64": ["aarch64", "arm64", "armv8"]}
OTHER_ARCH = {"x86_64": ["aarch64", "arm64", "armv7", "armhf", "i386", "i686", "386", "arm"],
              "aarch64": ["x86_64", "amd64", "x64", "i386", "i686", "386", "armv7", "armhf"]}

TAR_EXTS = (".tar.gz", ".tgz", ".tar.xz", ".txz", ".tar.bz2", ".tar")
BAD_EXT = (".deb", ".exe", ".msi", ".dmg", ".pkg", ".zip", ".sha256", ".sha512",
           ".sig", ".asc", ".txt", ".json", ".pem", ".yml", ".xml", ".zsync",
           ".so", ".desktop", ".png", ".svg", ".sh", ".bat")
INSTALLABLE_EXTS = TAR_EXTS + (".zip", ".appimage", ".rpm")

SAMPLE_APPS = {
    "ripgrep": {"repo": "BurntSushi/ripgrep", "filter": "x86_64-unknown-linux-musl", "type": "tar.gz", "bins": ["rg"]},
    "fd": {"repo": "sharkdp/fd", "filter": "x86_64-unknown-linux-gnu", "type": "tar.gz", "bins": ["fd"]},
    "bat": {"repo": "sharkdp/bat", "filter": "x86_64-unknown-linux-gnu", "type": "tar.gz", "bins": ["bat"]},
    "lazygit": {"repo": "jesseduffield/lazygit", "filter": "Linux_x86_64", "type": "tar.gz", "bins": ["lazygit"]},
}

STATE = {}

# debug 默认开启; GRI_DEBUG=0 / false / no 关闭
DEBUG = os.environ.get("GRI_DEBUG", "1") not in ("0", "false", "no")


def dbg(msg):
    """debug 级日志: 默认开启, GRI_DEBUG=0 关闭。"""
    if DEBUG:
        print("[debug] %s" % msg)


def report_install(name, app_dir=None, links=(), desktop=None, service=None, extras=()):
    """安装完成后打印: 装到哪里、暴露了哪些命令/文件。"""
    print("[%s] 安装详情:" % name)
    if app_dir:
        print("  安装目录: %s" % app_dir)
    for l in links:
        lp = Path(l)
        try:
            tgt = lp.resolve()
        except OSError:
            tgt = lp
        print("  命令: %s -> %s" % (lp.name, tgt))
    if desktop:
        print("  desktop: %s" % desktop)
    if service:
        print("  systemd 用户服务: %s" % service)
    for e in extras:
        print("  %s" % e)


class GriError(Exception):
    pass


def die(msg):
    raise GriError(msg)

# ---------------------------------------------------------------- GitHub API

def api_get(path):
    req = urllib.request.Request(API + path, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "gri/2.1"})
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            die("GitHub API 限流 (匿名 60 次/小时)。稍后再试, 或 export GITHUB_TOKEN=...")
        if e.code == 404:
            raise FileNotFoundError(path)
        die("GitHub API HTTP %d: %s" % (e.code, e.reason))
    except urllib.error.URLError as e:
        die("网络错误: %s" % e.reason)


def get_latest_release(repo):
    try:
        return api_get("/repos/%s/releases/latest" % repo)
    except FileNotFoundError:
        pass
    try:
        rels = api_get("/repos/%s/releases?per_page=1" % repo)
    except FileNotFoundError:
        die("仓库不存在或无权访问: %s (私有仓库需设置 GITHUB_TOKEN)" % repo)
    if not rels:
        die("%s 没有任何 release" % repo)
    return rels[0]

# ---------------------------------------------------------------- 资产收敛

def asset_type(name):
    n = name.lower()
    if n.endswith(".rpm"):
        return "rpm"
    if n.endswith(".appimage") or "appimage" in n:
        return "appimage"
    if n.endswith(".zip"):
        return "zip"
    if any(n.endswith(e) for e in TAR_EXTS):
        return "tar.gz"
    return None


def auto_pick_asset(release):
    """启发式: 排除非 Linux/垃圾扩展名, 架构匹配加分, 静态链接微加分。"""
    best, best_score = None, -999
    mine = ARCH_TOKENS.get(MACHINE, [])
    theirs = OTHER_ARCH.get(MACHINE, [])
    for a in release.get("assets", []):
        n = a["name"].lower()
        if asset_type(n) is None or n.endswith(BAD_EXT):
            continue
        score = 0
        if any(m in n for m in mine):
            score += 10
        if any(o in n for o in theirs):
            score -= 10
        if "musl" in n or "unknown-linux" in n:
            score += 2
        if score > best_score:
            best, best_score = a, score
    return best


OS_TOKENS = {"linux": ["linux"], "darwin": ["darwin", "macos", "osx", "apple"],
             "windows": ["windows", "win32", "win64", "msvc", "mingw"]}


def _norm(s):
    return s.lower().replace("-", "_")


def cond_match(name, cond):
    """匹配原版 Rust gri 的结构化 filter 条件 (field/op/value)。"""
    if not isinstance(cond, dict):
        return True
    field, op, value = cond.get("field"), cond.get("op", "in"), cond.get("value")
    n = _norm(name)
    vals = [str(v) for v in value] if isinstance(value, list) \
        else ([str(value)] if value is not None else [])
    if field in ("os", "arch", "libc"):
        toks = []
        for v in vals:
            if field == "os":
                toks += OS_TOKENS.get(_norm(v), [_norm(v)])
            else:
                toks.append(_norm(v))
        return any(t in n for t in toks)
    if op in ("eq", "equals"):
        return not vals or n == _norm(vals[0])
    if op == "regex":
        return bool(vals) and re.search(vals[0], name) is not None
    return any(_norm(v) in n for v in vals)


def filter_matches(name, flt):
    """filter 兼容三种写法: 正则字符串 / 单条件对象 / 条件列表 (原版 Rust gri 格式)。"""
    if flt is None:
        return True
    if isinstance(flt, str):
        return re.search(flt, name) is not None
    if isinstance(flt, dict):
        flt = [flt]
    if isinstance(flt, list):
        return all(cond_match(name, c) for c in flt)
    return True


FACETS = [
    ("系统", ("linux", "darwin", "macos", "osx", "windows", "freebsd", "ubuntu"), "os"),
    ("架构", ("x86_64", "x64", "amd64", "aarch64", "arm64", "armv7", "i386"), "arch"),
    ("libc", ("gnu", "musl", "android"), "libc"),
]


def _looks_ver(v):
    return bool(re.search(r"v?\d+[._]\d+|(?<!\w)b\d{3,}(?!\w)|^v?\d+$", str(v)))


def _infer_conds(asset_name):
    n = asset_name.lower()
    conds = []
    t = asset_type(n)
    if t:
        conds.append({"field": "contains", "value": t})
    for label, toks, field in FACETS:
        for tok in toks:
            if tok in n:
                conds.append({"field": field, "op": "in", "value": [tok]})
                break
    return conds


def _confirm(prompt):
    try:
        return input(prompt).strip().lower() in ("y", "yes", "")
    except (EOFError, KeyboardInterrupt):
        return False


def _ask_yn(prompt):
    try:
        return input(prompt).strip().lower() in ("y", "yes")
    except (EOFError, KeyboardInterrupt):
        return False


def interactive_converge(name, release, cfg):
    """多轮收敛: 无论候选多少, 始终提供 后缀/系统/架构/子串/直接选 全部手段。"""
    assets = release.get("assets", [])
    if not assets:
        die("%s latest 没有任何资产" % cfg.get("repo", name))
    cands, conds = list(assets), []
    dbg("候选资产 (%d 个):" % len(cands))
    for a in assets:
        dbg("  %s (%.1f MB)" % (a["name"], a.get("size", 0) / 1e6))
    print("为 %s (%s) 收敛资产, %d 个候选:" % (name, release.get("tag_name", "?"), len(cands)))
    while len(cands) > 1:
        exts = {}
        for a in cands:
            e = a["name"].rsplit(".", 1)[-1].lower()
            exts[e] = exts.get(e, 0) + 1
        menu = []
        if len(exts) > 1:
            menu.append(("后缀: " + " ".join("%s(%d)" % kv for kv in sorted(exts.items(), key=lambda x: -x[1])), ("ext", None)))
        for label, toks, field in FACETS:
            counts = [(t, sum(1 for a in cands if t in a["name"].lower())) for t in toks if any(t in a["name"].lower() for a in cands)]
            if counts and (len(counts) > 1 or counts[0][1] < len(cands)):
                menu.append((label + ": " + " ".join("%s(%d)" % x for x in counts), ("facet", (label, toks, field))))
        menu.append(("包含子串 (手动输入)", ("substr", None)))
        menu.append(("列出剩余候选直接选", ("list", None)))
        listable = len(cands) <= 5
        if listable:
            print("\n剩余 %d 个候选:" % len(cands))
            for i, a in enumerate(cands, 1):
                print(" %d) %s" % (i, a["name"]))
        else:
            print("\n剩余 %d 个候选, 选择收敛方式:" % len(cands))
        base = len(cands) + 1 if listable else 1
        for i, (txt, _) in enumerate(menu, base):
            print(" %d) %s" % (i, txt))
        total = len(cands) + len(menu) if listable else len(menu)
        try:
            c = input("选择 [1-%d] (回车取消): " % total).strip()
        except (EOFError, KeyboardInterrupt):
            die("已取消")
        if not c:
            die("已取消")
        if not c.isdigit():
            print("无效输入, 请输入数字"); continue
        v = int(c)
        if listable and 1 <= v <= len(cands):
            cands = [cands[v - 1]]; continue
        mi = v - len(cands) if listable else v
        if not (1 <= mi <= len(menu)):
            print("无效序号"); continue
        txt, data = menu[mi - 1]
        kind = data[0]
        if kind == "list":
            for i, a in enumerate(cands, 1):
                print(" %d) %s" % (i, a["name"]))
            v2 = input("选择 [1-%d] (回车取消): " % len(cands)).strip()
            if not v2:
                die("已取消")
            if v2.isdigit() and 1 <= int(v2) <= len(cands):
                cands = [cands[int(v2) - 1]]
            else:
                print("无效输入"); continue
        elif kind == "ext":
            ekeys = sorted(exts.items(), key=lambda x: -x[1])
            print(" 后缀选项:")
            for i, (e, cnt) in enumerate(ekeys, 1):
                print(" %d) .%s (%d 个)" % (i, e, cnt))
            v2 = input("选后缀 [1-%d]: " % len(ekeys)).strip()
            if not v2.isdigit() or not (1 <= int(v2) <= len(ekeys)):
                print("无效输入"); continue
            ext = ekeys[int(v2) - 1][0]
            cands = [a for a in cands if a["name"].lower().endswith("." + ext)]
            conds.append({"field": "contains", "value": ext})
            print("-> 后缀 .%s, 剩 %d" % (ext, len(cands)))
        elif kind == "facet":
            label, toks, field = data[1]
            counts = [(t, sum(1 for a in cands if t in a["name"].lower())) for t in toks if any(t in a["name"].lower() for a in cands)]
            print(" %s 选项:" % label)
            for i, (t, cnt) in enumerate(counts, 1):
                print(" %d) %s (%d 个)" % (i, t, cnt))
            v2 = input("选%s [1-%d]: " % (label, len(counts))).strip()
            if not v2.isdigit() or not (1 <= int(v2) <= len(counts)):
                print("无效输入"); continue
            val = counts[int(v2) - 1][0]
            cands = [a for a in cands if val in a["name"].lower()]
            conds.append({"field": field, "op": "in", "value": [val]})
            print("-> %s=%s, 剩 %d" % (label, val, len(cands)))
        elif kind == "substr":
            v2 = input("包含子串: ").strip().lower()
            if not v2:
                print("空值"); continue
            cands = [a for a in cands if v2 in a["name"].lower()]
            conds.append({"field": "contains", "value": v2})
            print("-> 包含 %r, 剩 %d" % (v2, len(cands)))
        dbg("当前条件: %s, 剩余 %d 个候选" % (json.dumps(conds, ensure_ascii=False), len(cands)))
    asset = cands[0]
    print("\n选定: %s" % asset["name"])
    if not _confirm("使用此资产? [Y/n] "):
        die("已取消")
    clean, stripped = [], []
    for c in conds:
        if (c.get("field") == "contains" and isinstance(c.get("value"), str) and _looks_ver(c["value"])):
            stripped.append(c["value"])
        else:
            clean.append(c)
    if stripped:
        print("警告: 条件 %s 疑似版本号, 更新时会失效, 已剥离" % stripped)
    conds = clean
    if not conds:
        inferred = _infer_conds(asset["name"])
        if inferred:
            print("从资产名推导的语义条件: %s" % json.dumps(inferred, ensure_ascii=False))
            if _confirm("保存推导条件 (版本安全, 下次自动匹配)? [Y/n] "):
                conds = inferred
    if conds and _confirm("将以上条件保存到 apps.json 的 filter (下次自动匹配)? [Y/n] "):
        cfg["filter"] = conds
        try:
            apps = json.loads(APPS_FILE.read_text()) if APPS_FILE.exists() else {}
        except Exception:
            apps = {}
        entry = apps.get(name) or {"repo": cfg["repo"]}
        entry.setdefault("repo", cfg["repo"])
        entry["filter"] = conds
        apps[name] = entry
        save_apps(apps)
        print("[%s] filter 已写入 apps.json" % name)
    return asset


def pick_asset(release, cfg, name=None):
    assets = release.get("assets", [])
    pattern = cfg.get("filter")
    if pattern is not None and not isinstance(pattern, bool):
        cands = [a for a in assets if filter_matches(a["name"], pattern)]
        cands.sort(key=lambda a: 0 if asset_type(a["name"]) in ("rpm", "appimage", "tar.gz") else 1)
        arch = cfg.get("arch")
        if arch:
            pref = [a for a in cands if arch in a["name"]]
            cands = pref or cands
        if cands:
            return cands[0]
        if name:
            print("配置的 filter 未命中任何资产, 进入手动收敛:")
            return interactive_converge(name, release, cfg)
        die("没有匹配 filter 的资产。可用:\n  %s" % ("\n  ".join(a["name"] for a in assets) or "(无)"))
    a = auto_pick_asset(release)
    if a:
        return a
    if name:
        print("无法自动识别资产, 进入手动收敛:")
        return interactive_converge(name, release, cfg)
    die("latest 中没有可识别的 Linux 资产。可用:\n  %s" % ("\n  ".join(a["name"] for a in assets) or "(无)"))

# ---------------------------------------------------------------- 本地状态 (apps.json / installed.json)

def load_apps():
    if not APPS_FILE.exists():
        GR_HOME.mkdir(parents=True, exist_ok=True)
        APPS_FILE.write_text(json.dumps(SAMPLE_APPS, indent=2) + "\n")
        print("已生成示例配置 %s, 可按需编辑。" % APPS_FILE)
    try:
        return json.loads(APPS_FILE.read_text())
    except json.JSONDecodeError as e:
        die("apps.json 解析失败: %s" % e)


def save_apps(apps):
    APPS_FILE.parent.mkdir(parents=True, exist_ok=True)
    APPS_FILE.write_text(json.dumps(apps, indent=2, sort_keys=True) + "\n")


def _normkey(s):
    # 归一化: 忽略大小写和 - _ . 便于 "motrixnext" 匹配 "motrix-next"
    return re.sub(r"[-_.]", "", str(s)).lower()


def _choose(cands, token):
    print("找到多个匹配 %r 的应用:" % token)
    for i, (n, cfg) in enumerate(cands, 1):
        inst = (" [已安装 %s]" % STATE[n]["version"]) if n in STATE else ""
        print(" %d) %-26s %s%s" % (i, n, cfg.get("repo", "?"), inst))
    while True:
        try:
            r = input("选择 [1-%d] (回车取消): " % len(cands)).strip()
        except (EOFError, KeyboardInterrupt):
            return None
        if not r:
            return None
        if r.isdigit() and 1 <= int(r) <= len(cands):
            return cands[int(r) - 1]
        print("无效输入, 请输入数字")


def resolve(token, apps):
    # 1. 精确: 应用名 (apps.json 键)
    if token in apps:
        return token, apps[token], False
    # 2. 精确: owner/repo
    if "/" in token:
        repo = token.strip("/")
        name = repo.split("/")[-1]
        if name in apps and apps[name].get("repo") == repo:
            return name, apps[name], False
    # 3. 已安装应用名 (apps.json 里可能已删)
    if token in STATE and STATE[token].get("repo"):
        rec = STATE[token]
        cfg = {k: rec[k] for k in ("repo", "type", "bins", "arch") if rec.get(k)}
        return token, cfg, False
    # 4. 模糊: 忽略大小写/连字符/下划线/点, 应用名或 repo slug 的子串
    t, tn = token.lower(), _normkey(token)
    if len(tn) >= 2:
        cands, seen = [], set()
        for n, cfg in apps.items():
            repo = (cfg.get("repo") or "")
            slug = repo.split("/")[-1]
            if (t in n.lower() or t in repo.lower() or tn in _normkey(n) or tn in _normkey(slug)):
                if n not in seen:
                    seen.add(n); cands.append((n, cfg))
        if len(cands) > 1:
            pick = _choose(cands, token)
            if pick is None:
                die("已取消")
            return pick[0], pick[1], False
        if len(cands) == 1:
            return cands[0][0], cands[0][1], False
    # 5. owner/repo 推测 (从未 add 过, auto_add)
    if "/" in token:
        repo = token.strip("/")
        return repo.split("/")[-1], {"repo": repo, "arch": MACHINE}, True
    die("无法识别 %r: 不是 apps.json 中的应用, 也不是已安装应用或 owner/repo 形式" % token)


def load_state():
    if STATE_FILE.exists():
        try:
            STATE.clear(); STATE.update(json.loads(STATE_FILE.read_text()))
        except json.JSONDecodeError as e:
            die("installed.json 损坏: %s" % e)
    return STATE


def save_state():
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(STATE, indent=2, sort_keys=True) + "\n")


ARIA2 = shutil.which("aria2c")


def download(url, dest, token=None):
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    token = token or GITHUB_TOKEN
    print("下载链接: %s" % url)
    print("保存路径: %s" % dest)
    if ARIA2:
        dbg("下载方式: aria2c (8 连接)")
        cmd = ["aria2c", "-x", "8", "-s", "8", "-k", "1M", "-c", "--file-allocation=none",
               "--console-log-level=warn", "--summary-interval=5", "--retry-wait=2",
               "-m", "3", "--connect-timeout=10", "--auto-file-renaming=false",
               "--allow-overwrite=true", "-d", str(dest.parent), "-o", dest.name, url]
        if token:
            cmd[1:1] = ["--header", "Authorization: Bearer " + token]
        r = subprocess.run(cmd)
        if r.returncode != 0:
            die("下载失败 (aria2c 退出码 %d)" % r.returncode)
        dbg("下载完成: %s (%.1f MB)" % (dest, dest.stat().st_size / 1e6))
        return dest
    print("未找到 aria2c, 使用 urllib 下载")
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=30) as resp, open(tmp, "wb") as f:
        total = getattr(resp, "getheader", lambda h: None)("Content-Length")
        if total:
            print("大小: %.1f MB" % (int(total) / 1048576))
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
    tmp.replace(dest)
    dbg("下载完成: %s (%.1f MB)" % (dest, dest.stat().st_size / 1e6))
    return dest


def tag_version(tag):
    return tag.lstrip("vV")


def ver_key(v):
    return [int(x) for x in re.findall(r"\d+", v)] or [0]


def find_file(root, name):
    cands = [p for p in root.rglob(name) if p.is_file()]
    if not cands:
        return None
    exes = [p for p in cands if os.access(p, os.X_OK)]
    return (exes or cands)[0]


def _looks_like_exec(p):
    """ELF 魔数或 shebang 才算真可执行。zip 内的符号链接会被 Python zipfile 解成内容为链接目标路径的普通文本文件, 不加过滤会被误认为二进制。"""
    try:
        with open(p, "rb") as f:
            head = f.read(4)
    except OSError:
        return False
    return head.startswith(b"\x7fELF") or head.startswith(b"#!")


def detect_bins(app_dir):
    """自动发现二进制: 优先 bin/ 目录下, 其次浅层可执行文件。"""
    found = {}
    for p in app_dir.rglob("*"):
        if not p.is_file():
            continue
        if p.name.lower().endswith(BAD_EXT):
            continue
        rel = p.relative_to(app_dir)
        if p.parent.name == "bin" or (os.access(p, os.X_OK) and len(rel.parts) <= 2):
            if _looks_like_exec(p):
                found.setdefault(p.name, p)
    return sorted(found)[:5]


def safe_extract(tar, dest):
    try:
        tar.extractall(dest, filter="data")
    except TypeError:
        dest = dest.resolve()
        for m in tar.getmembers():
            p = (dest / m.name).resolve()
            if not str(p).startswith(str(dest) + os.sep):
                die("压缩包内存在不安全路径: %s" % m.name)
        tar.extractall(dest)


def flatten_single_dir(dest, depth):
    """对应原版 moveUp: 顶层只有一个目录时逐层下钻 (等价 strip-components)。"""
    dest = Path(dest)
    for _ in range(max(0, depth)):
        entries = sorted(dest.iterdir())
        if len(entries) != 1 or not entries[0].is_dir():
            break
        inner = entries[0]
        for child in inner.iterdir():
            shutil.move(str(child), str(dest / child.name))
        inner.rmdir()


def extract_to(archive, dest, strip=1):
    """解压到 dest; zip 用 zipfile (无需 unzip), tar 优先系统 tar 带 --strip-components。"""
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    arch = str(archive)
    if arch.lower().endswith(".zip"):
        import zipfile
        with zipfile.ZipFile(arch) as z:
            d = dest.resolve()
            for m in z.namelist():
                if not str((dest / m).resolve()).startswith(str(d) + os.sep):
                    die("压缩包内存在不安全路径: %s" % m)
            z.extractall(dest)
        flatten_single_dir(dest, strip)
        return
    tar_cmd = shutil.which("tar")
    if tar_cmd:
        # 先试 strip, 若剥空了 (包顶层本来就是散文件) 回退不剥 —— 修复原版缺陷#5
        for s in ([strip, 0] if strip else [0]):
            for child in dest.iterdir():
                if child.is_dir():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink()
            r = subprocess.run([tar_cmd, "--strip-components", str(s), "-xf", arch, "-C", str(dest)],
                               capture_output=True, text=True)
            if r.returncode == 0 and any(dest.iterdir()):
                break
        else:
            die("tar 解压失败: %s" % ((r.stderr or "").strip()[:300] if r else arch))
    else:
        with tarfile.open(arch, "r:*") as t:
            safe_extract(t, dest)
        flatten_single_dir(dest, strip)
    if not any(dest.iterdir()):
        die("解压后目录为空: %s" % arch)


def find_executables(root):
    """列出包内可执行文件的相对路径 (过滤 .so/.desktop/.service/隐藏文件/垃圾扩展名)。"""
    found = []
    for p in Path(root).rglob("*"):
        if not p.is_file():
            continue
        n = p.name.lower()
        if n.endswith(BAD_EXT) or n.endswith((".desktop", ".service", ".so")):
            continue
        rel = p.relative_to(root)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if os.access(p, os.X_OK):
            found.append(str(rel))
    return sorted(found)


def multi_select(title, items):
    """简单多选: 支持 1,3-5 / a=全部 / 回车=全部 (兜底全选, 与原版一致)。"""
    print("%s (共 %d 个), 输入序号如 1,3-5; a=全部, 回车=全部:" % (title, len(items)))
    for i, it in enumerate(items, 1):
        print(" %2d) %s" % (i, it))
    try:
        r = input("> ").strip()
    except (EOFError, KeyboardInterrupt):
        return list(items)
    if not r or r == "a":
        return list(items)
    chosen = set()
    for part in r.replace("，", ",").split(","):
        part = part.strip()
        if "-" in part:
            try:
                a, b = part.split("-", 1)
                chosen.update(range(int(a), int(b) + 1))
            except ValueError:
                pass
        elif part.isdigit():
            chosen.add(int(part))
    sel = [items[i - 1] for i in sorted(chosen) if 1 <= i <= len(items)]
    return sel or list(items)


def layout_wizard(archive, app, opts):
    """交互式布局向导 (移植原版 layoutWizard): strip -> bins -> icon -> service -> autostart。"""
    layout = {"strip": 1, "bins": [], "icon": None, "service_exec": None, "autostart": False}
    stage = CACHE_DIR / "stage" / app
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    try:
        extract_to(archive, stage, layout["strip"])
        exes = find_executables(stage)
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    # (1) bins 选择: 优先级 --all-bin > -b > 交互多选
    if opts.get("all_bin"):
        layout["bins"] = exes
    elif opts.get("bins"):
        layout["bins"] = list(opts["bins"])
    elif exes:
        print("[%s] 检测到 %d 个可执行文件" % (app, len(exes)))
        layout["bins"] = multi_select("选择要暴露为命令的二进制", exes)
    else:
        print("警告: 未在包内检测到可执行文件")
        layout["bins"] = []

    # (2) icon
    if opts.get("icon"):
        layout["icon"] = opts["icon"]
    elif not opts.get("yes") and _ask_yn("是否配置图标 (用于生成 .desktop)? [y/N] "):
        layout["icon"] = input("包内相对路径 (如 share/icons/logo.png) 或绝对路径: ").strip() or None

    # (3) systemd service
    if opts.get("service"):
        layout["service_exec"] = opts["service"]
    elif not opts.get("yes") and _ask_yn("是否生成 systemd 用户服务? [y/N] "):
        default_cmd = layout["bins"][0] if layout["bins"] else app
        layout["service_exec"] = input("启动命令 (如 %s --foreground): " % default_cmd).strip() or None

    if layout.get("service_exec") and not opts.get("yes"):
        layout["autostart"] = _ask_yn("是否开机自启? [y/N] ")
    return layout


def derive_app_name(filename):
    """对应原版 deriveAppName: 去掉安装包后缀作为应用名/id (修复原版缺陷#1/#3)。"""
    n = filename.lower()
    for ext in sorted(INSTALLABLE_EXTS, key=len, reverse=True):
        if n.endswith(ext):
            return filename[:-len(ext)]
    return filename


def as_local_archive(token):
    """token 是存在的本地安装包则返回绝对路径, 否则 None。"""
    p = Path(os.path.expanduser(token))
    try:
        if not p.is_file():
            return None
    except OSError:
        return None
    # 注意: 必须对全名 endswith (p.suffix 对 .tar.gz 只会给出 .gz)
    if p.name.lower().endswith(INSTALLABLE_EXTS):
        return p.resolve()
    return None

# ---------------------------------------------------------------- 安装实现

def fix_exec(text, bins, bin_dir):
    def repl(m):
        parts = m.group(1).strip().strip('"').split()
        if parts and os.path.basename(parts[0]) in bins and not Path(parts[0]).is_absolute():
            parts[0] = str(bin_dir / os.path.basename(parts[0]))
        return "Exec=" + " ".join(parts)
    return re.sub(r"^Exec=(.*)$", repl, text, flags=re.M)


def install_desktop(name, cfg, app_dir, bin_dir):
    if cfg.get("desktop") is False:
        return None
    bins = cfg.get("bins", [])
    for f in app_dir.rglob("*.desktop"):
        return _write_desktop(name, fix_exec(f.read_text(errors="replace"), bins, bin_dir))
    dc = cfg.get("desktop")
    if isinstance(dc, dict):
        exe = dc.get("exec") or str(bin_dir / (bins[0] if bins else name))
        text = ("[Desktop Entry]\nType=Application\nName=%s\nExec=%s\nIcon=%s\n"
                "Terminal=false\nCategories=%s\n" %
                (dc.get("name", name), exe, dc.get("icon", name), dc.get("categories", "Utility")))
        return _write_desktop(name, text)
    return None


def _write_desktop(name, text):
    DESKTOP_DIR.mkdir(parents=True, exist_ok=True)
    dest = DESKTOP_DIR / ("gri-%s.desktop" % name)
    dest.write_text(text)
    return str(dest)


def install_service(name, cfg):
    svc = cfg.get("service")
    if not svc:
        return None
    SYSTEMD_DIR.mkdir(parents=True, exist_ok=True)
    bins = cfg.get("bins", [])
    exe = svc.get("exec") or str(BIN_DIR / (bins[0] if bins else name))
    text = ("[Unit]\nDescription=%s\n\n[Service]\nExecStart=%s\nRestart=%s\n\n"
            "[Install]\nWantedBy=default.target\n" %
            (svc.get("description", name), exe, svc.get("restart", "on-failure")))
    dest = SYSTEMD_DIR / (name + ".service")
    dest.write_text(text)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    if svc.get("enable", True):
        subprocess.run(["systemctl", "--user", "enable", "--now", dest.name], check=False)
    return str(dest)


def install_tar(name, cfg, tag, asset, archive):
    app_dir = DATA_DIR / name / tag_version(tag)
    if app_dir.exists():
        shutil.rmtree(app_dir)
    app_dir.mkdir(parents=True)
    dbg("[%s] 安装目录: %s" % (name, app_dir))
    if str(archive).lower().endswith(".zip"):
        import zipfile
        with zipfile.ZipFile(archive) as z:
            dest = app_dir.resolve()
            for m in z.namelist():
                p = (app_dir / m).resolve()
                if not str(p).startswith(str(dest) + os.sep):
                    die("压缩包内存在不安全路径: %s" % m)
            z.extractall(app_dir)
        DOCS = {"readme", "license", "changelog", "notice", "authors", "copying", "news", "todo", "install", "thanks"}
        for p in app_dir.rglob("*"):
            if p.is_file() and "." not in p.name and p.name.lower() not in DOCS:
                p.chmod(0o755)
    else:
        with tarfile.open(archive, "r:*") as t:
            safe_extract(t, app_dir)
    files = sorted(str(p.relative_to(app_dir)) for p in app_dir.rglob("*") if p.is_file())
    dbg("[%s] 解压出 %d 个文件:" % (name, len(files)))
    for f in files[:100]:
        dbg("  " + f)
    if len(files) > 100:
        dbg("  ... (共 %d 个, 仅显示前 100)" % len(files))
    bins = cfg.get("bins") or detect_bins(app_dir)
    dbg("[%s] 二进制: %s" % (name, bins))
    if not bins:
        die("[%s] 无法自动确定二进制, 请在 apps.json 的 %r 条目中指定 bins" % (name, name))
    bin_dir = Path(cfg.get("bin_dir", str(BIN_DIR))).expanduser()
    bin_dir.mkdir(parents=True, exist_ok=True)
    links = []
    for b in bins:
        src = find_file(app_dir, b)
        if src is None:
            die("[%s] 解压后未找到二进制 %r" % (name, b))
        if not os.access(src, os.X_OK):
            src.chmod(src.stat().st_mode | 0o111)
        link = bin_dir / b
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(src)
        links.append(str(link))
        dbg("[%s] 软链: %s -> %s" % (name, link, src))
    eff = dict(cfg); eff["bins"] = bins
    desktop = install_desktop(name, eff, app_dir, bin_dir)
    service = install_service(name, eff)
    if (DATA_DIR / name).exists():
        for v in (DATA_DIR / name).iterdir():
            if v.name != tag_version(tag):
                shutil.rmtree(v, ignore_errors=True)
    STATE[name] = {"version": tag_version(tag), "tag": tag, "asset": asset["name"], "type": asset_type(asset["name"]) or "tar.gz", "dir": str(app_dir), "bins": bins, "links": links, "desktops": [desktop] if desktop else [], "services": [service] if service else []}
    report_install(name, app_dir, links, desktop, service)


def install_archive_local(name, tag, asset, archive, layout):
    app_dir = DATA_DIR / name / tag_version(tag)
    if app_dir.exists():
        shutil.rmtree(app_dir)
    app_dir.mkdir(parents=True)
    dbg("[%s] 本地安装目录: %s" % (name, app_dir))
    dbg("[%s] 布局: %s" % (name, json.dumps(layout, ensure_ascii=False)))
    extract_to(archive, app_dir, layout.get("strip", 1))
    DOCS = {"readme", "license", "changelog", "notice", "authors", "copying", "news", "todo", "install", "thanks"}
    for p in app_dir.rglob("*"):
        if p.is_file() and "." not in p.name and p.name.lower() not in DOCS:
            p.chmod(0o755)
    files = sorted(str(p.relative_to(app_dir)) for p in app_dir.rglob("*") if p.is_file())
    dbg("[%s] 解压出 %d 个文件:" % (name, len(files)))
    for f in files[:100]:
        dbg("  " + f)
    if len(files) > 100:
        dbg("  ... (共 %d 个, 仅显示前 100)" % len(files))
    bin_dir = BIN_DIR
    bin_dir.mkdir(parents=True, exist_ok=True)
    links = []
    for rel in layout.get("bins", []):
        cand = app_dir / rel
        src = cand if cand.is_file() else find_file(app_dir, Path(rel).name)
        if src is None:
            die("[%s] 未找到二进制 %r" % (name, rel))
        src = src.resolve()
        if not os.access(src, os.X_OK):
            src.chmod(src.stat().st_mode | 0o111)
        link = bin_dir / Path(rel).name
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(src)
        links.append(str(link))
        dbg("[%s] 软链: %s -> %s" % (name, link, src))
    # icon: 复制到 <installDir>/share/icons/
    icon_dst = None
    if layout.get("icon"):
        ic = Path(os.path.expanduser(layout["icon"]))
        cand = ic if ic.is_absolute() else app_dir / layout["icon"]
        if cand.exists():
            icons = app_dir / "share" / "icons"
            icons.mkdir(parents=True, exist_ok=True)
            icon_dst = icons / (name + cand.suffix)
            shutil.copy2(cand, icon_dst)
            dbg("[%s] 图标: %s -> %s" % (name, cand, icon_dst))
        else:
            print("警告: 图标 %r 不存在, 跳过" % layout["icon"])
    # desktop: 有 icon 或 service 才生成 (对齐原版 wantDesktop 逻辑)
    desktop = None
    if icon_dst or layout.get("service_exec"):
        exec_path = links[0] if links else str(bin_dir / name)
        text = ("[Desktop Entry]\nType=Application\nName=%s\nExec=%s\nPath=%s\n"
                "Terminal=false\n" % (name, exec_path, app_dir))
        if icon_dst:
            text += "Icon=%s\n" % icon_dst
        desktop = _write_desktop(name, text)
        dbg("[%s] desktop: %s" % (name, desktop))
    # systemd user service
    service = None
    if layout.get("service_exec"):
        SYSTEMD_DIR.mkdir(parents=True, exist_ok=True)
        unit = SYSTEMD_DIR / (name + ".service")
        unit.write_text("[Unit]\nDescription=%s\n\n[Service]\nExecStart=%s\n"
                        "WorkingDirectory=%s\nRestart=on-failure\n\n[Install]\n"
                        "WantedBy=default.target\n" % (name, layout["service_exec"], app_dir))
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
        subprocess.run(["systemctl", "--user", "enable", "--now", unit.name], check=False)
        service = str(unit)
        dbg("[%s] systemd 服务: %s (ExecStart=%s)" % (name, service, layout["service_exec"]))
    # autostart: desktop 软链到 ~/.config/autostart/
    if layout.get("autostart") and desktop:
        AUTOSTART_DIR.mkdir(parents=True, exist_ok=True)
        lp = AUTOSTART_DIR / (name + ".desktop")
        if lp.is_symlink() or lp.exists():
            lp.unlink()
        lp.symlink_to(desktop)
        dbg("[%s] 自启: %s -> %s" % (name, lp, desktop))
    STATE[name] = {"version": tag_version(tag), "tag": tag, "asset": asset["name"], "type": asset_type(asset["name"]), "dir": str(app_dir), "bins": [Path(l).name for l in links], "links": links, "desktops": [desktop] if desktop else [], "services": [service] if service else [], "source": "local"}
    extras = []
    if icon_dst:
        extras.append("图标: %s" % icon_dst)
    report_install(name, app_dir, links, desktop, service, extras)


def install_rpm(name, cfg, tag, asset, archive):
    pkg = asset["name"]
    r = subprocess.run(["rpm", "-qp", "--qf", "%{NAME}", "--nosignature", str(archive)],
                       capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        pkg = r.stdout.strip()
    dbg("[%s] rpm 包名: %s" % (name, pkg))
    print("[%s] 使用 dnf 安装: %s" % (name, archive))
    if subprocess.run(["sudo", "dnf", "install", "-y", str(archive)]).returncode != 0:
        die("[%s] dnf 安装失败" % name)
    STATE[name] = {"version": tag_version(tag), "tag": tag, "asset": asset["name"], "type": "rpm", "pkg": pkg}
    print("[%s] rpm 已通过 dnf 安装 (包名: %s), 可用 rpm -q %s 查询" % (name, pkg, pkg))


def install_appimage(name, cfg, tag, asset, archive):
    bin_dir = Path(cfg.get("bin_dir", str(BIN_DIR))).expanduser()
    bin_dir.mkdir(parents=True, exist_ok=True)
    bins = cfg.get("bins") or [name]
    dest = bin_dir / bins[0]
    dbg("[%s] 复制 AppImage: %s -> %s" % (name, archive, dest))
    shutil.copy2(archive, dest)
    dest.chmod(0o755)
    desktop = install_desktop(name, dict(cfg, bins=bins), dest.parent, bin_dir)
    STATE[name] = {"version": tag_version(tag), "tag": tag, "asset": asset["name"], "type": "appimage", "bins": bins, "dir": str(dest), "links": [str(dest)], "desktops": [desktop] if desktop else [], "services": []}
    report_install(name, None, [str(dest)], desktop, None,
                   extras=["AppImage: %s (%.1f MB)" % (dest, dest.stat().st_size / 1e6)])


def save_local_app(name, t, layout):
    """本地安装规则写入 apps.json (无 repo / 无含版本号的 filter —— 修复原版缺陷#2)。
    重装同名文件时自动复用 layout, 不再重复询问。"""
    entry = {"type": t}
    if layout:
        entry["layout"] = layout
    try:
        apps = json.loads(APPS_FILE.read_text()) if APPS_FILE.exists() else {}
    except Exception:
        apps = {}
    apps[name] = entry
    save_apps(apps)
    print("[%s] 本地安装规则已写入 apps.json (重装时自动复用布局)" % name)


def _remove_state_entry(name):
    """清理单个已安装记录 (软链/desktop/service/目录), 供 remove 与覆盖重装复用。"""
    rec = STATE.get(name)
    if rec is None:
        return
    if rec["type"] == "rpm":
        if subprocess.run(["sudo", "dnf", "remove", "-y", rec.get("pkg", name)]).returncode != 0:
            print("[%s] dnf 卸载失败, 仅清除 gri 记录" % name)
    else:
        for l in rec.get("links", []):
            p = Path(l)
            if p.is_symlink() or p.is_file():
                p.unlink()
        for d in rec.get("desktops", []):
            Path(d).unlink(missing_ok=True)
        if rec.get("services"):
            for s in rec.get("services", []):
                subprocess.run(["systemctl", "--user", "disable", "--now", Path(s).name], check=False)
                Path(s).unlink(missing_ok=True)
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    shutil.rmtree(DATA_DIR / name, ignore_errors=True)
    STATE.pop(name, None)


def install_local(path, opts):
    """本地压缩包/zip/appimage/rpm 交互式安装入口。"""
    path = Path(path)
    name = path.name
    t = asset_type(name)
    if t is None:
        die("不支持的本地安装包类型: %s (支持: %s)" % (name, " ".join(INSTALLABLE_EXTS)))
    app = derive_app_name(name)
    if app in STATE:
        if not _ask_yn("[%s] 已安装 %s, 覆盖重装? [y/N] " % (app, STATE[app].get("version", "?"))):
            print("已取消")
            return
        _remove_state_entry(app)  # 先清旧软链/desktop/service, 避免残留
    asset = {"name": name, "browser_download_url": str(path), "size": path.stat().st_size}
    if t == "rpm":
        install_rpm(app, {"repo": None, "type": "rpm"}, "local", asset, path)
        save_local_app(app, "rpm", None)
    elif t == "appimage":
        install_appimage(app, {"repo": None, "type": "appimage"}, "local", asset, path)
        save_local_app(app, "appimage", None)
    else:
        # apps.json 已固化 layout -> 直接复用, 不再询问 (对齐原版 rule.layout 复用)
        layout = None
        try:
            rule = json.loads(APPS_FILE.read_text()).get(app) if APPS_FILE.exists() else None
        except Exception:
            rule = None
        if rule and isinstance(rule.get("layout"), dict):
            layout = rule["layout"]
            print("[%s] 复用已保存的布局: bins=%s" % (app, layout.get("bins")))
        else:
            layout = layout_wizard(path, app, opts)
        install_archive_local(app, "local", asset, path, layout)
        save_local_app(app, t, layout)
    if app in STATE:
        STATE[app]["source"] = "local"
    save_state()
    print("[%s] 本地安装完成: %s" % (app, name))


def save_auto_app(name, cfg):
    rec = STATE.get(name, {})
    entry = {"repo": cfg["repo"]}
    if rec.get("type") and rec["type"] != "tar.gz":
        entry["type"] = rec["type"]
    if cfg.get("arch"):
        entry["arch"] = cfg["arch"]
    if rec.get("bins"):
        entry["bins"] = rec["bins"]
    if cfg.get("filter"):
        entry["filter"] = cfg["filter"]
    apps = json.loads(APPS_FILE.read_text()) if APPS_FILE.exists() else {}
    apps[name] = entry
    save_apps(apps)
    print("[%s] 已写入 apps.json, 之后 gri / gri %s 会自动跟踪更新" % (name, name))


def install_app(name, cfg, release=None, auto_add=False):
    release = release or get_latest_release(cfg["repo"])
    tag = release["tag_name"]
    asset = pick_asset(release, cfg, name)
    print("[%s] %s -> %s (%.1f MB)" % (name, tag, asset["name"], asset.get("size", 0) / 1e6))
    dest = CACHE_DIR / ("%s-%s" % (name, asset["name"]))
    download(asset["browser_download_url"], dest)
    t = cfg.get("type") or asset_type(asset["name"]) or "tar.gz"
    if t == "rpm":
        install_rpm(name, cfg, tag, asset, dest)
    elif t == "appimage":
        install_appimage(name, cfg, tag, asset, dest)
    else:
        install_tar(name, cfg, tag, asset, dest)
    STATE[name].update({"repo": cfg["repo"], "arch": cfg.get("arch"),
                        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
    save_state()
    if auto_add:
        save_auto_app(name, cfg)
    print("[%s] 安装完成: %s" % (name, tag_version(tag)))

# ---------------------------------------------------------------- 子命令

def update_one(name, cfg):
    if not cfg.get("repo"):
        print("[%s] 本地安装, 无 repo 可检查更新, 跳过" % name)  # [local-install] 防护
        return
    rel = get_latest_release(cfg["repo"])
    new, cur = rel["tag_name"], STATE.get(name, {}).get("tag")
    if cur == new:
        print("[%s] 已是最新 %s" % (name, new)); return
    if cur and ver_key(new) < ver_key(cur):
        print("[%s] 远端 %s 低于本地 %s, 跳过" % (name, new, cur)); return
    install_app(name, cfg, release=rel)


def confirm(prompt):
    try:
        return input(prompt).strip().lower() in ("y", "yes")
    except (EOFError, KeyboardInterrupt):
        return False


def cmd_run(args):
    opts = vars(args)
    apps = load_apps()
    for token in args.tokens:
        # [local-install] 本地安装包路径优先拦截
        local = as_local_archive(token)
        if local:
            install_local(local, opts)
            continue
        name, cfg, auto = resolve(token, apps)
        if name in STATE:
            update_one(name, cfg)
        else:
            install_app(name, cfg, auto_add=auto)
        apps = json.loads(APPS_FILE.read_text()) if APPS_FILE.exists() else {}


def cmd_default(_args):
    apps = load_apps()
    if STATE:
        print("已安装 %d 个应用, 检查更新..." % len(STATE))
        cmd_update(argparse.Namespace(names=[], yes=False))
        return
    # [local-install] 无 repo 的本地规则无法从远端安装, 跳过并提示
    remote = {n: c for n, c in apps.items() if c.get("repo")}
    for n in apps:
        if n not in remote:
            print("  跳过 %s: 本地安装规则, 无 repo (gri <本地文件路径> 重装)" % n)
    if not remote:
        if apps:
            return
        die("apps.json 为空, 用 gri add <owner/repo> 添加应用")
    print("没有已安装应用, 将安装 apps.json 中的 %d 个:" % len(remote))
    for n in sorted(remote):
        print("  %-16s %s" % (n, remote[n].get("repo", "?")))
    if not confirm("继续? [y/N] "):
        print("已取消。"); return
    for n in sorted(remote):
        install_app(n, remote[n])


def cmd_install(args):
    opts = vars(args)
    apps = load_apps()
    for token in args.names:
        # [local-install] 本地安装包路径优先拦截
        local = as_local_archive(token)
        if local:
            install_local(local, opts)
            continue
        name, cfg, auto = resolve(token, apps)
        install_app(name, cfg, auto_add=auto)
        apps = json.loads(APPS_FILE.read_text()) if APPS_FILE.exists() else {}


def cmd_update(args):
    apps = load_apps()
    if args.names:
        targets = [resolve(t, apps)[:2] for t in args.names]
    else:
        targets = []
        for n in STATE:
            cfg = apps.get(n)
            if cfg is None:
                rec = STATE[n]
                cfg = {k: rec[k] for k in ("repo", "type", "bins", "arch") if rec.get(k)}
            # [local-install] 本地安装无 repo, 跳过
            if not cfg.get("repo"):
                print("  跳过 %s: 本地安装, 无 repo 可检查更新" % n)
                continue
            targets.append((n, cfg))
    if not targets:
        die("没有已安装的应用 (gri <owner/repo> 直接安装)")
    print("检查 %d 个已安装应用的更新..." % len(targets))
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(get_latest_release, cfg["repo"]): n for n, cfg in targets}
        releases = {futs[f]: f.result() for f in futs}
    updates = []
    for name, rel in releases.items():
        new, cur = rel["tag_name"], STATE.get(name, {}).get("tag")
        if cur == new:
            continue
        if cur and ver_key(new) < ver_key(cur):
            print("  跳过 %s: 远端 %s 低于本地 %s" % (name, new, cur)); continue
        updates.append((name, rel))
    if not updates:
        print("全部已是最新。"); return
    print("\n可更新 %d 个:" % len(updates))
    for name, rel in updates:
        print("  %-16s %s -> %s" % (name, STATE.get(name, {}).get("tag", "(未安装)"), rel["tag_name"]))
    if not args.yes and not confirm("是否继续? [y/N] "):
        print("已取消。"); return
    for name, rel in updates:
        cfg = dict(apps.get(name) or {k: STATE[name][k] for k in ("repo", "type", "bins", "arch") if STATE[name].get(k)})
        install_app(name, cfg, release=rel)


def cmd_remove(args):
    for token in args.names:
        name = token if token in STATE else token.strip("/").split("/")[-1]
        if STATE.get(name) is None:
            die("未安装应用: %s (gri list 查看)" % token)
        _remove_state_entry(name)  # [local-install] 抽出的公共清理函数
        # remove 同时清理 apps.json: 本地规则直接清, repo 规则交互确认
        try:
            apps = json.loads(APPS_FILE.read_text()) if APPS_FILE.exists() else {}
        except Exception:
            apps = {}
        if name in apps:
            if not apps[name].get("repo") or _ask_yn(
                    "同时从 apps.json 移除 %s 的跟踪规则? [y/N] " % name):
                del apps[name]
                save_apps(apps)
                print("[%s] 已从 apps.json 移除" % name)
        save_state()
        print("[%s] 已卸载" % name)


def _dw(s):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in str(s))


def _pad(s, width):
    return str(s) + " " * (width - _dw(s))


def _cols(rows):
    if not rows:
        return []
    return [max(_dw(r[i]) for r in rows) + 1 for i in range(len(rows[0]))]


def _table(rows):
    ws = _cols(rows)
    return [" " + "".join(_pad(c, ws[i]) if i < len(ws) - 1 else str(c) for i, c in enumerate(r)) for r in rows]


def _config_file():
    try:
        return APPS_FILE.parent / "config.json"
    except NameError:
        return Path.home() / ".config" / "gri" / "config.json"


def _mask(t):
    return t[:4] + "..." + t[-4:] if t and len(t) >= 12 else "***"


def token_load():
    env = os.environ.get("GITHUB_TOKEN")
    if env:
        return env, "GITHUB_TOKEN 环境变量"
    cf = _config_file()
    if cf.exists():
        try:
            c = json.loads(cf.read_text())
            if c.get("token"):
                return c["token"], "config.json"
        except Exception:
            pass
    return None, None


def token_save(t):
    cf = _config_file()
    c = {}
    if cf.exists():
        try:
            c = json.loads(cf.read_text())
        except Exception:
            c = {}
    c["token"] = t
    cf.write_text(json.dumps(c, indent=2))
    cf.chmod(0o600)


def cmd_token(args):
    if args.clear:
        if os.environ.get("GITHUB_TOKEN"):
            print("注意: GITHUB_TOKEN 环境变量仍在生效, 优先级高于 config.json")
        cf = _config_file()
        changed = False
        if cf.exists():
            try:
                c = json.loads(cf.read_text())
                if "token" in c:
                    del c["token"]
                    cf.write_text(json.dumps(c, indent=2))
                    changed = True
            except Exception:
                pass
        print("已清除 config.json 中的 token" if changed else "config.json 中没有 token")
        return
    val = args.value
    if val is None:
        t, src_ = token_load()
        if not t:
            print("未设置 token (匿名访问, API 限流 60 次/小时)")
            print("设置: gri token <token> 或 export GITHUB_TOKEN=<token>")
        else:
            print("token 已设置 (%s): %s" % (src_, _mask(t)))
            print("下载与 API 请求均携带此 token")
        return
    val = val.strip()
    if len(val) < 20:
        print("警告: token 长度 %d 偏短 (GitHub PAT 通常 40+ 字符), 仍已保存" % len(val))
    token_save(val)
    print("token 已保存到 %s (权限 600)" % _config_file())
    if os.environ.get("GITHUB_TOKEN") and os.environ.get("GITHUB_TOKEN") != val:
        print("注意: GITHUB_TOKEN 环境变量与刚设置的值不同, 环境变量优先级更高")


def _token_cli():
    if len(sys.argv) > 1 and sys.argv[1] == "token":
        args = argparse.Namespace(value=None, clear=False)
        rest = sys.argv[2:]
        if rest and rest[0] == "--clear":
            args.clear = True
        elif rest:
            args.value = rest[0]
        cmd_token(args)
        sys.exit(0)


GITHUB_TOKEN = token_load()[0]  # env 优先, 其次 config.json


def cmd_list(_a):
    apps = load_apps()
    items = []
    for n in STATE:
        rec = STATE[n]
        items.append((rec.get("repo") or apps.get(n, {}).get("repo") or n, rec, True))
    for n in sorted(apps):
        if n in STATE:
            continue
        items.append((apps[n].get("repo") or n, None, False))
    items.sort(key=lambda it: (not it[2], it[0].lower()))
    if not items:
        print("没有应用。用 gri add <owner/repo> 或 gri <owner/repo> 安装。"); return

    TYPE_LABEL = {"tar.gz": "archive", "zip": "archive", "appimage": "appimage", "rpm": "rpm"}

    def _mtime(p):
        try:
            return datetime.fromtimestamp(Path(p).stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        except OSError:
            return "-"

    rows = [("REPO/ID", "VERSION", "TYPE", "UPDATED", "SOURCE", "STATUS")]
    for repo, rec, inst in items:
        if inst:
            # [local-install] SOURCE 列区分 local / repo
            src = "local" if rec.get("source") == "local" else ("repo" if rec.get("repo") else "-")
            rows.append((repo, rec.get("version") or "-",
                         TYPE_LABEL.get(rec.get("type"), rec.get("type") or "-"),
                         rec.get("updated_at") or _mtime(rec.get("dir", "")),
                         src, "已安装"))
        else:
            rows.append((repo, "-", "-", "-", "-", "未安装"))
    ws = _cols(rows)

    def _line(r):
        return " " + "".join(_pad(c, ws[i]) if i < len(ws) - 1 else str(c) for i, c in enumerate(r))

    head = _line(rows[0])
    print(head)
    print(" " + "-" * _dw(head))
    for r in rows[1:]:
        print(_line(r))


def cmd_download(args):
    apps = load_apps()
    for token in args.names:
        name, cfg, _ = resolve(token, apps)
        rel = get_latest_release(cfg["repo"])
        asset = pick_asset(rel, cfg, name)
        print("[%s] %s -> %s (%.1f MB)" % (name, rel["tag_name"], asset["name"], asset.get("size", 0) / 1e6))
        download(asset["browser_download_url"], Path.cwd() / asset["name"])
        print("已下载到 %s" % (Path.cwd() / asset["name"]))


def cmd_add(args):
    apps = load_apps()
    for token in args.names:
        name, cfg, auto = resolve(token, apps)
        if not auto:
            print("[%s] 已存在于 apps.json, 跳过" % name); continue
        rel = get_latest_release(cfg["repo"])
        asset = pick_asset(rel, cfg, name)
        cfg["type"] = asset_type(asset["name"]) or "tar.gz"
        apps[name] = cfg
        print("[%s] %s -> %s (type=%s), 写入 apps.json (未安装)" % (name, rel["tag_name"], asset["name"], cfg["type"]))
        save_apps(apps)


def cmd_info(args):
    apps = load_apps()
    for name in args.names:
        n, cfg, _ = resolve(name, apps)
        print("== %s ==" % n)
        print("配置:", json.dumps(cfg, indent=2, ensure_ascii=False))
        print("状态:", json.dumps(STATE.get(n, "(未安装)"), indent=2, ensure_ascii=False))

# ---------------------------------------------------------------- 入口

ALIASES = {"rm": "remove", "ls": "list", "dl": "download", "up": "update"}
KNOWN = {"install", "update", "remove", "list", "download", "add", "info"}


def _add_local_opts(sp):
    """[local-install] 本地压缩包交互式安装的公共参数。"""
    sp.add_argument("-b", "--bin", dest="bins", action="append",
                    help="要暴露的二进制 (包内相对路径或文件名, 可多次)")
    sp.add_argument("--all-bin", dest="all_bin", action="store_true",
                    help="暴露包内全部可执行文件")
    sp.add_argument("-i", "--icon", help="图标路径 (包内相对路径或绝对路径)")
    sp.add_argument("-s", "--service", help="生成 systemd 用户服务, 值为启动命令")
    sp.add_argument("-y", "--yes", action="store_true", help="跳过交互, 使用默认布局")


def main():
    global DEBUG
    if "--debug" in sys.argv:
        DEBUG = True
    argv = [a for a in sys.argv[1:] if a != "--debug"]
    if argv:
        argv[0] = ALIASES.get(argv[0], argv[0])
    if not argv:
        argv = ["__default__"]
    elif argv[0] not in KNOWN:
        argv = ["__run__"] + argv
    p = argparse.ArgumentParser(prog="gri", description="GitHub Release Installer (aria2 edition)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("__default__").set_defaults(func=cmd_default)
    s = sub.add_parser("__run__"); s.add_argument("tokens", nargs="+")
    _add_local_opts(s)  # [local-install]
    s.set_defaults(func=cmd_run)
    s = sub.add_parser("install"); s.add_argument("names", nargs="+")
    _add_local_opts(s)  # [local-install]
    s.set_defaults(func=cmd_install)
    s = sub.add_parser("update"); s.add_argument("names", nargs="*")
    s.add_argument("-y", "--yes", action="store_true"); s.set_defaults(func=cmd_update)
    s = sub.add_parser("remove"); s.add_argument("names", nargs="+"); s.set_defaults(func=cmd_remove)
    sub.add_parser("list").set_defaults(func=cmd_list)
    s = sub.add_parser("download"); s.add_argument("names", nargs="+"); s.set_defaults(func=cmd_download)
    s = sub.add_parser("add"); s.add_argument("names", nargs="+"); s.set_defaults(func=cmd_add)
    s = sub.add_parser("info"); s.add_argument("names", nargs="+"); s.set_defaults(func=cmd_info)
    load_state()
    args = p.parse_args(argv)
    try:
        args.func(args)
    except GriError as e:
        print("gri: 错误: %s" % e, file=sys.stderr); sys.exit(1)
    except KeyboardInterrupt:
        print("\n已中断。"); sys.exit(130)


if __name__ == "__main__":
    _token_cli()
    main()
