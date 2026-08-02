// Excel 解析子进程（隔离沙箱）：在独立进程里解析用户上传的 xlsx，
// 使用维护中的 exceljs（无 xlsx@0.18.5 已知原型污染/ReDoS 高危漏洞）。
// 主进程通过 safeParseExcel 调用，并设有超时强杀。
const ExcelJS = require('exceljs');
const { Readable } = require('stream');

const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  (async () => {
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) { process.stdout.write(JSON.stringify({ error: '输入格式错误' })); return; }

    let buffer;
    try { buffer = Buffer.from(input.b64 || '', 'base64'); }
    catch (e) { process.stdout.write(JSON.stringify({ error: '文件解码失败' })); return; }

    // 1) 魔数判断：xlsx=ZIP(PK\x03\x04)；xls 老格式=OLE2(D0CF11E0)；其余尝试按 CSV 解析
    if (buffer.length < 4) {
      process.stdout.write(JSON.stringify({ error: '文件内容为空或损坏' }));
      return;
    }
    const isXlsx = buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
    const isXls = buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0;
    if (isXls) {
      process.stdout.write(JSON.stringify({ error: '不支持 .xls 老格式，请在 Excel 中另存为 .xlsx 或 .csv 后再上传' }));
      return;
    }
    if (!isXlsx) {
      // 非 ZIP 归档：按 CSV 尝试（ExcelJS csv 解析，worker 超时/内存上限兜底）
      // 剥离 UTF-8 BOM，避免表头带不可见字符
      let csvBuffer = buffer;
      if (csvBuffer[0] === 0xEF && csvBuffer[1] === 0xBB && csvBuffer[2] === 0xBF) csvBuffer = csvBuffer.subarray(3);
      let csvText;
      try {
        csvText = csvBuffer.toString('utf8');
        if (csvText.indexOf('\uFFFD') >= 0) { // 含替换字符 → 大概率 GBK 编码，改用 gbk 重解
          try { csvText = new TextDecoder('gbk').decode(csvBuffer); } catch (e) { /* 保持 utf8 */ }
        }
      } catch (e) {
        process.stdout.write(JSON.stringify({ error: 'CSV 解码失败' }));
        return;
      }
      const wbCsv = new ExcelJS.Workbook();
      await wbCsv.csv.read(Readable.from(Buffer.from(csvText, 'utf8')), { parserOptions: { delimiter: ',', quote: '"' } });
      const rows = collectRows(wbCsv, input);
      process.stdout.write(JSON.stringify({ sheetNames: ['CSV'], rows }));
      return;
    }

    // 2) ZIP Bomb 防护：仅扫描本地文件头累加「解压后体积」，超过上限直接拒绝（不真正解压）
    //    ZIP 本地文件头：偏移18=压缩后大小，偏移22=解压后大小（顺序不可反）
    const MAX_UNCOMPRESSED = 200 * 1024 * 1024; // 200MB
    const GPBF_DATA_DESCRIPTOR = 0x08; // 通用标志位第3位：本地头不含真实大小，大小在尾部数据描述符
    let total = 0, ok = true, i = 0;
    while (i + 30 <= buffer.length) {
      if (buffer[i] === 0x50 && buffer[i + 1] === 0x4B && buffer[i + 2] === 0x03 && buffer[i + 3] === 0x04) {
        const flag = buffer.readUInt16LE(i + 6);
        const comp = buffer.readUInt32LE(i + 18);   // 偏移18 = 压缩后大小
        const uncomp = buffer.readUInt32LE(i + 22); // 偏移22 = 解压后大小
        if (uncomp === 0xFFFFFFFF || comp === 0xFFFFFFFF) { ok = false; break; } // ZIP64：保守拒绝
        if (flag & GPBF_DATA_DESCRIPTOR) break; // 数据描述符：无法静态定界，停止扫描，交由隔离子进程+内存上限兜底
        total += uncomp;
        if (total > MAX_UNCOMPRESSED) { ok = false; break; }
        const fnLen = buffer.readUInt16LE(i + 26);
        const exLen = buffer.readUInt16LE(i + 28);
        i += 30 + fnLen + exLen + comp; // 跳到下一个本地文件头
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
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.read(Readable.from(buffer));
      if (wb.worksheets.length === 0) { process.stdout.write(JSON.stringify({ error: 'Excel 无工作表' })); return; }
      if (wb.worksheets.length > 20) { process.stdout.write(JSON.stringify({ error: 'Excel 工作表过多' })); return; }
      const sheetNames = wb.worksheets.map(s => s.name);
      const rows = collectRows(wb, input);
      // 限制规模：行/列/单元格，防止超大表格撑爆内存 / 放大 AI token
      const trimmed = rows.slice(0, 2000).map(r =>
        Array.isArray(r) ? r.slice(0, 60).map(cellText) : r);
      process.stdout.write(JSON.stringify({ sheetNames, rows: trimmed }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: 'Excel 解析失败：' + e.message }));
    }
  })();
});

// 单元格统一转文本；公式单元格（ExcelJS 值为 { formula, result }）取计算结果，
// 超链接/富文本对象取 text，否则 String() 会变成 "[object Object]"
function cellText(c) {
  let v = c;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;
    else if (typeof v.text === 'string' && v.text) v = v.text;
  }
  const s = String(v == null ? '' : v);
  return s.length > 300 ? s.slice(0, 300) : s;
}

// 从工作簿收集首个工作表的所有行（统一转文本）
function collectRows(wb, inputObj) {
  const rows = [];
  let ws;
  if (inputObj && inputObj.mode === 'contains' && inputObj.contains) {
    ws = wb.worksheets.find(s => String(s.name).includes(inputObj.contains)) || wb.worksheets[0];
  } else {
    ws = wb.worksheets[0];
  }
  if (!ws) return rows;
  ws.eachRow((row) => {
    const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows.push(vals.map(cellText));
  });
  return rows;
}
