"""IPO 模型运行产物路径。

模型属于可替换的运行产物，不应与发布代码共用目录；未配置时保留本地旧路径，
便于开发和测试环境平滑过渡。
"""
import os


def get_model_dir():
    configured = os.environ.get("IPO_MODEL_DIR", "").strip()
    if not configured:
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    if not os.path.isabs(configured):
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        configured = os.path.join(project_root, configured)
    return os.path.abspath(os.path.expanduser(configured))


__all__ = ["get_model_dir"]
