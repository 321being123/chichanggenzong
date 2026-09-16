"""Node/Python 共用的官方文档 PDF 持久化缓存。"""
import hashlib
import os
import tempfile
import time
from pathlib import Path

DEFAULT_TTL_DAYS = 30
DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024


def cache_dir(cache_dir=None):
    configured = str(cache_dir or os.environ.get("DOCUMENT_PDF_CACHE_DIR")
                     or os.environ.get("ARBITRAGE_PDF_CACHE_DIR") or "").strip()
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[1] / "data" / "document_pdf_cache"


def cache_limits():
    try:
        ttl_days = int(os.environ.get("DOCUMENT_PDF_CACHE_TTL_DAYS",
                                      os.environ.get("ARBITRAGE_PDF_CACHE_TTL_DAYS", DEFAULT_TTL_DAYS)))
    except (TypeError, ValueError):
        ttl_days = DEFAULT_TTL_DAYS
    try:
        max_bytes = int(os.environ.get("DOCUMENT_PDF_CACHE_MAX_BYTES",
                                      os.environ.get("ARBITRAGE_PDF_CACHE_MAX_BYTES", DEFAULT_MAX_BYTES)))
    except (TypeError, ValueError):
        max_bytes = DEFAULT_MAX_BYTES
    return max(ttl_days, 1), max(max_bytes, 1 * 1024 * 1024)


def pdf_cache_path(url, directory=None):
    digest = hashlib.sha256(str(url or "").encode("utf-8")).hexdigest()
    return cache_dir(directory) / f"{digest}.pdf"


def cleanup_pdf_cache(directory=None, now=None):
    directory = cache_dir(directory)
    directory.mkdir(parents=True, exist_ok=True)
    ttl_days, max_bytes = cache_limits()
    current = float(time.time() if now is None else now)
    cutoff = current - ttl_days * 24 * 60 * 60
    files = []
    deleted_expired = 0
    deleted_overflow = 0
    for path in directory.glob("*"):
        if not path.is_file() or path.suffix.lower() not in {".pdf", ".part"}:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        if stat.st_mtime < cutoff:
            try:
                path.unlink()
                deleted_expired += 1
            except OSError:
                pass
            continue
        if path.suffix.lower() == ".pdf":
            files.append((stat.st_mtime, stat.st_size, path))
    total_bytes = sum(size for _, size, _ in files)
    for _, size, path in sorted(files, key=lambda item: (item[0], str(item[2]))):
        if total_bytes <= max_bytes:
            break
        try:
            path.unlink()
            total_bytes -= size
            deleted_overflow += 1
        except OSError:
            pass
    return {
        "directory": str(directory), "total_bytes": max(total_bytes, 0),
        "file_count": max(len(files) - deleted_overflow, 0),
        "deleted_expired": deleted_expired, "deleted_overflow": deleted_overflow,
        "ttl_days": ttl_days, "max_bytes": max_bytes,
    }


def get_cached_pdf(url, directory=None, now=None):
    directory = cache_dir(directory)
    cleanup_pdf_cache(directory, now=now)
    path = pdf_cache_path(url, directory)
    try:
        stat = path.stat()
    except OSError:
        return None
    ttl_days, _ = cache_limits()
    current = float(time.time() if now is None else now)
    if stat.st_size <= 0 or stat.st_mtime < current - ttl_days * 24 * 60 * 60:
        return None
    return path


def put_cached_pdf(url, content, directory=None):
    if not content:
        raise ValueError("PDF 缓存内容为空")
    directory = cache_dir(directory)
    directory.mkdir(parents=True, exist_ok=True)
    target = pdf_cache_path(url, directory)
    fd, temp_path = tempfile.mkstemp(prefix="document-", suffix=".part", dir=str(directory))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
        os.replace(temp_path, target)
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
    finally:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except OSError:
            pass
    cleanup_pdf_cache(directory)
    return target


__all__ = ["DEFAULT_TTL_DAYS", "DEFAULT_MAX_BYTES", "cache_dir", "cache_limits",
           "pdf_cache_path", "cleanup_pdf_cache", "get_cached_pdf", "put_cached_pdf"]
