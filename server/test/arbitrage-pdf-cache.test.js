// 套利公告 PDF 缓存：30 天 TTL、5 GiB 总量上限、最旧优先淘汰。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const parser = require('../services/arbitrageParser');
const cache = require('../services/arbitragePdfCache');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-pdf-cache-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function writeSized(file, size, mtimeMs) {
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

withTempDir(dir => {
  const oldDir = process.env.ARBITRAGE_PDF_CACHE_DIR;
  const oldMax = process.env.ARBITRAGE_PDF_CACHE_MAX_BYTES;
  const oldTtl = process.env.ARBITRAGE_PDF_CACHE_TTL_DAYS;
  try {
    process.env.ARBITRAGE_PDF_CACHE_DIR = dir;
    process.env.ARBITRAGE_PDF_CACHE_MAX_BYTES = String(2 * 1024 * 1024);
    process.env.ARBITRAGE_PDF_CACHE_TTL_DAYS = '30';
    const now = Date.now();
    writeSized(path.join(dir, 'expired.pdf'), 1024, now - 31 * 86400000);
    writeSized(path.join(dir, 'old.pdf'), 1500000, now - 2 * 86400000);
    writeSized(path.join(dir, 'new.pdf'), 1500000, now - 1 * 86400000);
    const result = cache.cleanupArbitragePdfCache(now);
    assert.ok(!fs.existsSync(path.join(dir, 'expired.pdf')), '超过30天的缓存必须删除');
    assert.ok(!fs.existsSync(path.join(dir, 'old.pdf')), '超过总量时必须优先删除最旧文件');
    assert.ok(fs.existsSync(path.join(dir, 'new.pdf')), '总量清理必须保留较新的文件');
    assert.strictEqual(result.deletedExpired, 1);
    assert.strictEqual(result.deletedOverflow, 1);
  } finally {
    if (oldDir === undefined) delete process.env.ARBITRAGE_PDF_CACHE_DIR; else process.env.ARBITRAGE_PDF_CACHE_DIR = oldDir;
    if (oldMax === undefined) delete process.env.ARBITRAGE_PDF_CACHE_MAX_BYTES; else process.env.ARBITRAGE_PDF_CACHE_MAX_BYTES = oldMax;
    if (oldTtl === undefined) delete process.env.ARBITRAGE_PDF_CACHE_TTL_DAYS; else process.env.ARBITRAGE_PDF_CACHE_TTL_DAYS = oldTtl;
  }
});

const py = [
  'import importlib.util, json, os, sys, tempfile, time, shutil',
  'spec=importlib.util.spec_from_file_location("arb", sys.argv[1])',
  'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
  'd=tempfile.mkdtemp(prefix="arb-py-cache-")',
  'os.environ["ARBITRAGE_PDF_CACHE_TTL_DAYS"]="30"',
  'url="https://static.cninfo.com.cn/finalpage/2026-09-08/1225552499.PDF"',
  'p=m.pdf_cache_path(url,d); open(p,"wb").write(b"pdf")',
  'assert m.get_cached_pdf(url,d) == p',
  'old=time.time()-31*86400; os.utime(p,(old,old))',
  'assert m.get_cached_pdf(url,d) is None',
  'shutil.rmtree(d)',
  'print(json.dumps({"ok":True}))',
].join(';');
const run = spawnSync(parser.resolvePython(), ['-c', py, parser.SCRIPT], {
  encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', EXTERNAL_CALL_GUARD: '0', PYTHONUTF8: '1' },
});
assert.strictEqual(run.status, 0, run.stderr || run.stdout);
assert.match(run.stdout, /"ok": true/);
console.log('arbitrage-pdf-cache: TTL、总量上限、最旧淘汰和 Python 命中复用通过');
