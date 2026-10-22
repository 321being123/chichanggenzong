// R-10 巨型服务拆分后（2026-10-21）的源码读取口：
// - readServiceSource(base)：主文件+同前缀子模块拼接文本，供正则/includes 类文本断言使用。
// - readServiceFlatten(base)：把拆分产物还原成"单文件形态"（去重 require + 全部函数体 + 原 exports），
//   供 production-ops-recovery 这类 VM 内全局打补丁的测试使用——函数体逐字节与拆分前一致，
//   顶层函数声明在 VM 里仍可被替换，行为与拆分前的单文件完全相同。
const fs = require('fs');
const path = require('path');

const SUFFIXES = ['Core', 'Store', 'Sync', 'Facts'];

function serviceFiles(baseName) {
  const dir = path.join(__dirname, '..', '..', 'services');
  const files = [path.join(dir, baseName + '.js')];
  for (const suffix of SUFFIXES) {
    const p = path.join(dir, baseName + suffix + '.js');
    if (fs.existsSync(p)) files.push(p);
  }
  return files;
}

function readServiceSource(baseName) {
  return serviceFiles(baseName).map(p => fs.readFileSync(p, 'utf8')).join('\n');
}

function readServiceFlatten(baseName) {
  const interModule = new RegExp("^const \\{[^}]*\\} = require\\('\\./" + baseName + "(?:Core|Store|Sync|Facts)\\.js'\\);?$");
  const requireStart = /^const .*=\s*require\(|^const \{[^}]*=\s*require\(|^const \{$/;
  const requires = [];
  const bodies = [];
  let exportsBlock = null;
  for (const file of serviceFiles(baseName)) {
    const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^module\.exports/.test(l)) {
        let e = i;
        while (e < lines.length && !/^\};?$/.test(lines[e])) e++;
        if (exportsBlock === null && file.endsWith(baseName + '.js')) exportsBlock = lines.slice(i, e + 1);
        i = e + 1;
        continue;
      }
      if (/^const |^let /.test(l)) {
        // 语句（含多行 require）
        let depth = 0, j = i;
        for (;;) {
          for (const ch of lines[j]) {
            if ('({['.includes(ch)) depth++;
            if (')}]'.includes(ch)) depth--;
          }
          if (depth <= 0 && /;\s*$/.test(lines[j])) break;
          j++;
          if (j >= lines.length) throw new Error('unterminated statement in ' + file + ' at ' + (i + 1));
        }
        const stmt = lines.slice(i, j + 1).join('\n');
        if (/require\(/.test(stmt)) {
          if (!interModule.test(stmt.trim()) && !new RegExp("^const \\{[^}]*\\} = require\\('\\./" + baseName + "(?:Core|Store|Sync|Facts)\\.js'\\);$").test(stmt.trim().replace(/\n\s*/g, ' '))) {
            const key = stmt.replace(/\s+/g, ' ').trim();
            if (!requires.some(r => r.key === key)) requires.push({ key, stmt });
          }
        } else {
          bodies.push(stmt);
        }
        i = j + 1;
        continue;
      }
      bodies.push(l);
      i++;
    }
  }
  return [...requires.map(r => r.stmt), '', ...bodies, '', ...(exportsBlock || [])].join('\n');
}

module.exports = { readServiceSource, readServiceFlatten };
