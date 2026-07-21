# Changelog

## 2026-07-21
- 当前统一应用版本：`0.1.0.1`。
- 修复首次进入持仓管理时行情涨跌已更新、总资产未同步重算的问题，并避免初始化阶段重复刷新导致资产占比圆环图连续生成两次。
- 修复 A 股盘中涨跌方向可能计算错误的问题：实时价格和涨跌幅统一优先采用腾讯同一条行情，腾讯不可用时再回退 Tushare。
- 修复新股单独分析混入后续新债内容的问题。
- 新股上市预测改用各板块近一年涨幅中位数作为基准，降低少数极端上涨样本造成的预测偏差；暂不对未盈利新股固定折价。
- 修正新股 XGBoost 模型文件读取路径，恢复模型预测；模型不可用时继续回退到板块规则模型。

## 2026-07-20
- 修复线上打新日历18点任务：改为调用次日日报生成主脚本；Linux服务器自动使用系统 `psql`，不再误用Windows路径；调度失败时保留所有Python候选的真实错误。
- 财务三表补充合计科目与明细科目的父子层级，子项缩进显示。

## 2026-07-19
- 新增股票分析功能，支持持仓股和自选股的基本面、估值分位、盈利分红、增长、现金流和公司大事分析。
- 新增上市以来财务数据分层存储、历史估值缓存、增量刷新、异常数据重拉及失败保留机制。
- 新增资产负债表、利润表和现金流量表顶部切换，按财务结构分区展示年度原值和同比，并补全历史字段。
- 优化历史分红图表、年度悬浮详情、时间筛选、累计分红率、平均股息率和历史分红列表。

> ⚠️ **Docker 已废弃**：本项目生产环境使用腾讯云裸机 + pm2 + Nginx，**当前不支持 Docker 部署**。Dockerfile / docker-compose.yml / .dockerignore 已删除；下方历史条目中涉及 Docker 的内容仅供回顾，请勿按此部署。

## 2026-07-18
- 持仓管理账户下拉框前新增刷新按钮，可刷新持仓实时价格并重新计算总资产。
- 持仓和交易细类由“A股”拆分为沪市、深市、京市，并兼容已有A股历史数据。
- 修复税费设置保存无效：佣金、印花税、过户费等费率可正确持久化，保存后立即参与交易税费计算。
- 智能图片导入新增交易税费识别：可读取佣金、印花税、过户费和其他费用，自动计算费率并保存到税费设置。
- 智能识图遇到上游502、503、504或网络波动时自动重试3次，持续不可用时显示简洁提示。
- 打新建议中的“上市”“打新”统一为黑色文字、无底色，并移除建议区的查看详情链接。
- 打新日历同一天的多个股票或转债改为逐只换行，每只标的提供独立查看详情；历史报告缺失时自动生成基础详情。
- 新债预测改为跟踪首个非涨停日涨幅，补充历史转债首日涨幅数据并优化预测偏差统计。
- 新债预测文案统一取最接近的5元整数并显示“左右”；157.3元预测不再显示“顶格”，预计次日继续涨停时单独说明。
- 打新日历和新股历史暂时移除京市新股。
- 修复新股历史公开发行市值为空的问题，缺失时自动计算并固定保留两位小数。

## 2026-07-17
- 「存在小站」首页升级为统一投资工作台，集中展示持仓总资产、近期打新安排与可转债风险分布，三个模块可直接跳转。
- 首页改为公开默认入口：未登录可查看打新和转债安全性，个人持仓仍受登录保护；点击头像或持仓管理时进入登录，登录后自动回跳。
- 新增可转债安全性模块：整合 Tushare 财务数据、腾讯实时转债价格和数据库快照，支持三项债权安全指标、风险筛选和 Excel 导出。
- 转债指标直接显示实际值（保留两位小数）：利息保障倍数、现金覆盖负债>=1、负债/市值<=1.5；银行与非银金融保留「行业豁免」。
- 修复登录限流缓存定时清理导致服务进程崩溃的问题，持仓行情和打新日历不再因此中断。
- 补上遗漏的打新日历定时任务：工作日 18:00（上海时间）自动调用 Tushare 刷新日历，支持 Web/worker 调度、Python 路径探测、防重入和失败日志。
- 腾讯行情增加批量获取、GBK 解析、转债代码分流和数据库缓存，异常时保留上一份有效价格，减少重复 API 请求。
- 清理未使用的 Docker 配置：项目生产环境用腾讯云裸机 + pm2 + Nginx，从未使用 Docker，已删除 Dockerfile、docker-compose.yml、.dockerignore 以及说明文档里的 Docker 部署段落，保持仓库整洁。
- 工程质量加固（不影响日常使用）：补全了打新脚本此前漏写的 Python 依赖清单，避免部署到服务器时缺少库而报错；代码自动检查流程新增 Python 语法检查和依赖漏洞扫描；并新增数据库自动备份脚本，可每天定时把数据库导出压缩留存。
- 数据库启动方式优化：以前服务每次启动都会把建表、加字段的语句重新跑一遍（虽然不会出错但没必要）。现在改成「升级记录表」机制——只在第一次启动执行这些建表语句并把步骤记下来，之后启动直接跳过已完成的步骤，启动更快也更规范；以后要加新表/新字段也是追加新步骤，不再往启动里堆 SQL。
- 保存持仓数据提速：以前每保存一次账户，持仓、交易、净值、现金流都是一条一条往数据库写（交易记录多时要往返上万次，很慢）。现在改成按表一次性批量写入，保存速度大幅提升，数据完整性和金额精度完全不变。
- 数据库代码整理：原来存放所有数据库读写逻辑的单个大文件（一千多行）拆分成了多个按功能分类的小文件（连接管理、用户、账户、任务锁、升级记录、配置等），并保留了一个兼容入口让其他代码无需任何改动。拆分后所有数据库功能都经过本地真实数据库实测，行为和原来完全一致。
- 打新日报脚本代码整理：原来那个四千多行的打新日报主脚本拆成了 6 个按功能分类的小文件（公共工具、数据抓取、估值、板块、预测、报告生成），并保留了兼容入口让其他代码无需任何改动。拆分后经过实际运行验证，全部原有功能都完整可用，行为完全不变。
- 修复了首次启动自动建表失败的回归：补全拆分时遗漏的几个内部调用，并在全新空数据库上实测通过，确保部署后第一次启动能正确建表。
- 清理了备份脚本里写死的旧密码，改为从环境变量读取，不再把密码明文留在代码里。
- 加强了 Excel 导入防护：能正确拦截恶意压缩包（解压炸弹），并限制运行内存和文件大小。
- 修复了收盘自动记录的时间计算：固定用北京时间，避免服务器时区不同导致跑错时间；并避免重复记录同一只股票。
- 修复了打新日报页面在出错时白屏：现在能正常提示「未登录/无权限/无报告」等状态，显示内容做了防注入处理，并覆盖了多种异常分支。
- 统一了测试入口：安全测试、打新前端测试、Python 功能测试、数据库迁移测试现在一条命令全部跑完，且能准确报告失败项（之前会误判通过）。
- 修复了打新脚本拆分后部分内部函数调用失效的问题（统一测试入口后发现并修好）。
- CI 流程加固：自动跑全部测试、Python 装依赖跑功能测试、依赖高危漏洞直接阻断发布、新增密钥泄露扫描，第三方动作固定到具体版本防篡改。
- 补全了 Python 依赖版本锁定、Node 22 以上版本要求，部署文档改为精确安装并修正过时的端口和容器描述。
- 数据库备份增加了加密和完整性校验，并补充了异地备份、定期恢复演练等生产闭环说明。
- 合并 Python 依赖清单：把 ipo-report 的依赖清单统一指向根目录 requirements.txt（单一权威来源，已固定 akshare、paramiko 等版本），避免两份清单各自漂移导致服务器缺库。
- 在更新日志、PostgreSQL 改造交接文档、两份旧整改报告顶部加了「当前已不支持 Docker」的醒目标记，避免新维护者照旧步骤部署。
- 修复了部署后服务起不来的问题：之前代码引用了一个还没提交的可转债安全性模块，部署到服务器后找不到该文件、整个服务崩溃起不来。已移除这几处引用（该功能尚未完成、不在本次上线范围），现在能正常启动。

## 2026-07-16
- 可转债流通规模算错已修正：宝钛转债之前线上显示约8亿，实际约18亿。改用上市公告书上的真实数字反推总发行量，偏差过大时才退回平台数据兜底，并加了测试用例防止复发。
- 补全每日自动记录：之前只有打开网页才会记指数点位、港币汇率、总资产，没开网页就断档。现在收市后自动补齐——指数每天落库、汇率每天刷新、总资产和投资收益每天存快照。
- 总资产/投资收益每天自动存快照：收市后按收盘价自动算好写进历史表，只补缺口、不覆盖已有记录。
- 补一次部署：之前漏交一个文件导致服务器启动崩溃、后台任务全停，已补上并重部署恢复正常。
- 港币汇率源失效已换：原抓取地址返回空，改用新的免费汇率接口，港股估值不再用旧汇率。
- 快照补齐兜底：服务器崩溃那几天部分持仓缺价，原逻辑会跳过整天；现用最近有价的那天价格兜底，保证连续。
- 打新历史表的转债发行规模精确到小数点后3位。
- 新股中签率显示精确到小数点后3位。
- 打新日历补入赛斯发债（7月17日申购）：之前生成日历时它还没公告漏收了，已重新刷新补上。
- 打新日报和日历自动化：服务器每天18点自动生成次日的打新建议并更新日历，不用再手动触发。
- 预测跟踪统计修复：现在会自动把最近真实上市的新股和新债算进统计，不再卡在旧数字；同时修好了已上市转债没被计入的问题。
- 打新建议现在显示最新一期日报：本地库之前停在7月15日，已把服务器最新日报（7月17日）同步到本地，打新建议和日历不再显示过期内容。
- 可转债历史表去掉「网下顶格(亿)」这一列（日常基本用不到）。
- 修复赛斯发债方案进展显示错误：它已进入申购阶段，之前误显示上一阶段的「发行公告」，现在正确显示「申购日」。
- 总资产改为按持仓现值实时计算：之前休市就停止刷新行情、导致总资产用旧价格，现在休市也拉取最新收盘价，总资产随行情实时更新。
- 打新日历不再漏数据：之前 7月17日两只转债上市、7月24日两只新股申购没显示，原因是读日期的小工具只认「带横杠」的写法，Tushare 给的「不带横杠」日期被当成空值丢掉。已修复，现在两种写法都能识别，日历里的申购/上市排期不再缺。
- 新股历史表新增「公开发行市值」一列：显示网上发行那部分值多少钱（=网上发行数量×发行价）。
- 打新日历底层代码做了合并清理：之前日历的生成逻辑在日报脚本和刷新脚本里各写了一份，容易改了一处另一处没跟上、再次导致漏数据。现已合并到统一的模块，两个脚本共用同一套逻辑，从根上杜绝这种「一份改了另一份忘了」的隐患。
- 净值计算公式统一收口：之前「收益走势」「总览对比图」「后台每日快照」「历史净值回放」几处各自复制了同一套净值计算公式，改一处容易漏掉别处、再次出现数据对不上的隐患。现已抽成唯一一份公式，前台后台共用，以后调整净值算法只改一个地方。
- 股票板块分类规则统一收口：之前日报和另一个数据脚本里各写了一份「按代码判断属于哪个板块」的逻辑，两份容易改了这张忘了那张。现已合并成唯一一份，两边共用，板块判断不再可能分叉。
- 打新脚本里重复的小工具函数统一收口：之前好几个打新脚本各自复制了「读配置」「调行情接口」「连数据库执行」等小工具，重复且难维护。现已抽到公共模块，各脚本共用、删掉各自的副本，改一处就全局生效。
- 净值公式新增自动测试守护：给统一后的净值公式加了自动测试用例，以后调整算法如果算错会立刻报警，不会静悄悄地带错上线。
- 安全加固·数据库密码：之前好几个Python脚本把数据库密码直接写在代码里，已改为从环境变量读取，密码不再出现在代码和仓库中。
- 安全加固·Docker部署：镜像里不再打包.env配置、日志、数据库等敏感文件，并且只在本机内部访问、端口不再直接对外暴露。
- 修复收盘价漏记：账户里同时有A股、可转债、ETF时，之前A股先记录会导致可转债和ETF当天的收盘价被跳过不记录；现在改成按每个代码单独判断、缺哪个补哪个，不再整片漏掉。
- 修复调度时区：自动记录收盘价的时间改为明确用北京时间，不再受服务器所在时区影响，避免换到不同时区的机器部署时记录错日期。
- 安全加固·报告内容过滤：打新日报里的网页内容做了安全过滤，防止有人通过报告内容植入恶意脚本危害查看者。
- 安全加固·Excel导入隔离：持仓Excel导入改在隔离的子进程里解析，并校验文件真伪、限制解压大小，防止畸形或恶意Excel文件拖垮服务器。
- 修复多用户并发保存互相覆盖：之前保存账户信息会把整个用户表读出来再整体写回，两个人同时操作可能丢失对方的改动；现在改成只针对单个用户单独、安全地操作，注册时也用数据库唯一约束防止重复。
- 加强服务端数据校验：期初本金、港币汇率、总市值、基金记录等都加了范围检查（例如汇率和本金不能是负数），并且保存时必须带版本号，防止不同设备同时改同一份数据互相覆盖。
- 修复会话存储初始化：之前登录会话可能在Redis还没连上时就挂上了一个不可用的存储；现在改为等Redis真正连上后才启用，生产环境如果要求用Redis却连不上会直接启动失败，而不是悄悄降级成不安全状态。
- 仓库卫生：删除了误生成的临时文件、更新了说明文档（数据已改用PostgreSQL数据库存储）、并补充了忽略规则避免敏感文件被提交。
- 登录与注册更安全：密码比对改用防时序攻击的方式，避免被推断；登录成功后会重置登录会话、防止他人借旧会话冒用；账号不存在和密码错误统一提示，不暴露究竟是哪一个错了。注册时对用户名和密码加了长度和字符限制并统一编码；要求邮箱验证时若邮件服务不可用就直接拒绝注册，不再偷偷放行。
- 行情刷新更稳：多个请求同时触发刷新时，同一个任务只向上游请求一次（之前各打各的、容易把数据源打爆）；上游临时失败时短时间内不再反复重试，避免失败风暴反复打穿。
- 生产环境报错脱敏：服务器内部错误（如数据库报错）不再直接返回给浏览器，避免泄露内部信息；代理信任改为可开关（默认只信任一层、直连部署可关闭）；登录失败记录、注册来源记录、限流计数等内存数据加了自动过期清理，不会无限增长占用内存。
- 上传图片校验加强：除文件后缀外还会检查文件真实内容，伪造图片后缀的恶意文件被拦下；请求体上限同步提到15MB，避免10MB图片编码后超限被拒。扫码上传的二维码生成与图片上传接口都加了访问频率限制；同一用户同时只保留一个上传入口、全局数量设上限，避免多张大图长期占服务器内存。AI 识别模型改为服务端白名单，客户端无法再指定任意昂贵模型。
- 安全加固·Git 历史清密：之前提交进 Git 的历史记录里含有数据库密码和服务器密码，已用工具把全部提交历史中的这些密码字符串抹除并重写历史；这些密码现在只存在于运行环境变量中，任何历史版本都不再包含它们。

## 2026-07-15
- 打新日历「进展公告日」修正：不再误把申购日之后的「发行结果公告日」当进展公告日，改为展示当前所处阶段真实日期（上市日 / 申购日 / 发行公告日）。
- 可转债历史表优化：方案进展只显示当前所处一个阶段；去掉「类型」列；「首日涨幅」改名「上市涨幅」。
- 评级、股东配售率、网上上限：仅发行结果公告发布后显示真实值；评级缺口大幅回补。
- 发行规模单位归一：统一折算为亿元（浦发转债 500亿、南芯发债约 15.87亿）。
- 配售10张所需股数修正：改为「1000 ÷ 每股配售(元)」。
- 新股中签率精确化：173 只非北交所从巨潮《发行结果公告》PDF 精确抓取（如托伦斯 0.0152610521%），北交所 79 只保持原值。
- 可转债上市涨幅预测增强：新增发行规模折扣档位（≥300亿 −18% / ≥100亿 −10% / ≥50亿 −5%），预测由单点改为区间带。
- 测试守护：新增可转债预测逻辑回归测试与前端 ipo.js 纯函数测试，全部通过。
- 线上打新日历/打新建议修复：服务器此前未建 `ipo_reports` 表（由每日日报写入打新日历 calendar 与打新建议 md 的「结论」段），导致两模块为空；已在服务器建表并同步本地最新报告（含 07-14~07-20 排期），并补充 `generate_server_ipo_reports_sync.py` 与 deploy 同步步骤纳入后续部署流程。
- 可转债流通规模解析修复：①上市公告书「前十名持有人」表持有数量单位为「手」时（1手=10张）原按「张」计，控股股东配售量缩 10 倍、流通规模失真（如宝钛转债）；现按表头「持有数量（手）」检测并 ×10 折算为张。②收紧 `_extract_controller_names` 正则：原 `(有限|咨询|投资|合伙)` 会命中 ETF/指数基金（名称含"投资"）误判为控股股东一致行动人混入限售计算；现排除名称含 基金/ETF/指数/资管/公募/私募 的财务投资主体。新增 `test_unit_fixes.py` 回归测试覆盖两处修复。

## 2026-07-13

### 新增：平台管理后台（用户 / 券商 / 定时任务 / 公告 / 版本 / 休市 / 审计）
- **变更**：新增 `public/admin.html` + `public/js/admin.js` 控制台页（左侧菜单 9 视图：概览/用户/券商/定时任务/公告/版本记录/休市日历/全局参数/审计），`server/routes/admin.js` 统一 `/api/admin/*` 前缀并全路由 `requireAdmin` 守卫；`server/middleware/auth.js` 新增异步 `requireAdmin`（数据库 role=admin 或 `ADMIN_USERS` 白名单双认）；`server/db.js` 加 `users` 表 role/status 列及用户/券商/公告/版本/休市/参数/审计全套读写函数；`server/app.js` 启动 `ensureAdmin()` 建管理员并挂载 admin 路由。
- **文件**：`public/admin.html`(新)、`public/js/admin.js`(新)、`server/routes/admin.js`(新)、`server/middleware/auth.js`、`server/db.js`、`server/app.js`、`server/middleware/security.js`、`public/login.html`。

### 新增：券商导入数量单位（手 / 张）可配
- **变更**：`brokers` 表加 `import_unit` 列（默认 sheet=张，华泰 lot=手），种子随写入；`core-trade.js` 的 `normalizeQuantity`/`updateQtyHint` 与 `enter_trade.js` 由「硬编码华泰/招商」改为读取券商 `import_unit`；`server/routes/accounts.js` 的 `/data` 经 JOIN 回传 `_brokerImportUnit`，保留「仅上交所债券 ×10 转张」正确性。
- **文件**：`server/db.js`、`server/routes/accounts.js`、`server/routes/admin.js`、`public/shared/core-trade.js`、`enter_trade.js`、`public/js/admin.js`、`public/shared/style.css`。

### 取消：平台级统一费率配置
- **根因**：费率实为「每账户各自设置」，平台统一配置层多余且易混淆。
- **修复**：删除后台费率菜单/视图、`/api/admin/fees`、`/api/admin/fees-config`、`/api/admin/fees/:group`，`db.js` 的 `getPlatformFeeSettings`/`upsertPlatformFee` 与 `fee_settings` 建表、`core-fees.js` 平台费率拉取；保留各账户独立费率设置（不受影响）。
- **文件**：`public/admin.html`、`public/js/admin.js`、`server/routes/admin.js`、`server/db.js`、`public/shared/core-fees.js`、`test-admin.js`。

### 优化：定时任务说明 + 休市日历改日历视图 + 全局参数样式
- **变更**：`renderJobs` 增加自动/手动任务中文说明卡片；`renderHolidays` 由 chip 列表改为 12 月网格日历（周末置灰、休市日高亮、点格增删）；`renderSettings` 重写布局（避开全局 `.form-group input{width:100%}` 冲突，checkbox 固定 18×18 左对齐）；`style.css` 补 `.form-group{margin-bottom:14px}` + `.job-help` + `.cal-*` 日历样式。
- **文件**：`public/js/admin.js`、`public/shared/style.css`。

### 修复：登录后回跳后台地址
- **根因**：`login.html` 登录成功硬编码跳前台 `/`，访问后台被踢登录后又回前台。
- **修复**：`security.js` 未登录访问 `/admin.html` 跳 `/login.html?redirect=/admin.html`；`login.html` 登录/注册成功读 `?redirect` 回跳；`admin.js` 未登录带 redirect。
- **文件**：`server/middleware/security.js`、`public/login.html`、`public/js/admin.js`。

### 数据：休市日历按交易所官方日历校正
- **变更**：经 Tushare `trade_cal`（SSE）实时重拉 2026 年法定休市日，与本地 `holidays.json` 逐项一致（19 天），确认无偏差；仅改本机文件，未动 git。
- **文件**：`server/config/holidays.json`。

## 2026-07-12

### 新增：个人中心（头像 / 昵称 / 简介 / 改密码）
- **变更**：`users` 表幂等补齐 `nickname/bio/avatar/email/last_login` 五列；新增 `server/routes/profile.js`（`GET /api/profile` 含账户列表、`PUT /api/profile` 头像≤300KB 且须 `data:image/` 前缀、昵称≤30、简介≤200、`POST /api/profile/password`），`server/db.js` 导出 `getUserProfile/updateUserProfile/changePassword/updateLastLogin`；`server/routes/auth.js` 登录后写 `last_login`、`/api/me` 返回 nickname/avatar、注册写 email；`server/app.js` 挂载 profile 路由。前端新增个人中心页：头像用 canvas 裁 256×256 JPEG 0.82 上传、昵称/简介编辑、密码独立折叠卡片、退出登录按钮。
- **文件**：`server/db.js`、`server/routes/profile.js`(新)、`server/routes/auth.js`、`server/app.js`、`public/index.html`、`public/shared/style.css`、`public/shared/core-account.js`。

### 新增：顶层多页导航（首页 / 持仓管理 / 个人中心 / 版本记录）
- **变更**：`public/index.html` 顶部改一级导航 `.main-tab`（首页/持仓管理/个人中心/版本记录），原来持仓管理的 5 个 tab 降为 `#main-holdings` 内的二级 `.sub-nav`（总览/持仓/收益/交易），版本记录 tab 从二级上移到一级；首页改为「投资小站」介绍页；一级导航全宽、二级栏吸顶且全宽铺满、实色中靛蓝与一级深蓝区分层级；账户切换/设置保留在二级栏右侧，退出登录移到个人中心。
- **文件**：`public/index.html`、`public/shared/style.css`、`public/shared/core-trade.js`（费率弹窗当前账户展示改读全局变量）。

### 修复：改密码接口 500 + 测试清理外键冲突（回归测试抓出）
- **根因**：`POST /api/profile/password` 用 `getUserProfile()`（SELECT 不含 password 列）取密码校验，导致 undefined 报错；测试清理先删 users 触发 accounts 外键约束。
- **修复**：password 路由改 `loadUsers()` 取 `user.password`；测试清理改为先删 accounts 再删 users。新增 `test-profile.js` 覆盖个人中心 14 项（资料字段/保存持久化/校验/改密码/未登录 401），与基线 test.js(25)、test-regression.js(27) 共 66 项全绿。
- **文件**：`server/routes/profile.js`、`test-profile.js`(新)。

### 新增：券商字典 + 账户管理券商选择
- **变更**：`server/db.js` 新增券商字典表（code/name/market/sort_order）+ 内置 44 家 A股券商种子，随 `initSchema` 自动建表与首次播种；导出 `loadBrokers(market)`/`getAccountBrokers(username)`/`updateAccountBroker(username,name,broker)`/`isValidBroker(code)`。`server/routes/accounts.js` 新增 `GET /api/brokers`、`GET /api/accounts/broker`、`PUT /api/accounts/broker`。前端账户管理弹窗改为「我的账户 / 添加重命名」双分区，添加/重命名由 `renderAccountForm()` 动态三态渲染（空闲/新建/重命名），券商下拉从接口拉取；账户卡片点击委托 `switchAccount` 切换。
- **文件**：`server/db.js`、`server/routes/accounts.js`、`public/shared/core-account.js`、`public/index.html`、`public/shared/style.css`。

### 修复：收益页 Excel 导入日期乱码（+046207-12）
- **根因**：`server/routes/import.js` 调 `sheet_to_json` 未加 `cellDates: true`，日期序列号被序列化为文本；前端 `normalizeDate` 仅覆盖少数格式，对 mangled 文本无兜底。
- **修复**：两处 `sheet_to_json` 加 `cellDates: true`；`public/shared/core-earnings.js` 的 `normalizeDate` 全面重写，覆盖 Date 对象 / Excel 序列号 / 8位 / ISO / 斜杠 / 点 / 中文 / mangled 文本等 12+ 格式，非法输入不崩溃。
- **文件**：`server/routes/import.js`、`public/shared/core-earnings.js`、`public/js/utils.js`。

### 修复：validate.js 校验过严导致导入保存失败
- **根因**：`totalAsset == null` 被当成非法、`nav <= 0` 误杀净值基准 0、ISO 带时分秒的日期被正则拒。
- **修复**：`totalAsset` 加 `!= null` 前置；`nav` 阈值改 `< 0`；日期正则兼容 `T..Z` 后缀。负数净值仍拦截。
- **文件**：`server/middleware/validate.js`。

### 修复：nav_history 重复键 500（唯一约束冲突）
- **根因**：`saveAccountData` 对净值历史纯 `INSERT`，同一天两条记录撞主键抛 500。
- **修复**：改为 `INSERT ... ON CONFLICT (username,account_name,date) DO UPDATE`，幂等 upsert；同日期重复写入自动折叠/更新。
- **文件**：`server/db.js`。

### 修复：导入后总览收益走势对比图为空
- **根因**：切到 dashboard 时 `initNav()` 未触发重绘。
- **修复**：`initNav()` 切 dashboard 补 `renderReturnsChart()` 调用。
- **文件**：`public/shared/core-earnings.js`。

### 新增：交易费用引擎（六类费率 + 账户级覆盖）
- **变更**：新增 `public/shared/core-fees.js` 作为费用计算单一真相源，含 `DEFAULT_FEE_SETTINGS`（A股股票/可转债/基金ETF/港股/美股/场外基金六组）与 `calcTradeFees(direction,amount,subtype)`（佣金、印花税、过户费、其他费）。`trades` 表幂等新增四费列；`enter_trade.js` 经 eval 载入引擎算费并落库；前端录入/现金重算与后端 `loadAccountData` 一致（买入扣额+费、卖出加额-费）；账户可在税费设置弹窗覆盖费率。
- **文件**：`public/shared/core-fees.js`(新)、`server/db.js`、`enter_trade.js`、`public/shared/core-trade.js`、`public/shared/core-tables.js`、`public/shared/core-quote.js`、`public/shared/core-returns.js`。

### 优化：休市日 + 定时任务健壮性 + 每年自动核对
- **变更**：新增 `server/config/holidays.js`（loadHolidays 当日缓存 / isCnHoliday / getCoveredYear / saveHolidays）+ `server/config/holidays.json`（2026 全年 19 天，剔除周末）。`server/jobs/holidaySync.js` 的 `ensureHolidaysCurrent()` 本地短路（覆盖年份≥今年且 30 天内已核对则跳过联网）、否则调 Tushare trade_cal 重写 json（仅写本机文件、零部署、不碰 git/不重启）、12 月预拉明年、联网失败保留旧 json + 告警。`server/jobs/marketClose.js` 重写：去除静默 catch、失败重试 2 次/1s、聚合记录、真写失败落 `job_runs`、交易日判定升级为「工作日 && !isCnHoliday」、回看最近 6 交易日补记漏抓收盘价（幂等）。`server/worker.js` 启动跑 `ensureHolidaysCurrent` + `backfillMissingCloses`，每月定时核对休市日。新增 `server/jobs/replayNav.js`：晚录入交易（交易日在录入日前）用 daily_prices 重放 trades 重算历史净值，Tushare 历史收盘回补缺口日（拉不到的缺口日跳过，不近似）。`server/services/market.js` 暴露 Tushare 历史查询供回补。`server/middleware/errorHandler.js` 500 改为暴露真实错误便于定位。
- **文件**：`server/config/holidays.js`(新)、`server/config/holidays.json`(新)、`server/jobs/holidaySync.js`(新)、`server/jobs/replayNav.js`(新)、`server/jobs/marketClose.js`、`server/worker.js`、`server/services/market.js`、`server/middleware/errorHandler.js`。

### 修复：持仓成本强制 ≥0 误拒合法负成本（导入交易失败）
- **根因**：安全整改期间在 `server/middleware/validate.js` 新增「持仓成本必须 ≥ 0」校验。但反复做T、成本摊薄后的持仓成本可合法为负（如港股江西铜业股份），触发该规则的账户任何保存（含 AI 导入交易记录的 `PUT /api/data`）都会被 400「数据校验失败」整包拒绝。
- **修复**：移除 `validate.js` 中 `cost >= 0` 强制校验，仅保留「cost 为有限数字」的类型检查（非数字/NaN 仍拦截）；`price` 仍要求 ≥ 0（市价不可能为负）。同步移除 `import_positions.py` 将负成本归零的逻辑，保留原始成本值。
- **文件**：`server/middleware/validate.js`、`import_positions.py`。

## 2026-07-11

### 安全整改：P0/P1/P2 全批次落地
- **变更**：
  - P0：扫码上传 token 改为「图片已上传且属于当前登录用户」才能消费并删除，未上传只返回空、不提前作废；服务端对所有用户文本字段（账户名、记录ID、日期、类型、子类型、备注等）做白名单校验，拒绝含 HTML/脚本元字符的内容；前端移除内联 `onclick`，改用 `data-*` 属性 + 统一事件委托分发。
  - P1：生产环境未配会话存储时打印明确告警；Excel/图片导入加 MIME、大小、sheet/行/列/单元格上限与 AI 输入截断；数据保存加乐观锁版本号（冲突返回 409）；数据迁移接口收敛为管理员专属；新增安全单测（45 项）。
  - P2：金额/数量/净值等改用 `numeric` 高精度存储并四舍五入；新增 `accounts` 结构化表作为账户列表权威源（JSON 兜底保留）；任务调度（收盘记价/指数基线）支持独立 worker 进程（咨询锁 + `job_runs` 表）；统一错误处理、`/health` 与 `/ready` 探针、优雅停机；CSP 收紧（`base-uri`/`form-action 'self'`）。
- **文件**：`server/services/vision.js`、`server/routes/import.js`、`server/middleware/validate.js`、`server/routes/accounts.js`、`server/db.js`、`server/app.js`、`server/worker.js`（新）、`server/jobs/marketClose.js`、`server/jobs/indexBaseline.js`、`server/middleware/errorHandler.js`、`server/middleware/security.js`、`server/config.js`、`test-security.js`、`test-integration.js`（新）、`package.json`、`.github/workflows/ci.yml`。

### 修复：Redis 会话持久化（connect-redis v7 兼容性）
- **根因**：`server/config.js` 使用 `require('connect-redis')(require('express-session'))`（v6 写法），但依赖为 `connect-redis@^7`，v7 改为对象导出（`connectRedis.default`），旧写法立即调用抛「require(...) is not a function」，被 try/catch 捕获后退回内存存储，导致配了 `REDIS_URL` 仍 `redis:false`。本地未配 `REDIS_URL` 一直走降级分支，故此前未暴露。
- **修复**：改为 `const connectRedis = require('connect-redis'); const RedisStore = connectRedis.default || connectRedis;` 并 `new RedisStore({ client, prefix })`。服务器安装 redis-server 并写入 `REDIS_URL` 后，`/ready` 返回 `redis:true`，重启不再丢失登录态。
- **文件**：`server/config.js`。

## 2026-07-10

### 改版：收益页与真实持仓打通
- **变更**：
  - 收益页卡片 / 走势图 / 明细表改由真实持仓自动算出的净值序列（`navHistory` + `calcSummary`）驱动，与总览页「收益走势对比」完全一致；不再依赖手工填的《投资实验记录》。
  - 明细表新增「本周涨跌」列（以周一为一周起点，涨红跌绿）。
  - 「导入 Excel」改名为「导入历史数据」：升级为云端大模型识别（不同表头自适应），缺日期/净值的行自动跳过、其余照常导入；导入日期与线上记录重叠时弹框确认「导入覆盖线上」或「线上覆盖导入」。
  - 指数对比线数据从账户 JSON 大字段拆出，独立成 `index_history` 表（`nav_history` 同时新增 `invested` 列），刷新行情只增量 upsert，消除 JSON 读写放大。
  - 原 `/api/import-fund-record` 删除，新增 `/api/excel-history-parse`（大模型识别）、`POST /api/index-history`（指数点入库）。
- **文件**：`public/index.html`、`public/shared/core.js`、`server.js`（接口替换）、`server/db.js`（新表/新列/读写）。

### 改版：持仓 tab 改为收益（投资实验记录）
- **变更**：
  - 顶部导航「持仓」改名为「收益」，原持仓列表页删除（总览里已能看持仓明细前 10，持仓管理功能整体下线：新增/编辑/删除持仓、现金编辑、筛选排序一并移除）。
  - 新增「收益」页，展示《投资实验记录》Excel：顶部 6 张指标卡片（总市值、净值、总收益率、年化收益、当前回撤、最大回撤），中间「资产与收益走势」折线图（总市值 vs 投入本金），下方完整明细表。
  - 收益页支持「导入 Excel」：服务端 `/api/import-fund-record` 解析《投资实验记录》表，按表头（时间/当前总市值/当前净值/总收益率/年化收益/回撤等）映射为结构化记录，存入账户数据 `fundRecord`，前端渲染。
- **文件**：`public/index.html`、`public/shared/core.js`、`server.js`（新增接口）、`server/db.js`（loadAccountData 回读 fundRecord）。

## 2026-07-09

### 修复：手机扫码上传无法选相册
- **根因**：`server.js` 内嵌的手机上传页 `mobileUploadHtml()` 中 `<input type="file" accept="image/*" capture="environment">` 带了 `capture="environment"`，强制调起摄像头，iOS/部分安卓无法选相册。
- **修复**：去掉 `capture="environment"` 属性。`accept="image/*"` 不带 capture 时，iOS 弹「拍照或选照片」、安卓 Chrome 提供拍照/相册选择，同时保留拍照能力。

### 优化：网站图标换成股市上涨主题
- **变更**：`public/favicon.svg` 改为深蓝底 + 红色上涨 K 线 + 黄色上升箭头（A 股红涨惯例）。
- **引用**：在 `public/index.html` 和 `public/login.html` 的 `<head>` 中加入 `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`，使浏览器正确加载新图标。

### 重构：合并 Excel/图片导入入口，统一识别交易与持仓
- **变更**：
  - 前端「录入交易」区由 4 个标签（手动/Excel/持仓/图片）简化为 2 个标签：**手动录入 / 智能导入**。
  - 「智能导入」内同时提供图片上传和 Excel 上传两个入口。
- **后端**：
  - `/api/vision-parse` 和 `/api/excel-parse` 返回统一格式 `{ items: [{ kind: 'trade'|'position', code, name, price, quantity, ... }] }`。
  - LLM 提示词要求同时识别交易记录和持仓记录，并由模型自行判断每行类型。
  - 删除独立的 `/api/excel-positions` 接口（功能已合并）。
- **前端**：
  - `public/shared/core.js` 新增 `doSmartParse(file, source)`、`renderSmartItems()`、`confirmSmartItem(index)`、`confirmAllSmartItems()`。
  - 结果表格混合展示交易行与持仓行，交易行显示日期/方向，持仓行显示为持仓类型。
  - 确认时根据 `kind` 自动调用交易录入或持仓导入逻辑。
  - 粘贴/拖拽/手机扫码上传均统一进入新的智能解析流程。

### 修复：涨跌排序时 0% 排第一
- **根因**：持仓表按「涨跌」排序时，`priceChangeMap[code] || -999` 把 0% 当成缺失数据，导致 0% 被排到最前面。
- **解决**：排序判断改为 `priceChangeMap[code] != null ? ... : -999`，0% 作为有效值参与正常升降序。

### 修复：导入交易名称显示为代码
- **根因**：Excel/图片/持仓导入时，如果解析结果没有名称，保存后交易历史名称列直接显示代码。
- **解决**：
  - `public/shared/core.js` 新增 `ensureName(code, currentName)`：优先取现有持仓中的名称，否则调用行情接口自动获取。
  - 三个导入确认函数（`confirmVisionItem`/`confirmExcelItem`/`confirmPositionItem`）改为 async，确认前自动补全名称。
  - 三个「全部导入」函数同步改为 async 顺序执行。
  - `renderTrades` 增加兜底：若交易名称为空或等于代码，从当前持仓中查找显示名称。

### 优化：AI 解析加载动画
- 图片识别、Excel 导入、持仓导入的解析等待阶段增加转圈 spinner（`.spinner` CSS）。
- 更新 `public/index.html` 三个 loading 容器，以及 `public/shared/core.js` 中动态设置 loading 文本的逻辑，使 spinner 和文字同时显示。

### 修复：导入证券代码前导 0 被删除
- **根因**：券商 Excel 把代码存为数字，`xlsx` 读取后 000001 变成 1，LLM 返回短代码，前端保存时丢失前导零。
- **解决**：
  - `public/js/code-classify.js` 新增 `classifyCode.normalizeCode(code)`：A股/基金/可转债/信用债等数字代码统一补 6 位，港股补 5 位，美股不变。
  - 后端 `/api/excel-parse`、`/api/excel-positions` 解析 LLM 结果后统一调用 `normalizeCode` 恢复代码。
  - 前端所有录入入口（手动交易、快速添加、持仓编辑、Excel/图片/持仓导入确认）统一在保存前调用 `classifyCode.normalizeCode`。
  - LLM 提示词中明确强调证券代码作为字符串返回并保留前导零。

### 新增：Excel 导入持仓表（大模型解析）
- **前端**：交易录入区新增「持仓导入」标签页，支持上传券商导出的 `.xlsx`/`.xls`/`.csv` 持仓表。
- **后端**：新增 `POST /api/excel-positions`，用 `xlsx` 读取首工作表后调用 LLM 解析，返回 `positions` 数组（`code/name/quantity/price`）。
- **交互**：解析结果展示可编辑表格，支持单条「确认导入」和「✅ 全部导入」；已存在的证券代码会更新持仓（价格/数量），不存在则追加；导入持仓不影响交易记录和现金。

### 新增：Excel 导入交易明细（大模型解析）
- **前端**：交易录入区新增「Excel导入」标签页，支持上传 `.xlsx`/`.xls`/`.csv`。
- **后端**：新增 `POST /api/excel-parse`，用 `xlsx` 读取首工作表后调用 LLM 解析，返回与图片识别一致的 `trades` 数组（含可选 `date` 交易日期）。
- **交互**：Excel 解析结果展示可编辑表格，支持单条「确认录入」和「✅ 全部录入」；Excel 行带日期输入框，可覆盖默认当天。

### 优化：图片识别增加「全部录入」
- 图片识别结果区增加「✅ 全部录入」按钮，避免逐条点击。

## 📌 本地验证进度索引（2026-07-08）

> 配套详情（环境限制、三套本地起 PG 方案、连库验证命令）：`deploy/本地验证交接文档.md`。

| 验证级别 | 状态 | 关键结论 | 阻塞点 |
|---------|------|---------|-------|
| **加载级**（依赖安装 + 模块加载） | ✅ 已通过 | `npm install` 装 `pg@8.22.0`；`better-sqlite3` 彻底移除（0 残留原生模块）；`server/db.js` 加载正常、11 项导出齐全 | 无 |
| **连库级**（建表 + 读写联调） | ✅ 已通过（2026-07-08 本机 agent 环境实跑） | `initSchema()` 六表在 `portfolio` 库创建成功；`enter_trade.js` 第40行 `await` 修复生效；现金自动重算正确（买入 100×100 → 现金 -10000）；`positions`/`trades` 真写入 PG 已抽查确认 | 无 |

**下一步**：连库验证已全部通过，代码可进入部署。本机 agent 环境已实跑（方案 A 起 PG，踩坑见下方注），无需再等外部 PG 实例。

> **连库验证实跑注记（2026-07-08）**：本 agent 环境成功按方案 A 起 PG（EDB 二进制 zip 16.4）。关键坑：
> 1. 原生 `curl`/`*.exe` **只认 Windows 原生路径**（`C:/...`），不认 POSIX（`/c/...`），否则"找不到路径/写不出文件"。
> 2. `pg_ctl` 的 `-l` 日志参数也必须用 Windows 路径，否则报"系统找不到指定的路径"导致启动失败。
> 3. **前台/后台命令结束时 server 会被回收**，且 Windows 共享内存段不随进程死亡释放，导致下次启动报"已存在的共享内存块仍在使用中"。解法：验证必须在**同一条命令内** `start → 建库 → initSchema → enter_trade → 查询 → stop` 自包含跑完；命令开头 `taskkill /F /IM postgres.exe` 清残留共享内存。
> 4. `db.js` 默认库为 `portfolio`（`PGDATABASE || 'portfolio'`），**不要**把 `PGDATABASE` 设成 `postgres`，否则表建错库。

---

## 📌 部署配置状态（2026-07-08，已就绪）

> 全套部署物料已生成并修正，可直接用于腾讯云 CVM（Nginx + pm2 + PostgreSQL / 或 Docker）。详见 `deploy/部署说明.md`。

| 配置项 | 文件 | 状态 | 说明 |
|--------|------|------|------|
| 环境变量模板 | `deploy/.env.example` | ✅ | 含 `DATABASE_URL`/`PG*` + `SECRET`/`ALLOWED_ORIGIN`/`REGISTER_CODE` |
| Nginx 反代 + HTTPS | `deploy/nginx-portfolio.conf` | ✅ | 80→443 跳转 + 反代 3000 + 免费SSL + HSTS |
| pm2 守护 | `deploy/ecosystem.config.js` | ✅ | fork 单实例（PG 单进程策略） |
| 部署文档 | `deploy/部署说明.md` | ✅ | 买 CVM→装 Node22/PG/Nginx/pm2→上传→配 .env→反代→pm2→安全组→备份 |
| Docker（可选） | `Dockerfile` + `docker-compose.yml` | ✅ | node22-alpine + postgres:16-alpine 一键起 |
| Python 导入依赖 | `requirements.txt` | ✅ | `psycopg2-binary`（import_positions.py 用） |

**本次关键修正（部署阻断点）**：
1. **接入 dotenv**（`server/db.js` 顶部 `require('dotenv').config()` + `package.json` 加 `dotenv`）：修复"部署后 `.env` 不生效、PG 连不上"的致命缺口——原 `部署说明.md` 误称"pm2 自动读 .env"，但 Node 默认不读 `.env`。
2. `部署说明.md` 删除已失效的"SQLite 数据迁移"小节（迁移脚本与 `portfolio.db` 已于「全清」时删）；`better-sqlite3` 过时措辞改为通用"原生模块"；补 dotenv 说明。
3. `ecosystem.config.js` 注释修正为"应用通过 dotenv 读取项目根 .env"。

> **安全提醒**：`.env` 含密码/连接串，已被 `.gitignore` 忽略，绝不入库。云 PG 请用专用账号（`portfolio_user`）+ 强密码 + `PGSSL=true`。

---

## 2026-07-08

### PostgreSQL 存储改造（已完成，2026-07-08 补齐收尾）
- **决策**：用户 2026-07-08 决定将存储从 SQLite(better-sqlite3) 改为 PostgreSQL（计划开放给几十人使用，用户主动选择）。
- **已完成（核心）**：`server/db.js` 完全重写为 PG 异步数据层（`pg` Pool，新增 `initSchema()` 自动建表）；`server.js` 路由全加 async/await + asyncHandler 包装，启动前 await 建表；`enter_trade.js` 的 `main()`/`saveAccountData` 已改异步。
- **已完成（收尾，2026-07-08 补齐）**：`enter_trade.js` 第40行补 `await`；`package.json` 换依赖（删 better-sqlite3、加 `pg`）；`import_positions.py` 改用 `psycopg2` 走环境变量连接、upsert 写 `account_data`（解析逻辑不变）；`deploy/.env.example` 增加 `DATABASE_URL`/`PG*` 连接变量；`deploy/部署说明.md` 增加 PG 安装/建库/建用户与 `pg_dump` 备份步骤；`Dockerfile` 升级 node22 并去除原生编译；新增 `requirements.txt`(`psycopg2-binary`)、`migrate_sqlite_to_pg.py`(旧 SQLite→PG 迁移)、`docker-compose.yml`(可选一键起 PG)。
- **状态**：代码已可部署。部署前需 `npm install`（装 pg）+ 配置 PG 连接（`DATABASE_URL` 或 `PG*`）。详见 `deploy/PostgreSQL改造交接文档.md` 与 `deploy/部署说明.md`。

### 本地验证（加载级已通过，连库验证待起 PG 实例）
- **加载级（已通过）**：`npm install` 装 `pg@8.22.0`、`better-sqlite3` 彻底移除（0 残留原生模块）；`server/db.js` 加载正常，关键导出齐全（initSchema / saveAccountData / loadAccountData / pool 等）。
- **连库级（待执行）**：本 agent 环境为**标准用户** + PowerShell 工具 stdout 不回传 + Bash 调 `powershell.exe` 被安全拦截，无法自动安装启动 PG；已探明**本机 VC++ 运行库齐全**、EDB 二进制 zip 免装方案可行，给出三套本地起 PG 方案与连库验证命令。详见 `deploy/本地验证交接文档.md`。

### 部署可选优化（时区 + 子目录）
- **时区统一东八区**：新增 `utils.todayCN()`，前端所有业务日期（净值/交易/现金流/导出文件名）及 `enter_trade.js` 交易日期、服务端 K 线起止日，均改用北京时间，避免服务器非东八区时净值日期差一天。
- **支持子目录部署**：新增 `BASE_URL`（`index.html`/`login.html` 的 `<meta name="base-url">` 配置）+ `api()` 封装；所有 `fetch('/api/...')` 与登录后跳转均加前缀；静态资源改为相对路径。根目录部署 `content=""` 即可；子目录部署如 `/portfolio` 需配合 Nginx `location /portfolio/ { proxy_pass http://127.0.0.1:3000/; }`。

### 手机扫码上传图片（AI视觉识别）
- 图片识别区改为左右布局：左边上传框（拖拽/点击上传），右边直接显示二维码
- 切换到"图片识别"模式自动生成二维码，切换到"手动录入"自动停止轮询
- 服务端用 `qrcode` 包生成二维码 base64（避免外部 API 不稳定）
- 手机扫码后打开上传页（免登录），拍照/选图 → 电脑端自动接收 → AI 识别
- 手机上传页使用 `capture="environment"` 直接调起相机
- Token 5 分钟过期，in-memory 存储，定期清理

### 部署配置
- 安装 `qrcode` npm 依赖（服务端二维码生成）
- CSS 缓存戳 `?v=N` 机制，避免浏览器缓旧样式

### 故障修复
- **CSS 解析失败修复**：`.trade-mode-btn.active` 和 `.trade-mode-btn:hover:not(.active)` 各缺 `}` 闭合大括号，导致后续所有 vision-row 等样式全部失效（旧代码遗留问题）
- **招商证券数据修复**：迁移到 PostgreSQL 时两账户 `account_data.data` 被写入相同内容，手动清空招商证券账户数据，华泰账户保留

## 2026-07-06

### 按核查报告.md 修复（代码核查 + 分类逻辑收敛）
- **P0 静默丢数据**: `core.js confirmDelete` 删除"删持仓连带过滤删交易"那行 → 删持仓保留交易流水（交易用于净值计算）。
- **P1 收益图指数开关失效**: 4个对比指数按钮改为中文键 `toggleIndex('沪深300'…)` + `class-index-toggle` + `data-idx`，与 `indexVisibility`/数据集 label 对齐，点击可正常隐藏/显示。
- **P1 区间高亮失效**: 5个区间按钮补 `data-days`；`switchPeriod` 只清 `.period-btn[data-days]` 的 active（不再误清指数按钮高亮）。
- **P2 亏损负号**: `renderReturnsStats` 亏损金额显示 `-` 号。
- **清理死代码**: 删 `index.html exportExcel()`（与 core.js `exportToExcel` 重复且未调用）；删 `index.html` 重复的 `initAutoRefresh()` 调用。
- **归档失效脚本**: `calc_cash.py`/`fix_currency.py`/`fix_hk_prices.py`/`fix_qty.py`/`fix_rate.py` + `data/json_backup_*` 移到 `_deprecated/`（仍写迁移前旧JSON，已失效）；保留 `import_positions.py`；活代码 HK 汇率统一 0.868。
- **分类逻辑收敛为单一函数（前后端共用）**: 新建 `public/js/code-classify.js`（UMD，浏览器全局+Node require）。`recognizeCode`/`fetchQuoteByCode`/`inferSubtype` 全部委托它；删除死代码 `getSecId`。消除 4 处前缀规则漂移。

## 2026-06-27

### 嘉实原油LOF(160723)价格系数修复
- **根因**: "16"开头LOF基金（160723）的价格因子缺失。东方财富API返回 f43=1715（千分位计价），但 `fetchQuoteByCode` 中 factor 判断未覆盖，用了 factor=100 得到错误价格 17.15。
- **修复1**（16:33）: 补加 `p2 === '16'` 条件。
- **修复2**（16:50）: **全面重构 factor 逻辑**，改为"默认1000，仅A股股票用100"的排除法。
- **数据库**: 160723 价格已从 17.15 更新为 1.715。
- **正确价格**: 1.715 / 涨跌幅 +1.48% / 市值 24,010.00。

### 🚨 价格系数规则（全面版，务必遵守）
**东方财富API价格系数原则**：
- **A股股票**（00/30/60/68开头，以及4/8开头的新三板/北交所）→ **factor=100**（分，2位小数）
- **其他所有品种**（LOF基金、ETF、REITs、可转债、QDII基金等）→ **factor=1000**（厘，3位小数）

代码实现：`server.js fetchQuoteByCode()` 中反转逻辑，默认 factor=1000，
仅对A股股票前缀（00/30/60/68/4/8开头）降为 factor=100。
以后新增任何非股票品种（无论什么代码前缀）都不会遗漏。

### 格式约定（重要，后续改代码注意）
- **数量**: 按 1 万加逗号（4位分组），不是标准千分位。例如 14000 → `1,4000`。
- **价格**: `toFixed(3)` 保留3位小数。例如 1.715 → `¥1.715`。
- **市值/金额**: `fmt()` 函数，带¥前缀，4位万位分组，2位小数。

### 🚨 港股价格与汇率（务必遵守）
- **数据库港股 price 字段存的是港币**，不是人民币。
- 计算港股持仓市值人民币值时，必须乘 `hkRate`（当前 0.868）。
- 前端 `getMarketValue()` 已处理此逻辑，后端/脚本计算时要注意。
- **现金已更新**: 现金 = 1,216,588.96，总资产 = 2,464,604.74。

### 🚨 港股代码规则（系统级别）
- **港股代码固定5位**，必须保留前导0。例如 570 → `00570`，152 → `00152`。
- **禁止**去除或缩减前导0（以前的做法是去掉前导0，已作废）。
- `import_positions.py` 中 `parse_hk_shares()` 已增加 `code.zfill(5)`。
- 两个账户的港股代码均已修正：华泰19只、招商16只。

---

### 交易时间感知
- 新增 `isMarketOpen()` 到 `public/js/utils.js`。
- A股: 9:30-11:30 / 13:00-15:00。
- 港股: 9:30-12:00 / 13:00-16:00。
- 混合持仓时，任一市场开盘即视为开盘。

### 架构全面改造
- **数据层重构**: 从 JSON 文件迁移到 SQLite（better-sqlite3），数据库文件 `data/portfolio.db`。
  - 新建表：users、account_data。
  - 新增独立表：positions、trades、nav_history、cash_flows。
  - 启动时自动从旧 JSON 文件迁移数据，旧文件备份到 `data/json_backup_*/`。
- **后端分层**: 数据库代码抽出为 `server/db.js`，server.js 精简为纯路由+中间件（约180行）。
- **前端模块化**: 提取110行工具函数到 `public/js/utils.js`（fmtQty、fmt、recognizeCode、getSecId等）。
- **行情去重**: 移除前端 `fetchTencent()`/`fetchEastMoney()`，行情统一走服务端代理。
- **安全加固**: CSRF 防护，PUT/POST/DELETE 校验 Referer/Origin。
- **新增API**: `/api/hkrate`（港币汇率代理）、`/api/kline`（指数K线代理）。

### 上交所可转债行情Bug修复（此前）
- **根因**: 上交所可转债(11xxxx)的 secid 构造缺少 `1.` 前缀，查不到行情。
- **修复**: secid 构造增加 `code.startsWith('11')` 判断。
- **数据迁移**: 从API重拉全部43只正确价格。
- **附**: 搜特退债404002默认涨跌幅0%。

## 2026-06-26

### 项目初始化
- 从券商导出 CSV 文件导入持仓数据（A股 + 港股通）。
- 支持 `import_positions.py` 导入脚本。
- 初始持仓：43只（17 A股 + 7 可转债 + 19 港股），47笔交易。
- 用户：daicunzai，账户：华泰账户。
