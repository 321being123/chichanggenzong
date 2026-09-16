// Node/Python 共用官方 PDF 缓存：URL 哈希、原子写入和命中不重复下载。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readCachedPdf, writeCachedPdf } = require('../services/documentPdfCache');
const { fetchOfficialPdfWithCache } = require('../services/hkexIpo');
const parser = require('../services/arbitrageParser');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-pdf-cache-'));
  const oldDirectory = process.env.DOCUMENT_PDF_CACHE_DIR;
  try {
    process.env.DOCUMENT_PDF_CACHE_DIR = directory;
    const url = 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0901/202609010001.pdf';
    const content = Buffer.from('%PDF-1.4\nnode-cache');
    writeCachedPdf(url, content);
    assert.deepStrictEqual(readCachedPdf(url), content, 'Node 写入后应能命中缓存');

    const pythonCode = [
      'import importlib.util, os, sys',
      'spec=importlib.util.spec_from_file_location("cache", sys.argv[1])',
      'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'url="https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0901/202609010001.pdf"',
      'p=m.get_cached_pdf(url)',
      'assert p and p.read_bytes()==b"%PDF-1.4\\nnode-cache"',
      'url2="https://static.cninfo.com.cn/finalpage/2026-09-08/1225552499.PDF"',
      'm.put_cached_pdf(url2, b"%PDF-1.4\\npython-cache")',
      'assert m.get_cached_pdf(url2) and m.get_cached_pdf(url2).read_bytes()==b"%PDF-1.4\\npython-cache"',
    ].join(';');
    const pyRun = spawnSync(parser.resolvePython(), ['-c', pythonCode, path.join(__dirname, '..', '..', 'ipo-report', 'document_pdf_cache.py')], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    assert.strictEqual(pyRun.status, 0, pyRun.stderr || pyRun.stdout);
    assert.deepStrictEqual(readCachedPdf('https://static.cninfo.com.cn/finalpage/2026-09-08/1225552499.PDF'), Buffer.from('%PDF-1.4\npython-cache'));

    let requests = 0;
    const fetchImpl = async () => { requests += 1; return Buffer.from('%PDF-1.4\nfetch-cache'); };
    const first = await fetchOfficialPdfWithCache('https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0902/202609020001.pdf', fetchImpl);
    const second = await fetchOfficialPdfWithCache(first.url, fetchImpl);
    assert.strictEqual(requests, 1, '第二次读取同一官方 PDF 不应重复联网');
    assert.strictEqual(second.cacheHit, true);
    assert.deepStrictEqual(second.buffer, first.buffer);
    console.log('document-pdf-cache: Node/Python 共用、原子落盘和命中复用通过');
  } finally {
    if (oldDirectory === undefined) delete process.env.DOCUMENT_PDF_CACHE_DIR;
    else process.env.DOCUMENT_PDF_CACHE_DIR = oldDirectory;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
