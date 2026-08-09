const mammoth = require('mammoth');
const TurndownService = require('turndown');
const { assertSafeZip } = require('./zipSafety');

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const buffer = Buffer.from(input.b64 || '', 'base64');
    assertSafeZip(buffer, { label: 'DOCX', maxUncompressed: 50 * 1024 * 1024, maxEntries: 5000, maxRatio: 200 });
    const converted = await mammoth.convertToHtml({ buffer });
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const content = turndown.turndown(converted.value);
    if (content.length > 5 * 1024 * 1024) throw new Error('DOCX 内容过大');
    process.stdout.write(JSON.stringify({ content }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: 'DOCX 文件无效、过大或解析失败' }));
  }
});
