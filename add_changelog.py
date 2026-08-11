#!/usr/bin/env python3
# 安全追加一条版本记录到 public/changelog.json 与 CHANGELOG.md。
#
# 用法：
#   python add_changelog.py --version 0.2.0.21 --date 2026-07-25 \
#       --item "第一条说明" --item "第二条说明" [--bump-package] [--dry-run]
#
# 版本号已存在时 = 追加模式：新说明并入该版本（重复文案自动跳过），
# 日期沿用原记录。无论新建还是追加，条目都会按「新增 → 优化 → 修复」重新排序。
#
# 目的：避免手工编辑 JSON 时弄坏结构。读写后都会重新解析校验，
# 写坏立即报错且不落盘（先写临时文件再原子替换）。
import argparse
import json
import re
import sys
import tempfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CHANGELOG_JSON = ROOT / 'public' / 'changelog.json'
CHANGELOG_MD = ROOT / 'CHANGELOG.md'
PACKAGE_JSON = ROOT / 'package.json'


def _atomic_write(path, text):
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(text, encoding='utf-8')
    tmp.replace(path)


# 条目分类排序：新增 → 优化 → 修复；无标签/其他标签归入「优化」档
_LABEL_ORDER = {'新增': 0, '优化': 1, '修复': 2}


def _sort_items(items: list) -> list:
    def rank(it: str) -> int:
        for label, order in _LABEL_ORDER.items():
            if it.startswith(label + '：') or it.startswith(label + ':'):
                return order
        return 1
    return sorted(items, key=rank)  # sorted 稳定，同档保持原顺序


def main():
    ap = argparse.ArgumentParser(description='安全追加版本记录')
    ap.add_argument('--version', required=True, help='如 0.2.0.21')
    ap.add_argument('--date', default=date.today().isoformat())
    ap.add_argument('--item', action='append', default=[], help='可重复：每条说明')
    ap.add_argument('--bump-package', action='store_true',
                    help='同时把 package.json 的 version/appVersion 改成此版本')
    ap.add_argument('--dry-run', action='store_true', help='只打印结果不写文件')
    args = ap.parse_args()

    if not args.item:
        sys.exit('至少需要一条 --item 说明')
    invalid_items = [item for item in args.item if not re.match(r'^(新增|优化|修复)：.+$', item.strip())]
    if invalid_items:
        sys.exit('每条版本说明必须以“新增：”“优化：”或“修复：”开头，并使用“新增 → 优化 → 修复”的分类顺序')

    # --- changelog.json ---
    data = json.loads(CHANGELOG_JSON.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        sys.exit('changelog.json 根节点不是数组')
    existing = next((e for e in data if e.get('version') == args.version), None)
    if existing is not None:
        # 追加模式：并入已有版本，去重后重新排序（日期沿用原记录）
        old_items = list(existing.get('items') or [])
        added = [it for it in args.item if it not in old_items]
        if not added:
            print(f'版本 {args.version} 已包含这些说明，无需重复添加')
            return
        merged = _sort_items(old_items + added)
        existing['items'] = merged
        new_data = data
        entry_date = existing.get('date') or args.date
    else:
        merged = _sort_items(args.item)
        added = merged
        entry_date = args.date
        new_data = [{'date': entry_date, 'version': args.version, 'items': merged}] + data
    json_text = json.dumps(new_data, ensure_ascii=False, indent=2) + '\n'
    json.loads(json_text)  # 写前再校验

    # --- CHANGELOG.md ---
    md = CHANGELOG_MD.read_text(encoding='utf-8')
    lines = md.splitlines(keepends=True)
    heading = f'## {entry_date} · {args.version}'
    hidx = next((i for i, ln in enumerate(lines) if ln.strip() == heading), None)
    if hidx is not None:
        # 已有同版本段落：整段条目重写为合并排序后的结果
        end = hidx + 1
        while end < len(lines) and lines[end].lstrip().startswith('- '):
            end += 1
        block = heading + '\n' + '\n'.join(f'- {it}' for it in merged) + '\n'
        new_md = ''.join(lines[:hidx]) + block + ''.join(lines[end:])
    else:
        idx = 0
        for i, ln in enumerate(lines):
            if ln.strip().startswith('# Changelog'):
                idx = i + 1
                break
        block = (
            '\n'
            + heading + '\n'
            + '\n'.join(f'- {it}' for it in merged) + '\n'
        )
        new_md = ''.join(lines[:idx]) + block + ''.join(lines[idx:])

    if args.dry_run:
        print('=== changelog.json 将是 ===')
        print(json_text)
        print('=== CHANGELOG.md 将插入 ===')
        print(block)
        return

    _atomic_write(CHANGELOG_JSON, json_text)
    _atomic_write(CHANGELOG_MD, new_md)

    if args.bump_package:
        pkg = json.loads(PACKAGE_JSON.read_text(encoding='utf-8'))
        pkg['version'] = args.version
        pkg['appVersion'] = args.version
        _atomic_write(PACKAGE_JSON, json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')

    if existing is not None:
        print(f'已向版本 {args.version} 追加 {len(added)} 条说明（该版本现共 {len(merged)} 条）')
    else:
        print(f'已添加版本 {args.version}（{len(merged)} 条说明）')


if __name__ == '__main__':
    main()
