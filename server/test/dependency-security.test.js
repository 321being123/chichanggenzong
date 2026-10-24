const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const JSZip = require('jszip');
const proxyaddr = require('proxy-addr');

(async () => {
  // GHSA-jqcg-44mw-7w3h：错误映射前缀不得信任任意 IPv4 / 映射 IPv6。
  const unsafeSubnet = proxyaddr.compile('::ffff:10.0.0.0/8');
  assert.strictEqual(unsafeSubnet('203.0.113.5'), false);
  assert.strictEqual(unsafeSubnet('::ffff:203.0.113.5'), false);
  const loopback = proxyaddr.compile('loopback');
  assert.strictEqual(loopback('127.0.0.1'), true);
  assert.strictEqual(loopback('203.0.113.5'), false);

  // 保留 Mammoth 的转换及 CLI 参数能力，验证 argparse 2 的旧 API 兼容。
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Dependency compatibility</w:t></w:r></w:p></w:body></w:document>');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-docx-'));
  try {
    const input = path.join(dir, 'input.docx');
    fs.writeFileSync(input, await zip.generateAsync({ type: 'nodebuffer' }));
    const cli = path.join(path.dirname(require.resolve('mammoth/package.json')), 'bin', 'mammoth');
    const result = spawnSync(process.execPath, [cli, input, '--output-format', 'html'], { encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('<p>Dependency compatibility</p>'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 新版邮件库只在内存生成 MIME，禁止联系真实 SMTP 或发出邮件。
  const mail = await require('nodemailer').createTransport({ streamTransport: true, buffer: true }).sendMail({
    from: 'sender@example.test', to: 'recipient@example.test', subject: '兼容回归', text: 'offline test',
  });
  assert.deepStrictEqual(mail.envelope.to, ['recipient@example.test']);
  assert.ok(mail.message.toString().includes('offline test'));
  // 2026-10-24收件人语法修复：注释、组名与带>的引号本地部分不能释放额外收件人。
  const addressparser=require('nodemailer/lib/addressparser');
  assert.deepStrictEqual(addressparser('safe@example.test (nested (inner) hidden@example.test)').map(x=>x.address),['safe@example.test']);
  assert.deepStrictEqual(addressparser('Team: "display; hidden@example.test" <safe@example.test>;')[0].group.map(x=>x.address),['safe@example.test']);
  assert.strictEqual(addressparser('"user>name"@example.test')[0].address,'"user>name"@example.test');
  // 新HTTP客户端、请求体解码及上传库共同走真实本机HTTP，不联系外部服务。
  const express=require('express'),multer=require('multer'),zlib=require('zlib');
  const app=express();
  app.post('/body',express.json(),(req,res)=>res.json(req.body));
  app.post('/upload',multer({storage:multer.memoryStorage()}).single('file'),(req,res)=>res.json({size:req.file.size,name:req.file.originalname}));
  app.use((err,req,res,next)=>res.status(400).json({error:'invalid_body'}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    const {request}=require('undici');
    const good=await request(origin+'/body',{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:zlib.gzipSync(Buffer.from('{"ok":true}'))});
    assert.strictEqual(good.statusCode,200);assert.deepStrictEqual(await good.body.json(),{ok:true});
    const bad=await request(origin+'/body',{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:Buffer.concat([zlib.gzipSync(Buffer.from('{}')),Buffer.from('invalid trailing bytes')])});
    assert.strictEqual(bad.statusCode,400);await bad.body.dump();
    const boundary='dependency-compatibility-boundary';
    const upload=await request(origin+'/upload',{method:'POST',headers:{'content-type':`multipart/form-data; boundary=${boundary}`},body:`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.txt"\r\nContent-Type: text/plain\r\n\r\nabc\r\n--${boundary}--\r\n`});
    assert.strictEqual(upload.statusCode,200);assert.deepStrictEqual(await upload.body.json(),{size:3,name:'sample.txt'});
  } finally {await new Promise(resolve=>server.close(resolve));}
  const root = path.resolve(__dirname, '../..');
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'public/vendor/dompurify.min.js')),
    fs.readFileSync(require.resolve('dompurify').replace(/purify\.cjs\.js$/, 'purify.min.js')));
  console.log('dependency security: proxy spoofing blocked, DOCX CLI/MIME/vendor compatibility passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
