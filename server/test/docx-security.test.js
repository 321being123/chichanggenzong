const assert = require('assert');
const { ZipArchive } = require('archiver');
const { PassThrough } = require('stream');
const { safeParseDocx } = require('../services/docxSafe');
const { assertSafeZip } = require('../services/zipSafety');

function makeDocx() {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
    const zip = new ZipArchive({ zlib: { level: 9 } });
    zip.on('error', reject);
    zip.pipe(output);
    zip.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>', { name: '[Content_Types].xml' });
    zip.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>', { name: '_rels/.rels' });
    zip.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t>安全文档测试</w:t></w:r></w:p><w:sectPr/></w:body></w:document>', { name: 'word/document.xml' });
    zip.finalize();
  });
}

(async () => {
  const docx = await makeDocx();
  const meta = assertSafeZip(docx, { label: 'DOCX', maxUncompressed: 50 * 1024 * 1024 });
  assert.ok(meta.entries >= 3, '中央目录条目未正确读取');
  const content = await safeParseDocx(docx, { timeoutMs: 15000 });
  assert.ok(content.includes('安全文档测试'), '正常 DOCX 内容未保留');

  const malformed = Buffer.alloc(40);
  malformed.writeUInt32LE(0x04034B50, 0);
  malformed.writeUInt16LE(0x08, 6); // data descriptor，但没有可信中央目录
  await assert.rejects(() => safeParseDocx(malformed), /结构异常|压缩炸弹/);
  console.log('DOCX 安全解析：3/3 通过');
})().catch(e => { console.error(e); process.exit(1); });
