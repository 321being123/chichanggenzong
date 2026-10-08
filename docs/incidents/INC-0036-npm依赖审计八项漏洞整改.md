# INC-0036：npm依赖审计八项漏洞整改

状态：本地整改完成，发布验证中
日期：2026-10-08

## 现象与根因

0.8.3.21生产安装审计报8项：1低、3中、3高、1严重。依赖清单及锁文件保留旧版本；Mammoth CLI传递依赖argparse 1→sprintf-js使同一根问题上卷为3项。浏览器独立DOMPurify副本不随npm安装更新，需要同时更新副本与三个页面的缓存版本。不是安全性数据接口漏洞，也没有本次入侵证据。

## 修复范围与依赖链

| 审计对象 | 本次处理 |
|---|---|
| proxy-addr（critical） | Express 4依赖覆盖为2.0.8，保留既有loopback代理信任配置 |
| brace-expansion（high） | 根与ExcelJS嵌套覆盖同步为^5.0.12，实际锁定5.0.12 |
| DOMPurify（low） | npm及public/vendor副本3.4.16；index/share-knowledge/ipo-report三个页面引用同步 |
| Nodemailer（high） | 9.1.1→10.0.16；验证离线MIME及现有告警回归，不发送真实邮件 |
| Undici（high） | 8.9.0→8.11.2；本地Node22.22.3、生产22.23.2满足>=22.19运行要求 |
| Mammoth/argparse/sprintf-js（3项moderate） | 保留Mammoth1.12.0，精确覆盖其argparse为2.0.1，移除sprintf-js链；实际DOCX CLI转换验证旧API兼容 |

上游依据：[proxy-addr修复公告](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)、[sprintf-js公告](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)及npm审计实时响应。sprintf-js登记版本尚无修复，不能盲目采用audit fix --force建议降级Mammoth到0.3.29；替换传递链并验证完整转换行为。

## 架构对齐与验收

沿用Node/Express、文件解析Worker、SMTP、受控HTTP客户端及前端净化器。没有新数据库结构、金融事实、任务或数据同步。改动影响依赖→服务/上传/邮件/抓取→接口/页面，数据层不变。已有CI的dependency-audit保持高危阻断；没有另建审计调度器。

新增dependency-security回归验证错误IPv4-mapped IPv6前缀不能信任公网地址、loopback可用、Mammoth DOCX CLI真实转换、Nodemailer离线MIME、浏览器副本与npm字节一致；全量现有XSS/上传/告警/安全/移动DOM测试共同回归。本地npm audit（全部及omit=dev）均0，npm ls无sprintf-js，全部同类安装路径已核查；零审计仅代表当次注册表已知npm漏洞，不宣称整个网站绝对安全。

按低性能模式未打开浏览器或做真机视觉验收；前端仅替换净化资源及引用缓存版本，无布局或交互改动。生产标准发布、三单元、health/ready、相关资源哈希与接口、生产npm审计将在执行后补记。

本地最终验收：全量159通过、0失败、0跳过，知识门禁与差异检查通过；health=0.8.3.22，三个页面新版DOMPurify引用均200、资源哈希与仓库一致。npm audit全量与生产依赖均0（生产依赖audit-level=low亦返回0）。邮件只做离线回归，未发送真实邮件。
