// ============== U-5 栏目脚本懒加载（2026-10-21） ==============
// 栏目脚本以 <script type="text/lazy" data-lazy-section="栏目名" src="..."> 声明在 index.html：
// 非 JS 类型浏览器既不下载也不执行；首次进入栏目时按文档顺序注入真实 <script async=false>
// （async=false 保证执行顺序与原 defer 一致），同一 src 只注入一次。
window.LazySections = (function () {
  var injected = {};
  var sections = {};
  // 发版瞬间静态文件短暂不可用、或旧页面停在旧版本号时，单次失败不应让栏目永久卡住：
  // 失败按退避重试两次，且重试带 retry 参数绕开浏览器对旧 ?v= 地址的强缓存。
  var RETRY_DELAYS = [400, 1500];

  function load(src, attempt) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = attempt === 0 ? src : src + (src.indexOf('?') >= 0 ? '&' : '?') + 'retry=' + attempt;
      s.async = false; // 动态脚本默认乱序，置 false 恢复文档顺序执行
      s.onload = function () { resolve(); };
      s.onerror = function () {
        if (s.parentNode) s.parentNode.removeChild(s);
        if (attempt < RETRY_DELAYS.length) {
          setTimeout(function () {
            load(src, attempt + 1).then(resolve, reject);
          }, RETRY_DELAYS[attempt]);
          return;
        }
        reject(new Error('脚本加载失败: ' + src));
      };
      document.head.appendChild(s);
    });
  }

  function absolute(src) {
    // 深链接页面（如 /s/security/... ）下相对路径会解析到错误目录，统一按文档基址转绝对地址。
    try { return new URL(src, document.baseURI).href; } catch (error) { return src; }
  }

  function inject(tag) {
    var declared = tag.getAttribute('src');
    if (!declared) return Promise.resolve();
    var src = absolute(declared);
    if (injected[src]) return injected[src];
    injected[src] = load(src, 0).catch(function (error) {
      // 不缓存失败结果，下次进入该栏目仍会重新尝试，而不是一直复用一个失败的 Promise。
      delete injected[src];
      throw error;
    });
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
    sections[name].catch(function () { delete sections[name]; });
    return sections[name];
  }

  return { ensureSection: ensureSection, hasSection: hasSection };
})();
