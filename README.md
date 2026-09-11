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
├── index.html          # 完整单页应用（HTML + CSS + JS，单文件交付）
├── update-checker.js   # OTA 热更新检测 / 下载 / 替换（Capacitor 原生壳内生效）
├── analytics.js        # 匿名使用统计（纯 Web API，失败静默降级）
├── test-engine.js      # 引擎单元测试（Node 隔离运行，L3 核心回归）
├── tests/              # 全链路测试资产
│   ├── 码单器8.3_AI可运行全链路测试脚本_8.3架构版.py   # 主入口：五段式全链路
│   ├── _materials.json                                # 真实素材与期望名单
│   ├── dom-full.js                                    # DOM 全链路（懒加载感知，26 项）
│   ├── combo.js                                       # 跨模块组合联动（6 场景，24 项）
│   └── 上游-码单器8.3_AI可运行全链路测试脚本.py          # 上游原版（已归档）
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
> 指向该文件；删除 zip 会导致已安装设备 OTA 下载失败，请勿清理。

## 测试

```bash
npm install jsdom                  # JS 侧测试需要
python3 tests/码单器8.3_AI可运行全链路测试脚本_8.3架构版.py --html index.html --report-dir ./report
node tests/dom-full.js index.html ./domfull.json
node tests/combo.js index.html ./combo.json
node test-engine.js
```

全链路脚本分五段独立报告：静态架构 / JS 语法 / 计算引擎 / 真实素材提取 / DOM 链路，
另有提取边界哨兵。退出码 `0` 全通过 / `1` 存在硬失败，可挂 CI。
详见 [tests/README.md](./tests/README.md)。

## 版本

当前版本：`8.3.21`

版本规则：第三位用于内部修订；第二位在整体达到预期、无已知阻断并确认可交付后晋升。

更新历史详见 [CHANGELOG.md](./CHANGELOG.md)。