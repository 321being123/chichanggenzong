#!/usr/bin/env python3
# 安全追加一条版本记录到 public/changelog.json 与 CHANGELOG.md。
#
# 用法：
#   python add_changelog.py --version 0.2.0.21 --date 2026-07-25 \
#       --item "第一条说明" --item "第二条说明" [--bump-package] [--dry-run]
#
# 目的：避免手工编辑 JSON 时弄坏结构。读写后都会重新解析校验，
# 写坏立即报错且不落盘（先写临时文件再原子替换）。
import argparse
import json
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

    # --- changelog.json ---
    data = json.loads(CHANGELOG_JSON.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        sys.exit('changelog.json 根节点不是数组')
    for e in data:
        if e.get('version') == args.version:
            sys.exit(f'版本 {args.version} 已存在，请勿重复添加')
    entry = {'date': args.date, 'version': args.version, 'items': args.item}
    new_data = [entry] + data
    json_text = json.dumps(new_data, ensure_ascii=False, indent=2) + '\n'
    json.loads(json_text)  # 写前再校验

    # --- CHANGELOG.md ---
    md = CHANGELOG_MD.read_text(encoding='utf-8')
    lines = md.splitlines(keepends=True)
    idx = 0
    for i, ln in enumerate(lines):
        if ln.strip().startswith('# Changelog'):
            idx = i + 1
            break
    block = (
        '\n'
        f'## {args.date} · {args.version}\n'
        + '\n'.join(f'- {it}' for it in args.item) + '\n'
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

    print(f'已添加版本 {args.version}（{len(args.item)} 条说明）')


if __name__ == '__main__':
    main()
