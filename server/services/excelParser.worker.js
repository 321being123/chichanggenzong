// Excel 解析子进程（隔离沙箱）：在独立进程里解析用户上传的 xlsx，
// 避免 xlsx@0.18.5 已知原型污染/ReDoS 漏洞在 Web 主进程被触发。
// 主进程通过 safeParseExcel 调用，并设有超时强杀。
const XLSX = require('xlsx');

const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (e) { process.stdout.write(JSON.stringify({ error: '输入格式错误' })); return; }

  let buffer;
  try { buffer = Buffer.from(input.b64 || '', 'base64'); }
  catch (e) { process.stdout.write(JSON.stringify({ error: '文件解码失败' })); return; }

  // 1) 魔数校验：xlsx 本质是 ZIP 归档，必须以 PK\x03\x04 开头
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B ||
      buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    process.stdout.write(JSON.stringify({ error: '文件不是有效的 Excel(.xlsx) 文件' }));
    return;
  }

  // 2) ZIP Bomb 防护：仅扫描本地文件头累加「解压后体积」，超过上限直接拒绝（不真正解压）
  const MAX_UNCOMPRESSED = 200 * 1024 * 1024; // 200MB
  let total = 0, ok = true, i = 0;
  while (i + 30 <= buffer.length) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4B && buffer[i + 2] === 0x03 && buffer[i + 3] === 0x04) {
      const uncomp = buffer.readUInt32LE(i + 18);
      const comp = buffer.readUInt32LE(i + 22);
      if (uncomp === 0xFFFFFFFF || comp === 0xFFFFFFFF) { ok = false; break; } // ZIP64：保守拒绝
      total += uncomp;
      if (total > MAX_UNCOMPRESSED) { ok = false; break; }
      const fnLen = buffer.readUInt16LE(i + 26);
      const exLen = buffer.readUInt16LE(i + 28);
      if (comp === 0) break; // 含数据描述符：无法静态校验，停止扫描（仍交给 XLSX 解析）
      i += 30 + fnLen + exLen + comp;
      continue;
    }
    i++;
  }
  if (!ok) {
    process.stdout.write(JSON.stringify({ error: 'Excel 解压后体积过大，已被拒绝（疑似压缩炸弹）' }));
    return;
  }

  // 3) 真正解析（已在子进程中，异常/卡死不影响主进程）
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    if (wb.SheetNames.length === 0) { process.stdout.write(JSON.stringify({ error: 'Excel 无工作表' })); return; }
    if (wb.SheetNames.length > 20) { process.stdout.write(JSON.stringify({ error: 'Excel 工作表过多' })); return; }
    let sheetName;
    if (input.mode === 'contains' && input.contains) {
      sheetName = wb.SheetNames.find(n => String(n).includes(input.contains)) || wb.SheetNames[0];
    } else {
      sheetName = wb.SheetNames[0];
    }
    const ws = wb.Sheets[sheetName];
    let rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', cellDates: true });
    // 限制规模：行/列/单元格，防止超大表格撑爆内存 / 放大 AI token
    rows = rows.slice(0, 2000).map(r =>
      Array.isArray(r) ? r.slice(0, 60).map(c => {
        const s = String(c == null ? '' : c);
        return s.length > 300 ? s.slice(0, 300) : s;
      }) : r);
    process.stdout.write(JSON.stringify({ sheetNames: wb.SheetNames, rows }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: 'Excel 解析失败：' + e.message }));
  }
});
