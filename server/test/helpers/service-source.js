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
  const files = serviceFiles(baseName).slice();
  // 分层整改后，部分 SQL 已下沉到数据层：文本断言需同时覆盖对应仓储，
  // 否则「服务里必须有某段 SQL」的检查会因为实现搬家而失效。
  const repoDir = path.join(__dirname, '..', '..', 'repositories');
  const repoNames = [baseName + 'Repository.js', baseName + 'DataRepository.js'];
  for (const suffix of SUFFIXES) {
    repoNames.push(baseName + suffix + 'Repository.js');
    repoNames.push(baseName + suffix + 'DataRepository.js');
  }
  for (const name of repoNames) {
    const p = path.join(repoDir, name);
    if (fs.existsSync(p) && !files.includes(p)) files.push(p);
  }
  return files.map(p => fs.readFileSync(p, 'utf8')).join('\n');
}

function readServiceFlatten(baseName) {
  const interModule = new RegExp("^const \\{[^}]*\\} = require\\('\\./" + baseName + "(?:Core|Store|Sync|Facts)\\.js'\\);?$");
  const requireStart = /^const .*=\s*require\(|^const \{[^}]*=\s*require\(|^const \{$/;
  const requires = [];
  const bodies = [];
  let exportsBlock = null;
  // 分层整改后各子模块都可能引入各自的数据层模块（同名变量 repository）；
  // 拼回单文件形态时必须按来源去重改名，否则 VM 里会 "already declared"。
  const repoVars = new Map();
  for (const file of serviceFiles(baseName)) {
    let fileText = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const repoMatch = /^const repository = require\('([^']+)'\);$/m.exec(fileText);
    if (repoMatch) {
      const mod = repoMatch[1];
      if (!repoVars.has(mod)) repoVars.set(mod, repoVars.size === 0 ? 'repository' : `repository${repoVars.size + 1}`);
      const target = repoVars.get(mod);
      if (target !== 'repository') {
        fileText = fileText
          .replace(/^const repository = require\('[^']+'\);$/m, `const ${target} = require('${mod}');`)
          .replace(/\brepository\./g, `${target}.`);
      }
    }
    const lines = fileText.split('\n');
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
