// ============== U-5 栏目脚本懒加载（2026-10-21） ==============
// 栏目脚本以 <script type="text/lazy" data-lazy-section="栏目名" src="..."> 声明在 index.html：
// 非 JS 类型浏览器既不下载也不执行；首次进入栏目时按文档顺序注入真实 <script async=false>
// （async=false 保证执行顺序与原 defer 一致），同一 src 只注入一次。
window.LazySections = (function () {
  var injected = {};
  var sections = {};

  function inject(tag) {
    var src = tag.getAttribute('src');
    if (!src) return Promise.resolve();
    if (injected[src]) return injected[src];
    var s = document.createElement('script');
    s.src = src;
    s.async = false; // 动态脚本默认乱序，置 false 恢复文档顺序执行
    injected[src] = new Promise(function (resolve, reject) {
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('脚本加载失败: ' + src)); };
    });
    document.head.appendChild(s);
    return injected[src];
  }

  function selector(name) {
    return 'script[data-lazy-section~="' + name + '"]';
  }

  function hasSection(name) {
    return !!document.querySelector(selector(name));
  }

  function ensureSection(name) {
    if (!name) return Promise.resolve();
    if (sections[name]) return sections[name];
    var tags = document.querySelectorAll(selector(name));
    if (!tags.length) return Promise.resolve();
    var jobs = [];
    tags.forEach(function (tag) { jobs.push(inject(tag)); });
    sections[name] = Promise.all(jobs);
    return sections[name];
  }

  return { ensureSection: ensureSection, hasSection: hasSection };
})();
