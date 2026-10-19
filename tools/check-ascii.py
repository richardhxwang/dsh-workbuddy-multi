#!/usr/bin/env python3
"""守护「代码位置不得出现非 ASCII」这条纪律。

背景：编辑器/模型在生成长字符串替换时，偶尔会把 ASCII 标点写成外形相近的
非 ASCII 字符（例如把 `?.` 写坏成 `?.`、把 `(` 写坏成 `(`）。这类损坏
**语法检查抓不到** —— 坏字符若是合法标识符字符，`node --check` 照样通过，
运行时才炸或静默走错分支。

用法：
    python3 tools/check-ascii.py lib/*.js           # 只检查，非零退出表示有问题
    python3 tools/check-ascii.py --fix lib/*.js     # 先把已知 mojibake 规范化回 ASCII，再检查

判定方式：先剥掉注释与字符串字面量（含模板串），再看剩下的「代码」里还有没有
码点 > 127 的字符。中文注释与中文报错文案因此不会误报。
"""

from __future__ import annotations

import re
import sys

# 已知的 mojibake 序列 -> 正确的 ASCII。只在剥注释/字符串之前做替换，
# 目标是修「代码位置」的坏字符，所以不碰注释与字符串内部。
PRAGMA = "ascii-guard: allow"

# 这个工具只做「JS 词法级」掩码，不认识 JSX 文本节点（`<span>Don't</span>` 里的
# 撇号会被当成字符串开头，之后整段错位）。lib/client.js 是 2000 行 JSX，跑它会
# 得到必然的假阳性，所以按文件名豁免并显式说明，而不是把噪音混进真信号里。
EXEMPT = {"lib/client.js"}


FIXES: list[tuple[str, str]] = [
    (r"logger[^\w\s]{1,3}\?\.info\?\.\(", "logger?.info?.("),
    (r"logger[^\w\s]{1,3}\?\.warn\?\.\(", "logger?.warn?.("),
    (r"logger[^\w\s]{1,3}\?\.error\?\.\(", "logger?.error?.("),
    (r"logger[^\w\s]{1,3}\?\.debug\?\.\(", "logger?.debug?.("),
    (r"keepalive[^\w\s]{0,3}\.stop\(\)", "keepalive.stop()"),
    (r"keepalive[^\w\s]{0,3}\.start\(\)", "keepalive.start()"),
    (r"fetchImpl[^\w\s]{0,3}:\s*fetchFn", "fetchImpl: fetchFn"),
    (r"now[^\w\s]{0,3}:\s*nowFn", "now: nowFn"),
]


REGEX_PREV = set("(,=:[!&|?{};+-*%~^<>")
REGEX_WORDS = ("return", "typeof", "case", "in", "of", "delete", "void", "do", "else", "yield", "await", "instanceof", "new")


def _regex_allowed(masked_so_far: str) -> bool:
    """JS 里 `/` 是正则还是除号，靠前一个有效字符/关键字判断。"""
    tail = masked_so_far.rstrip()
    if tail == "":
        return True
    last = tail[-1]
    if last in REGEX_PREV:
        return True
    m = re.search(r"([A-Za-z_$][\w$]*)$", tail)
    return bool(m) and m.group(1) in REGEX_WORDS


def _skip_regex(text: str, start: int) -> int:
    """返回正则字面量结束后的下标（含 flags）；不合法就返回 start。"""
    i = start + 1
    n = len(text)
    in_class = False
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "\n":
            return start
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        elif c == "/" and not in_class:
            i += 1
            while i < n and text[i].isalpha():
                i += 1
            return i
        i += 1
    return start


def _blank(text: str, start: int, end: int) -> str:
    """把 text[start:end] 抹成等量空白；换行原样保留，行号因此不漂移。"""
    return "".join("\n" if c == "\n" else " " for c in text[start:end])


def strip_comments_and_strings(text: str) -> str:
    """按 JS 词法抹掉注释/字符串/模板串，只留下真正的代码字符。

    模板串要处理 `` ` ${ expr } ` ``：表达式里是真代码，必须继续扫描；
    而嵌套模板串与花括号要靠「模式栈 + 深度计数」才不会提前收尾。
    （早期版本直接找下一个反引号收尾，于是 `${a ? ` 中文 ` : ''}` 里的中文
    被误判成代码位置 —— 这里修掉。）
    """
    out: list[str] = []
    modes: list[str] = ["code"]  # code | str | tpl
    depths: list[int] = []       # 与模板串一一对应：当前 ${} 的花括号深度
    i = 0
    n = len(text)

    while i < n:
        ch = text[i]

        if modes[-1] == "code":
            if ch == "/" and i + 1 < n and text[i + 1] == "/":
                j = text.find("\n", i)
                j = n if j < 0 else j
                out.append(_blank(text, i, j))
                i = j
                continue
            if ch == "/" and i + 1 < n and text[i + 1] == "*":
                j = text.find("*/", i + 2)
                j = n if j < 0 else j + 2
                out.append(_blank(text, i, j))
                i = j
                continue
            if depths:
                if ch == "{":
                    depths[-1] += 1
                elif ch == "}":
                    if depths[-1] == 0:
                        depths.pop()
                        modes.pop()
                        out.append(" ")
                        i += 1
                        continue
                    depths[-1] -= 1
            if ch == "/" and _regex_allowed("".join(out)):
                j = _skip_regex(text, i)
                if j != i:
                    out.append(_blank(text, i, j))
                    i = j
                    continue
            if ch in "\"'`":
                modes.append("tpl" if ch == "`" else "str")
                if ch == "`":
                    depths.append(0)
                out.append(" ")
                i += 1
                continue
            out.append(ch)
            i += 1
            continue

        if modes[-1] == "str":
            if ch == "\\":
                out.append(_blank(text, i, min(i + 2, n)))
                i += 2
                continue
            if ch in "\"'":
                modes.pop()
                out.append(" ")
                i += 1
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue

        # modes[-1] == "tpl"
        if ch == "\\":
            out.append(_blank(text, i, min(i + 2, n)))
            i += 2
            continue
        if ch == "`":
            modes.pop()
            if depths:
                depths.pop()
            out.append(" ")
            i += 1
            continue
        if ch == "$" and i + 1 < n and text[i + 1] == "{":
            modes.append("code")
            depths.append(0)
            out.append("  ")
            i += 2
            continue
        out.append("\n" if ch == "\n" else " ")
        i += 1

    return "".join(out)


def scan(path: str) -> list[tuple[int, str]]:
    with open(path, encoding="utf-8") as fh:
        original = fh.read()
    code_lines = strip_comments_and_strings(original).splitlines()
    source_lines = original.splitlines()
    bad: list[tuple[int, str]] = []
    for line_no, line in enumerate(code_lines, 1):
        source = source_lines[line_no - 1] if line_no <= len(source_lines) else ""
        if PRAGMA in source:
            continue
        if any(ord(c) > 127 for c in line):
            bad.append((line_no, line.strip()))
    return bad


def apply_fixes(path: str) -> list[str]:
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    changed: list[str] = []
    for pattern, replacement in FIXES:
        new_text, count = re.subn(pattern, replacement, text)
        if count and new_text != text:
            changed.append(f"{path}: {pattern} x{count} -> {replacement}")
            text = new_text
    if changed:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    return changed


def main(argv: list[str]) -> int:
    fix = "--fix" in argv
    paths = [a for a in argv[1:] if a != "--fix"]
    if not paths:
        print(__doc__)
        return 2

    if fix:
        for path in paths:
            for line in apply_fixes(path):
                print(f"[fix] {line}")

    failed = False
    for path in paths:
        if path in EXEMPT:
            print(f"[skip] {path}: JSX 文件，本工具的词法掩码不适用")
            continue
        try:
            bad = scan(path)
        except OSError as exc:
            print(f"[unreadable] {path}: {exc}")
            failed = True
            continue
        if bad:
            failed = True
            print(f"[FAIL] {path}: 代码位置出现 {len(bad)} 行非 ASCII")
            for line_no, line in bad[:20]:
                print(f"    {line_no}: {line}")
        else:
            print(f"[ok] {path}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
