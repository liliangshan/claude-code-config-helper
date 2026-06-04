#!/usr/bin/env python3
"""抓取并检索 VS Code 更新日志（release notes）。

用途：拉取若干个 VS Code 版本的 release notes 页面，把 HTML 转成纯文本，
按关键字（默认聚焦“在编辑区打开网页 / Simple Browser / webview / chat / browser”）
过滤出相关章节并打印出来，便于在本机绕过网络限制查看。

数据源：
  https://code.visualstudio.com/updates/v1_<minor>   （官方 release notes）
  https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_<minor>.md
    （GitHub 上 markdown 原文，作为镜像兜底）

只依赖标准库，无需 pip 安装。
"""

from __future__ import annotations

import argparse
import html
import re
import sys
import urllib.error
import urllib.request

# 候选数据源：按顺序尝试，第一个成功的即采用。{minor} 会被替换为次版本号。
SOURCES = (
    "https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_{minor}.md",
    "https://code.visualstudio.com/updates/v1_{minor}",
)

# 默认检索关键字：聚焦“在编辑区打开网页 / 内嵌浏览器 / webview / chat”。
DEFAULT_KEYWORDS = (
    "simple browser",
    "simplebrowser",
    "open url",
    "open in editor",
    "webview",
    "browser",
    "preview",
    "iframe",
    "chat",
    "embedded",
    "openExternal",
)

USER_AGENT = "Mozilla/5.0 (vscode-release-notes-fetcher)"


def fetch(url: str, timeout: float) -> str | None:
    """抓取单个 URL 的文本，失败返回 None（仅记录到 stderr，不抛出）。"""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            charset = resp.headers.get_content_charset() or "utf-8"
            return resp.read().decode(charset, errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as err:
        print(f"  [warn] 抓取失败 {url} -> {err}", file=sys.stderr)
        return None


def fetch_version(minor: int, timeout: float) -> tuple[str, str] | None:
    """依次尝试候选数据源，返回 (来源 URL, 文本)；全部失败返回 None。"""
    for template in SOURCES:
        url = template.format(minor=minor)
        text = fetch(url, timeout)
        if text:
            return url, text
    return None


_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)
_WS_RE = re.compile(r"[ \t]+")
_BLANK_RE = re.compile(r"\n{3,}")


def html_to_text(raw: str) -> str:
    """把 HTML 粗略转成纯文本：去脚本/样式、去标签、反转义实体、压缩空白。"""
    raw = _SCRIPT_STYLE_RE.sub("", raw)
    # 块级标签转换行，保留段落边界。
    raw = re.sub(r"</(p|div|li|h[1-6]|tr|section)>", "\n", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<br\s*/?>", "\n", raw, flags=re.IGNORECASE)
    raw = _TAG_RE.sub("", raw)
    raw = html.unescape(raw)
    raw = _WS_RE.sub(" ", raw)
    raw = _BLANK_RE.sub("\n\n", raw)
    return raw.strip()


def to_text(source_url: str, raw: str) -> str:
    """markdown 源直接返回；HTML 源转纯文本。"""
    return raw if source_url.endswith(".md") else html_to_text(raw)


def search(text: str, keywords: list[str], context: int) -> list[str]:
    """按关键字逐行检索，命中行连同上下若干行作为片段返回（去重）。"""
    lines = text.splitlines()
    lowered = [line.lower() for line in lines]
    needles = [kw.lower() for kw in keywords]
    hit_indices = [
        i for i, line in enumerate(lowered) if any(needle in line for needle in needles)
    ]
    if not hit_indices:
        return []

    # 合并相邻命中行的上下文窗口，避免重复打印。
    snippets: list[str] = []
    covered: set[int] = set()
    for idx in hit_indices:
        start = max(0, idx - context)
        end = min(len(lines), idx + context + 1)
        window = range(start, end)
        if all(i in covered for i in window):
            continue
        covered.update(window)
        block = "\n".join(lines[start:end]).strip()
        if block:
            snippets.append(block)
    return snippets


def run(minors: list[int], keywords: list[str], context: int, timeout: float) -> int:
    """主流程：逐版本抓取、检索、打印。返回命中的版本数。"""
    matched_versions = 0
    for minor in minors:
        version = f"1.{minor}"
        print("=" * 72)
        print(f"VS Code {version}")
        print("=" * 72)
        fetched = fetch_version(minor, timeout)
        if not fetched:
            print(f"  (无法获取 {version} 的 release notes，已跳过)\n")
            continue
        source_url, raw = fetched
        text = to_text(source_url, raw)
        snippets = search(text, keywords, context)
        print(f"  来源: {source_url}")
        if not snippets:
            print(f"  未命中关键字: {', '.join(keywords)}\n")
            continue
        matched_versions += 1
        print(f"  命中 {len(snippets)} 处:\n")
        for n, snippet in enumerate(snippets, 1):
            print(f"  --- 片段 {n} ---")
            for line in snippet.splitlines():
                print(f"    {line}")
            print()
    return matched_versions


def parse_args(argv: list[str]) -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(
        description="抓取并检索 VS Code 更新日志中“在编辑区打开网页 / webview / chat”相关条目。"
    )
    parser.add_argument(
        "--from", dest="from_minor", type=int, default=95,
        help="起始次版本号（含），默认 95（即 1.95）。"
    )
    parser.add_argument(
        "--to", dest="to_minor", type=int, default=105,
        help="结束次版本号（含），默认 105（即 1.105）。"
    )
    parser.add_argument(
        "--minors", type=str, default="",
        help="逗号分隔的指定次版本号列表，如 '99,100,122'；给出时覆盖 --from/--to。"
    )
    parser.add_argument(
        "--keywords", type=str, default="",
        help="逗号分隔的检索关键字；留空使用内置默认关键字。"
    )
    parser.add_argument(
        "--context", type=int, default=2,
        help="每个命中行上下保留的行数，默认 2。"
    )
    parser.add_argument(
        "--timeout", type=float, default=15.0,
        help="单次 HTTP 请求超时秒数，默认 15。"
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    """入口：组织版本列表与关键字，调用 run。"""
    args = parse_args(argv)
    if args.minors.strip():
        minors = [int(x) for x in args.minors.split(",") if x.strip()]
    else:
        minors = list(range(args.from_minor, args.to_minor + 1))
    keywords = (
        [k.strip() for k in args.keywords.split(",") if k.strip()]
        if args.keywords.strip()
        else list(DEFAULT_KEYWORDS)
    )
    matched = run(minors, keywords, args.context, args.timeout)
    print("=" * 72)
    print(f"完成：共扫描 {len(minors)} 个版本，{matched} 个版本命中关键字。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
