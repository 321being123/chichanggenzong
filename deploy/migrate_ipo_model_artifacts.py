#!/usr/bin/env python3
"""把现有 IPO 模型首次迁移到发布目录之外的运行时目录。

脚本只在目标文件不存在时写入，重复执行不会覆盖正在使用的模型。
"""
import argparse
import json
import os
import pwd
import shutil
import tempfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PROJECT_ROOT / "ipo-report" / "data"
DEFAULT_TARGET = Path("/var/lib/portfolio/models/ipo")
MODEL_FILES = ("ipo_xgb_model.json", "ipo_xgb_features.json")


def install_if_missing(source: Path, target: Path, uid: int, gid: int) -> str:
    if target.exists():
        if not target.is_file() or target.stat().st_size <= 0:
            raise RuntimeError(f"目标模型文件异常：{target}")
        # 已存在的文件也统一收紧属主和权限，避免中断迁移后留下 root-only 文件。
        os.chown(target, uid, gid)
        os.chmod(target, 0o640)
        return "existing"
    if not source.is_file() or source.stat().st_size <= 0:
        raise RuntimeError(f"源模型文件不存在或为空：{source}")
    if source.name == "ipo_xgb_features.json":
        json.loads(source.read_text(encoding="utf-8"))
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=f".{target.name}.", delete=False) as handle:
        temp = Path(handle.name)
    try:
        shutil.copyfile(source, temp)
        os.chmod(temp, 0o640)
        os.chown(temp, uid, gid)
        os.replace(temp, target)
    finally:
        if temp.exists():
            temp.unlink()
    return "installed"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--target-dir", type=Path, default=DEFAULT_TARGET)
    args = parser.parse_args()
    source_dir = args.source_dir.expanduser().resolve()
    target_dir = args.target_dir.expanduser().resolve()
    if target_dir == PROJECT_ROOT or str(target_dir).startswith(str(PROJECT_ROOT) + os.sep):
        raise SystemExit("目标模型目录必须脱离发布代码目录")
    target_dir.mkdir(parents=True, exist_ok=True)
    app_user = pwd.getpwnam("portfolio-app")
    os.chown(target_dir, app_user.pw_uid, app_user.pw_gid)
    os.chmod(target_dir, 0o750)
    for filename in MODEL_FILES:
        status = install_if_missing(source_dir / filename, target_dir / filename, app_user.pw_uid, app_user.pw_gid)
        print(f"{filename}: {status}")


if __name__ == "__main__":
    main()
