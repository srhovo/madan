# 码单器

> 陪玩团 / 陪玩俱乐部 / 代练团 / 游戏代打 — 陪玩团订单结算、码单、报单工具。纯前端单页应用，无需后端、无需注册，开箱即用，支持网页版与 Android APK 离线使用。

## 这是什么

专为**陪玩团、陪玩团俱乐部、代练工作室、游戏代打团队**设计的订单结算报单码单工具，也可用于日常的**码单、报单、分成计算**。

如果你日常需要：
- 在群里接单、派单、报单，记录陪陪和老板信息
- 手动算团抽成、平台抽成、陪陪到手
- 反复查价格表、算折扣、统计时长
- 把结算结果整理成文本发到群里或存档

码单器帮你**把这一整套流程压缩到几秒钟**：
填好字段 → 点一下 → 自动算好钱 → 自动生成可复制的订单文本。

## 功能一览

### 订单结算
- 录入陪陪、派单、老板、单价、数量 / 时长、备注
- 自动计算：折扣后总价 → 团抽成 → 平台抽成 → 陪陪到手
- 支持自定义分成比例（默认 5/20/75 与 10/20/70 两档）
- 折数输入兼容多种写法，`8` / `80` / `0.8` 均识别为 8 折

### 价格库
- 最多 6 个独立价格库，可按游戏或模式切换
- 每个库支持：
  - **精确单价**：按服务类型直接设定单价
  - **区间规则**：按段位 / 星数 / 名次自动匹配单价，带冲突检测
  - **备注触发加价**：备注里出现关键词自动加金额，可叠加多条规则
  - **礼物名称记忆**：输入礼物名自动联想对应金额
- 旧版单价记忆可自动迁移到新价格库

### 老板记忆
- 自动记忆常用老板昵称、派单、折扣
- 输入时按使用频率、时间、拼音智能排序联想
- 支持锁定老板字段，批量清除订单时保留

### 名字提取
从微信群聊文本中批量提取陪陪名字，三种模式：
- **拍一拍模式**：识别"拍了拍 XXX"
- **@ 模式**：识别 @XXX
- **接龙模式**：识别"1. XXX / 2. XXX"格式
- 内置学习系统：用户纠正过的名字自动保存，下次自动修正
- 自动过滤平台前缀、Emoji、重复名

### 历史与备份
- 自动保存最近 10 条订单，支持一键回填再编辑
- 支持导出 / 导入 JSON 备份，方便换设备迁移
- 所有数据保存在浏览器本地，不上传任何服务器

## 使用方法

### 网页版
直接访问：`https://srhovo.github.io/madan`

### Android APK
将 `index.html` 放入 WebView 容器打包。需开启 DOM Storage 以支持本地持久化：

```kotlin
webView.settings.domStorageEnabled = true
webView.loadUrl("file:///android_asset/index.html")
```

## 技术操作与设计要点

### 单文件架构
整个应用是一个 `index.html`，HTML / CSS / JS 全部内联，无外部依赖：
- 首屏只需一个请求，加载即可用
- 适合 GitHub Pages 直出与 WebView 离线打包
- 无构建工具、无 npm install、无版本锁定

### 分层设计
虽为单文件，但内部严格分层：

| 层 | 职责 | 说明 |
|---|---|---|
| **Engine 层** | 纯计算 | `OrderEngine`、`PriceRuleEngine`、`SurchargeRuleEngine`、`ProjectSettlementEngine` 等，无 DOM 操作、无副作用，可独立测试 |
| **Storage 层** | 持久化 | `UltimateStorageManager` 统一封装 localStorage / cookie / memory 三级降级，重要数据写入后回读校验 |
| **Feature 层** | UI 交互 | 各 Feature 类负责绑定事件、渲染列表、协调 Engine 与 Store |
| **UI 组件层** | 基础组件 | `UiModal` / `UiToast` / `UiConfirm` / `UiButton` 等可复用组件 |

### 存储健壮性
- 三级降级兜底：localStorage → cookie → 内存，任一可用即不丢数据
- 写入后回读校验：`setPersistent` 写完立即读回比对，不一致视为失败
- 配额检测：捕获 `QuotaExceededError`，提示用户导出备份并清理
- Schema 迁移：多版本数据模型带版本号，升级时自动迁移老数据

### 名字提取引擎
- 多模式正则匹配：拍一拍 / @ 提及 / 接龙
- 学习数据持久化：纠正过的名字与确认过的名字分别存储，逐次自改善
- 预处理滤除平台前缀、Emoji、重复项

### 懒加载
非首屏功能（数据备份、时长计算器）以内联 chunk 形式存储，通过 `requestIdleCallback` 在浏览器空闲时加载，不阻塞首屏渲染。

### 安全性
- 不使用 `eval` 执行动态代码，懒加载 chunk 通过临时 `<script>` 标签注入
- 所有用户输入在渲染时做 HTML 转义
- **业务数据（订单、陪陪名单、老板记忆、价格库等）全部只存在本地，绝不上传**
- 另有独立的匿名使用统计（`analytics.js`）：仅上报本地随机设备 ID、事件类型、
  App 版本号、会话时长、是否主屏幕 App，不读取任何业务数据；失败静默降级，不影响使用

## 适用场景

- 陪玩团接单结算
- 代练工作室订单管理
- 游戏代打团队分成计算
- 任何需要"录入 → 算钱 → 生成文本"的轻量结算场景

## 常见问题

### 码单器适合哪些场景？
适合陪玩团、陪玩团俱乐部、代练团、游戏代打团队等需要快速**码单、报单、结算订单**的场景。

### 这是收费软件吗？
完全免费。纯前端工具，无需注册，无需付费，所有数据保存在本地浏览器。

### 码单、报单有什么区别？
在码单器里，「码单」和「报单」指同一件事：把订单信息录入后自动生成结算文本。不同圈子的叫法不同，本工具都支持。

### 需要安装吗？
不需要。打开网页即用，也支持打包成 Android APK 离线使用。

### 数据安全吗？
所有业务数据（订单、陪陪名单、老板记忆、价格库等）仅保存在你的本地浏览器 / WebView 中，不上传任何服务器。卸载应用或清除浏览器数据会清空，请定期导出备份。另有独立的匿名使用统计（不含任何业务数据，详见上文「安全性」）。

## 项目结构

```
.
├── index.html          # 完整单页应用（HTML + CSS + JS，单文件自包含交付）
├── update-checker.js   # OTA 热更新检测 / 下载 / 替换
│                       # ⚠️ 8.3.30 起其内容已【内联】进 index.html，本文件保留为源文件
│                       #    改完请运行 node tools/sync-root-scripts.js 同步内联副本
├── analytics.js        # 匿名使用统计（纯 Web API，失败静默降级）
│                       # ⚠️ 同上：本文件是源文件，改动后须同步内联副本
├── src/chunks/         # 懒加载 chunk 的【源文件】（8.3.34 起为唯一可读之处，A4）
│   ├── dataPortability.js                             # 数据备份/导入 Feature（约 1118 行）
│   └── durationCalculator.js                          # 时长计算器 Feature（约 273 行）
│                       # ⚠️ index.html 里的 __INLINE_CHUNKS_RAW__ 由本目录生成，
│                       #    改完请运行 node tools/build-inline-chunks.js
├── tools/              # 源码 → 产物 的生成/校验脚本（无构建链，按需手动跑）
│   ├── build-inline-chunks.js                         # src/chunks/*.js → index.html 字符串
│   └── sync-root-scripts.js                           # update-checker/analytics → 内联副本
├── test-engine.js      # 引擎单元测试（Node 隔离运行，L3 核心回归，126 项）
├── tests/              # 全链路测试资产
│   ├── 码单器8.3_AI可运行全链路测试脚本_8.3架构版.py                                   # 主入口：五段式全链路
│   ├── _materials.json                                # 真实素材与期望名单
│   ├── dom-full.js                                    # DOM 全链路（懒加载感知，26 项）
│   ├── combo.js                                       # 跨模块组合联动（6 场景，27 项）
│   ├── project-chain.js                               # 喂入链路真机回归（122 项）
│   ├── mutate-chain.py                                # 变异测试（9 条）＋ combo.js 交叉验证
│   ├── check-package-selfcontained.py                 # OTA 包自包含性（防「包内引用包外文件」）
│   ├── ota-loop-guard.js                              # OTA 防无限重载闸门（对照实验）
│   ├── ota-e2e.js                                     # OTA 端到端（真实 zip + 真实 version.json）
│   ├── inline-integrity.js                            # 内联副本与 .js 源文件逐字节一致性
│   ├── arch-snapshot.js                               # 架构边界快照（app 方法/state 键/feature 数）
│   ├── arch-baseline.json                             # 上述快照的基线，有意改动后须 --update
│   └── run-all.sh                                     # 统一测试入口（13 套防线一次跑完）
├── tools/             # 开发工具（非运行时依赖，不参与 index.html）
│   ├── set-version.js                                 # 版本号落点改写器（发版用）
│   ├── release.sh                                     # 一键发布（改版本号→打包→写清单→跑防线）
│   ├── build-inline-chunks.js                         # src/chunks/*.js → __INLINE_CHUNKS_RAW__
│   ├── sync-root-scripts.js                           # update-checker/analytics → index.html 内联副本
│   └── css-diff-check.js                              # CSS 改动等价性验证（真实 Chromium 计算样式比对）
├── version.json        # OTA 更新清单（version / url / checksum）
├── madan-<版本>.zip    # OTA 更新包，Pages 直出，不可从仓库删除
├── CHANGELOG.md        # 版本更新日志
├── README.md           # 本文件
├── functions/          # Cloudflare Pages Functions（服务端）
│   ├── api/track.js    # POST /api/track 事件收集
│   └── dashboard.js    # GET /dashboard 统计仪表盘
├── memex/              # Club 记忆库数据
│   ├── index.json      # Club 清单
│   └── <Club名>club.json
├── BingSiteAuth.xml    # Bing 站长验证
├── robots.txt          # 搜索引擎爬虫指引
└── sitemap.xml         # 站点地图
```

> `madan-<版本>.zip` 由 Cloudflare Pages 从仓库根目录直出，`version.json` 的 `url`
> 指向该文件。**绝不能删除当前版本对应的 zip** —— 删了会让已安装设备的 OTA 下载 404。
>
> 保留策略：仓库只保留**当前版本与上一版本**的包（8.3.36 起清理了 8.3.23~8.3.34）。
> 旧包对已升级的设备无用（OTA 只会拉 version.json 指向的那一个），囤积只会让仓库变重。
> 上一版本保留一份，是为了万一新版本出问题时能快速回退 `version.json` 指向。

## 测试

```bash
npm ci                             # JS 侧测试需要（锁定 jsdom 版本；不要用 npm install 裸装）

# 推荐：统一入口，一次跑完全部 13 套防线
bash tests/run-all.sh              # 全量（含约 4 分钟变异测试）
bash tests/run-all.sh --fast       # 日常提交：跳过变异测试
bash tests/run-all.sh --fast --require-package   # CI / 发版：缺包即判失败

# 一键发布（A1，8.3.36）
bash tools/release.sh 8.3.37 --notes @notes.txt --theme "主题"   # 正式
bash tools/release.sh 8.3.37 --notes @notes.txt --dry-run        # 演练（不写盘）
bash tests/release-selftest.sh     # 负向自检：验证 release.sh 真的拦得住、真的回滚

# 也可单独运行
python3 tests/码单器8.3_AI可运行全链路测试脚本_8.3架构版.py --html index.html --report-dir ./report
node tests/dom-full.js index.html ./domfull.json
node tests/combo.js index.html ./combo.json
node tests/project-chain.js index.html ./project-chain.json
node test-engine.js index.html                # 版本号自动从 APP_VERSION 提取
python3 tests/mutate-chain.py      # 变异测试：验证断言不是「假的绿」

# 发布专项（run-all.sh 已含前者）
python3 tests/check-package-selfcontained.py madan-<版本>.zip   # 包必须自包含
node tests/ota-loop-guard.js       # 防无限重载闸门（含旧逻辑对照）
node tests/ota-e2e.js              # 真实包 + 真实 version.json 端到端（版本自适应）
node tests/inline-integrity.js     # 内联副本与 .js 源文件是否同步

# 源码/产物一致性（8.3.34 A4 新增）
node tools/build-inline-chunks.js --check   # src/chunks/*.js ↔ __INLINE_CHUNKS_RAW__
node tools/sync-root-scripts.js --check     # update-checker/analytics ↔ 内联副本
node tests/arch-snapshot.js                 # 架构边界快照（防隐式动态挂载回归）

# 8.3.37 新增：两项能力的专项防线（各自自带反向验证）
node tests/price-alias.js                   # 精确项目「其他名字」（多别名）能力
node tests/history-refill.js                # 历史记录编辑回填后详情即时同步

# CSS 改动等价性验证（8.3.36 新增，按需使用，不参与门禁）
node tools/css-diff-check.js <改动前.html> <改动后.html>
```

> **改了 CSS 之后怎么做等价性证明**：不要靠肉眼，也不要靠静态分析 —— 实测过三种
> 静态方法，结论互相矛盾且都是假象。用真实浏览器比对：
>
> ```bash
> # 1. 取改动前的版本（用 git，不要靠备份文件）
> git show HEAD~1:index.html > /tmp/before.html
>
> # 2. 装一次依赖（刻意不进 package.json：CI 不需要它，
> #    不该为它付 14MB + 364MB 的代价）
> npm install --no-save playwright-core && npx playwright-core install chromium
>
> # 3. 比对（默认 6 组视口 × 18 项属性，自动报告媒体查询命中情况）
> node tools/css-diff-check.js /tmp/before.html index.html
> ```
>
> 零差异时退出码 0；发现差异为 1；**依赖缺失为 2**（工具没跑起来 ≠ 发现差异）。
> 输出会明确声明测试范围 —— 它只覆盖被测视口/属性，不含交互态与 JS 行为。

> **改了 `update-checker.js` / `analytics.js` 之后**：这两个文件的内容已被内联进
> `index.html`（见「项目结构」中的 ⚠️ 说明），**必须同步更新 `index.html` 里的内联副本**，
> 否则打包出去的仍是旧逻辑。跑 `node tools/sync-root-scripts.js` 同步，
> `--check` 可校验是否一致（已纳入 `run-all.sh`）。

> **改了 `src/chunks/*.js` 之后**：这两个懒加载 Feature 的源码在 `index.html` 里以
> JSON 转义后的单行字符串（`__INLINE_CHUNKS_RAW__`）存在，编辑器无法索引 ——
> 所以**日常维护请改 `src/chunks/` 下的源文件**，再运行
> `node tools/build-inline-chunks.js` 重新生成字符串。
> `--check` 模式可校验两者是否一致（已纳入 `run-all.sh`）。
> 注意：`index.html` 里那行字符串**不要手改**，手改会被下次生成覆盖。

> **关于 `test-engine.js` 的版本参数**：它的第二个参数是**期望版本号**，省略时会
> 自动从 `index.html` 的 `APP_VERSION` 提取。
>
> **不要手写这个参数**。它的设计意图是防止「测试通过，但测的是旧版本」，
> 一旦手写的版本与文件实际版本不符，就会产生一条**与代码质量无关的假失败**。
> 实测踩坑记录：
>
> ```console
> $ node test-engine.js index.html 8.3.28      # 而文件实际是 8.3.27
> APP_VERSION: 8.3.27 (expected 8.3.28)
> FAIL: version mismatch, actual=8.3.27 expected=8.3.28
> ```
>
> 只有在需要**显式锁定**某个版本（例如 CI 里断言「发的就是这个版本」）时，
> 才手写该参数，并确保与 `index.html` 同步。`run-all.sh` 内部已自动提取，无需关心。
>
> 另：若某次改版**有意变更**了引擎行为（如 8.3.19 的「备注不再触发加价」），
> 需同步更新 `test-engine.js` 中对应的期望值，否则 CI 会持续报红、失去门禁意义。

全链路脚本分五段独立报告：静态架构 / JS 语法 / 计算引擎 / 真实素材提取 / DOM 链路，
另有提取边界哨兵。退出码 `0` 全通过 / `1` 硬错误 / `2` 断言失败，可挂 CI。
详见 [tests/README.md](./tests/README.md)。

### 四层测试的分工

| 层 | 文件 | 测什么 | 覆盖的病 |
| --- | --- | --- | --- |
| **引擎** | `test-engine.js` | 引擎被喂**正确入参**时算得对不对 | 算法错 |
| **喂入链路** | `tests/project-chain.js` | 界面输入有没有被**正确喂进去** | 8.3.25 / 26 / 27 三连 bug |
| **DOM / 组合** | `tests/dom-full.js`、`tests/combo.js` | 模块间联动是否断裂 | 集成错 |
| **全链路** | `tests/码单器8.3_AI可运行全链路测试脚本_8.3架构版.py` | 静态结构 / 语法 / 素材提取 / 边界行为 | 架构漂移 |

> `tests/mutate-chain.py` 不测产品，它测**测试本身**：向 `index.html` 注入 9 条真实历史缺陷，
> 验证 `project-chain.js` 能逐条抓住，并交叉确认 `combo.js` 不再是加价链路的盲区。
> **抓不住的断言就是「假的绿」**。
> 初版曾出现 114/114 全绿、捕捉率却只有 1/9 的情况——大量断言因函数签名写错而恒真。

## 版本

当前版本：`8.3.39`

版本规则：第三位用于内部修订；第二位在整体达到预期、无已知阻断并确认可交付后晋升。

版本号的**参与代码**落点只有 2 处（`index.html` 的 `<title>` 与 `APP_VERSION`），
另有 2 处跟随项（`package.json` 的 `version`、本文件上方的「当前版本」）。
发版时由 `tools/set-version.js` 一并同步，**不要手改**：

```bash
node tools/set-version.js --check           # 校验各落点是否一致（含 README 漂移提醒）
node tools/set-version.js --to 8.3.37       # 同步改写全部落点
```

> `index.html` 里另有 160+ 处 `8.3.x` 字样，全部是变更考古注释（记录「这个功能为什么长这样」），
> **必须原样保留**，任何批量替换都会毁掉它们。所以版本号只能走 `set-version.js`，
> 它会拒绝在「出现白名单之外的版本号字面量」时写入。

更新历史详见 [CHANGELOG.md](./CHANGELOG.md)。
