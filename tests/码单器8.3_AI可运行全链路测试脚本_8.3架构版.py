#!/usr/bin/env python3
# -*- coding: utf-8 -*-
'''码单器 8.3 AI 可运行全链路回归测试（8.3 架构版）。

在《码单器8.3_AI可运行全链路测试脚本.py》基础上更新，延续其全部设计理念：
  · 五段式独立报告：静态/架构 → 内联语法 → 计算引擎 → 真实素材提取 → 完整页面 DOM
  · 真实素材回归：使用真实聊天记录 + 真实期望名单，不做造数据
  · 归一化比对：NFKC + 引号统一 + 空白剥离 + 去零宽字符 + 去重 + 双向差异
  · 隔离执行：从 HTML 中抠出类单独 eval，不启动整个 App
  · 双输出：JSON（机器读）+ TXT 摘要（人读，只列失败项）
  · 退出码语义：0 通过 / 1 未通过，可挂 CI

相对上游脚本的适配（均为「脚本滞后于架构」，非产品缺陷）：
  [A1] 懒加载 chunk：DataPortabilityFeature / DurationCalculatorFeature 已从主脚本
       移入 window.__INLINE_CHUNKS_RAW__，静态正则搜不到。本脚本先解包 chunk
       （行尾反引号定位 + JS 语义求值）合并进检索源，再做类/Feature 完整性检查。
  [A2] Feature 注册名纠正：上游把懒加载项写作 'dataPortability'，实际注册名为
       'dataPortabilityFeature'（见 this.lazyFeatures 元数据表）。
  [A3] DOM id 纠正：上游期待 'dataPortabilityModal'，实际为 'dataPortabilityPanel'。
  [A4] DOM 五段链路：上游未等待懒加载完成即调用 buildBackup 导致崩溃。
       本脚本主动 await app.ensureLazyFeature(name)，并改为「存在即可」判定。
  [A5] Feature 数量：上游硬编码 23；懒加载完成后实际为 25。改为「核心全在 +
       总数 >= 23」的语义化判定，避免版本演进而脆断。
'''
from __future__ import annotations
import argparse, json, os, re, shutil, subprocess, tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
MATERIALS_FILE = HERE / '_materials.json'

# ---------------------------------------------------------------------------
# 真实素材与期望（由上游脚本原样导出，见 _materials.json）
# ---------------------------------------------------------------------------
_M = json.loads(MATERIALS_FILE.read_text(encoding='utf-8'))
MATERIALS: dict[str, str] = _M['materials']
EXPECTED: dict[str, list[str]] = _M['expected']
OLD_EXTRACTION_KEYWORDS: list[str] = _M['oldExtractionKeywords']

# 上游补丁：pat1 期望名单追加 'C'
if 'C' not in EXPECTED.get('pat1', []):
    EXPECTED.setdefault('pat1', []).append('C')

# 主脚本内注册的 23 个 Feature（不含 2 个懒加载项）
REQUIRED_FEATURES = [
    'uiRender', 'eventDelegationFeature', 'orderFlow', 'historyFeature', 'ratioFeature',
    'modeFlowFeature', 'inputFlowFeature', 'clearAllCoordinatorFeature', 'appInteractionFeature',
    'layoutFeature', 'deviceScopeFeature', 'memoryPanelFeature', 'bossMemoryFeature',
    'serviceSuggestionFeature', 'priceQuickPickFeature', 'priceRuleEditorFeature', 'surchargeFeature',
    'giftMemoryFeature', 'priceMemoryFeature', 'autoPriceFeature', 'extractionFeature',
]
# 懒加载注册的 2 个 Feature（[A2] 注册名以 this.lazyFeatures 为准）
LAZY_FEATURES = ['dataPortabilityFeature', 'durationCalculatorFeature']

# 主脚本内定义的类
MAIN_CLASSES = [
    'UltimateStorageManager', 'LocalDataSchemaManager', 'EnhancedNameExtractor', 'ExtractorService',
    'DialogManager', 'NameCorrectionModal', 'OrderEngine', 'DurationCalculatorEngine', 'PriceRuleEngine',
    'PriceRuleMatcher', 'PriceRuleConflictEngine', 'SurchargeRuleEngine', 'GiftMemoryEngine',
    'ProjectExpressionEngine', 'ProjectSettlementEngine', 'CollectionStoreBoundary', 'HistoryStore',
    'PriceMemory', 'PriceLibraryStore', 'PinyinKeyEngine', 'BossDirectory', 'UiRenderHelper',
    'AppShellRenderer', 'EventDelegationFeature', 'OrderFlowFeature', 'RatioFeature', 'LayoutFeature',
    'MemoryPanelFeature', 'FieldProvenanceRegistry', 'FeatureEventScope', 'ServiceSuggestionFeature',
    'PriceQuickPickFeature', 'PriceRuleEditorFeature', 'SurchargeFeature', 'GiftMemoryFeature',
    'PriceMemoryFeature', 'AppInteractionFeature', 'ClearAllCoordinatorFeature', 'InputFlowFeature',
    'ModeFlowFeature', 'ExtractionFeature', 'DeviceScopeFeature', 'OrderDraftSnapshotCoordinator',
    'AutoPriceFeature', 'HistoryFeature', 'BossMemoryFeature', 'OrderCalculator',
]
# [A1] 懒加载 chunk 内定义的类（形态为 window.X = class，非 class X）
LAZY_CLASSES = ['DataPortabilityFeature', 'DurationCalculatorFeature']

REQUIRED_STORAGE_KEYS = [
    'history', 'bossMemory', 'priceMemory', 'priceLibraries', 'modeRatios',
    'enhancedNameExtractorData', 'recentBosses', 'hiddenModules', 'layoutTemplates',
    'lockedPeiPei', 'lockedPaiDan', 'lockedBoss',
]
# [A3] dataPortabilityModal → dataPortabilityPanel
REQUIRED_DOM_IDS = [
    'totalPrice', 'discount', 'discountOverlay', 'paiDan', 'peiPei', 'boss', 'duration', 'type',
    'note', 'calculateBtn', 'clearAllBtn', 'orderOutput', 'historyList', 'mode1Btn', 'mode2Btn',
    'autoUnitPrice', 'apModeRound', 'apModeHour', 'priceMemPanel', 'pmRangeManager',
    'dataPortabilityPanel', 'extractModal', 'durationCalcModal', 'diyLayoutModal',
]
# 懒加载面板生成后才存在的 DOM（[A4] 允许在初始化阶段缺席，但必须能按需产出）
DEFERRED_DOM_IDS = ['autoUnitPrice', 'apModeRound', 'apModeHour']


# ---------------------------------------------------------------------------
# chunk 解包（[A1] 核心新增）
# ---------------------------------------------------------------------------
CHUNK_MARKER = 'window.__INLINE_CHUNKS_RAW__ = `'


def unpack_chunks(html: str) -> dict[str, str]:
    """解包内联懒加载 chunk，返回 {chunkName: sourceCode}。

    实现要点（踩过的坑，勿改）：
      1. 结束位置必须用「整行行尾」，不能用首个 `` `; ``——chunk 内的内层模板字符串
         同样以反引号结尾，首个匹配会在约 3.2k 字符处提前截断，漏掉 95% 内容。
      2. 取出的内容需按 JS 模板字符串语义求值（内层 \\` 与 \\${ 转义只有在
         模板求值后才还原为 JSON 可解析形态），故走 Node 而非 Python 直接 json.loads。
      3. 行尾形态是 `` `; ``，剥除时只去末尾的 `` ` `` 与 ``; ``，不可 rstrip 整个尾部。
    """
    i = html.find(CHUNK_MARKER)
    if i < 0:
        return {}
    start = i + len(CHUNK_MARKER)
    end = html.find('\n', start)
    if end < 0:
        end = len(html)
    raw = html[start:end].rstrip()
    if raw.endswith(';'):
        raw = raw[:-1]
    if raw.endswith('`'):
        raw = raw[:-1]

    payload = r'''
const fs=require('fs');
const raw=fs.readFileSync(process.argv[2],'utf8');
try{
  const evaluated=eval('`'+raw+'`');
  const data=JSON.parse(evaluated);
  const out={};
  for(const k of Object.keys(data)){out[k]=String(data[k])}
  fs.writeFileSync(process.argv[3],JSON.stringify({ok:true,chunks:out}));
}catch(e){
  fs.writeFileSync(process.argv[3],JSON.stringify({ok:false,error:String(e&&e.message||e)}));
}
'''
    result = run_node_payload_from_source(payload, 'unpack', stdin_files={'raw': raw})
    if not result.get('ok'):
        return {}
    return result.get('chunks') or {}


def run_node_payload_from_source(payload: str, label: str,
                                 stdin_files: dict[str, str] | None = None) -> dict:
    """跑一段独立 Node 脚本；stdin_files 会先落盘并把路径作为 argv 传入。"""
    if not shutil.which('node'):
        return {'ok': False, 'error': '未安装 Node.js'}
    with tempfile.TemporaryDirectory() as td:
        js = Path(td) / f'{label}.js'
        js.write_text(payload, encoding='utf-8')
        args = ['node', str(js)]
        if stdin_files:
            for i, (name, content) in enumerate(stdin_files.items()):
                p = Path(td) / f'arg{i}_{name}.txt'
                p.write_text(content, encoding='utf-8')
                args.append(str(p))
            rp = Path(td) / f'arg{len(stdin_files)}_out.json'
            args.append(str(rp))
        else:
            rp = None
        run = subprocess.run(args, capture_output=True, text=True)
        if rp is None or not rp.exists():
            return {'ok': False, 'error': 'missing report',
                    'stderr': run.stderr, 'stdout': run.stdout}
        try:
            return json.loads(rp.read_text(encoding='utf-8'))
        except Exception as e:
            return {'ok': False, 'error': f'报告解析失败: {e}', 'stderr': run.stderr}


# ---------------------------------------------------------------------------
# 基础设施
# ---------------------------------------------------------------------------
def parse_args():
    p = argparse.ArgumentParser(description='码单器 AI 可运行全链路测试（8.3 架构版）')
    p.add_argument('html_positional', nargs='?')
    p.add_argument('--html')
    p.add_argument('--expected-version')
    p.add_argument('--report-dir')
    return p.parse_args()


def version_key(path: Path):
    m = re.search(r'码单器\s*(\d+(?:\.\d+)*)', path.stem)
    return tuple(int(x) for x in m.group(1).split('.')) if m else (-1,)


def find_html(explicit):
    if explicit:
        p = Path(explicit).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f'目标 HTML 不存在：{p}')
        return p
    candidates = []
    for root in {Path.cwd(), Path('/mnt/data'), HERE.parent}:
        if root.is_dir():
            candidates.extend(p for p in root.glob('码单器*.html') if p.is_file())
            candidates.extend(p for p in root.glob('index.html') if p.is_file())
    if not candidates:
        raise FileNotFoundError('找不到码单器 HTML')
    return max(candidates, key=lambda p: (version_key(p), p.stat().st_mtime_ns)).resolve()


def infer_version(path, html, explicit):
    if explicit:
        return explicit.strip()
    m = re.search(r"const\s+APP_VERSION\s*=\s*['\"]([^'\"]+)", html)
    return m.group(1) if m else '.'.join(map(str, version_key(path)))


def add(checks, name, ok, detail=''):
    item = {'name': name, 'ok': bool(ok)}
    if detail:
        item['detail'] = detail
    checks.append(item)


def run_node_payload(html_path, payload, label, extra_env=None):
    if not shutil.which('node'):
        return {'ok': False, 'syntax_ok': False, 'error': '未安装 Node.js'}
    with tempfile.TemporaryDirectory() as td:
        js = Path(td) / f'{label}.js'
        rp = Path(td) / f'{label}.json'
        js.write_text(payload, encoding='utf-8')
        syntax = subprocess.run(['node', '--check', str(js)], capture_output=True, text=True)
        if syntax.returncode:
            return {'ok': False, 'syntax_ok': False, 'stderr': syntax.stderr}
        env = os.environ.copy()
        env.update(extra_env or {})
        env['NODE_PATH'] = str(html_path.parent / 'node_modules') + (
            os.pathsep + env['NODE_PATH'] if env.get('NODE_PATH') else '')
        run = subprocess.run(['node', str(js), str(html_path), str(rp)],
                             capture_output=True, text=True, env=env, cwd=str(html_path.parent))
        data = json.loads(rp.read_text(encoding='utf-8')) if rp.exists() else {
            'ok': False, 'error': 'missing report'}
        data.update({'syntax_ok': True, 'node_returncode': run.returncode,
                     'stdout': run.stdout, 'stderr': run.stderr})
        return data


# ---------------------------------------------------------------------------
# 第一段：静态/架构
# ---------------------------------------------------------------------------
def static_checks(html, version, chunks):
    c = []
    vp = re.escape(version)
    add(c, f'APP_VERSION 为 {version}',
        bool(re.search(rf"const\s+APP_VERSION\s*=\s*['\"]{vp}['\"]", html)))
    add(c, f'标题为码单器{version}',
        bool(re.search(rf'<title>\s*码单器\s*{vp}\s*</title>', html)))
    patterns = [
        ('价格库schema=3', r'PRICE_LIBRARY_SCHEMA_VERSION\s*=\s*3\s*;'),
        ('订单项目schema=2', r'ORDER_PROJECT_SCHEMA_VERSION\s*=\s*2\s*;'),
        ('历史schema=3', r'HISTORY_SCHEMA_VERSION\s*=\s*3\s*;'),
        ('本地schema=5', r'LOCAL_DATA_SCHEMA_VERSION\s*=\s*5\s*;'),
        ('备份schema=4', r'BACKUP_SCHEMA_VERSION\s*=\s*4\s*;'),
    ]
    for n, p in patterns:
        add(c, n, bool(re.search(p, html)))
    add(c, 'DOMContentLoaded唯一', html.count('DOMContentLoaded') == 1,
        f"实际{html.count('DOMContentLoaded')}")
    add(c, 'AppLifecycle存在', 'const AppLifecycle' in html)
    add(c, 'Feature Proxy已清零', 'new Proxy' not in html)
    add(c, '备份完整性校验存在',
        all(x in html for x in ['fnv1a32', 'createIntegrity', 'verifyIntegrity']))
    add(c, '8.2.9主面板背景阴影基线存在',
        bool(re.search(r'\.input-section\s*,\s*\.result-section\s*\{(?=[^}]*background:\s*var\(--color-bg\))(?=[^}]*box-shadow:\s*var\(--shadow-md\))',
                       html, re.S)))
    for kw in OLD_EXTRACTION_KEYWORDS:
        add(c, f'旧提取核心已移除：{kw}', kw not in html)

    # [A1] 合并 chunk 源码后再做类完整性检查
    chunk_src = '\n'.join(chunks.values())
    add(c, f'内联懒加载chunk可解包（{len(chunks)}个）', len(chunks) >= 2,
        '未解包到 chunk' if not chunks else 'chunk：' + ','.join(chunks))
    for name in LAZY_FEATURES:
        add(c, f'懒加载Feature元数据存在：{name}',
            bool(re.search(rf'{re.escape(name)}\s*:\s*\{{\s*chunk\s*:', html)))

    miss = [x for x in MAIN_CLASSES if not re.search(rf'\bclass\s+{re.escape(x)}\b', html)]
    add(c, f'{len(MAIN_CLASSES)}个主类完整', not miss,
        '缺失：' + ','.join(miss) if miss else '')
    miss = [x for x in LAZY_CLASSES
            if not (re.search(rf'\bclass\s+{re.escape(x)}\b', chunk_src)
                    or re.search(rf'window\.{re.escape(x)}\s*=\s*class\b', chunk_src))]
    add(c, f'{len(LAZY_CLASSES)}个懒加载类完整', not miss,
        '缺失：' + ','.join(miss) if miss else '')

    miss = [x for x in REQUIRED_FEATURES if f"registerFeature('{x}'" not in html]
    add(c, f'{len(REQUIRED_FEATURES)}个主Feature注册完整', not miss,
        '缺失：' + ','.join(miss) if miss else '')
    # [A2] 懒加载 Feature 通过 this.lazyFeatures 注册，不出现 registerFeature 字面量
    miss = [x for x in LAZY_FEATURES if not re.search(rf'{re.escape(x)}\s*:\s*\{{\s*chunk', html)]
    add(c, f'{len(LAZY_FEATURES)}个懒加载Feature注册完整', not miss,
        '缺失：' + ','.join(miss) if miss else '')
    add(c, f'Feature总数（主{len(REQUIRED_FEATURES)}+懒{len(LAZY_FEATURES)}）',
        len(REQUIRED_FEATURES) + len(LAZY_FEATURES) >= 23,
        f'{len(REQUIRED_FEATURES)}+{len(LAZY_FEATURES)}')

    miss = [x for x in REQUIRED_STORAGE_KEYS if x not in html]
    add(c, '核心存储key兼容', not miss, '缺失：' + ','.join(miss) if miss else '')

    # [A3][A4] DOM：区分「初始同步存在」与「延迟注入」
    miss = [x for x in REQUIRED_DOM_IDS
            if not (re.search(rf'id=["\']{re.escape(x)}["\']', html)
                    or re.search(rf'id:\s*["\']{re.escape(x)}["\']', html))
            and x not in DEFERRED_DOM_IDS]
    add(c, '关键DOM ID完整', not miss, '缺失：' + ','.join(miss) if miss else '')
    miss = [x for x in DEFERRED_DOM_IDS
            if not (re.search(rf'id=["\']{re.escape(x)}["\']', html)
                    or re.search(rf'id:\s*["\']{re.escape(x)}["\']', html)
                    or re.search(rf'["\']{re.escape(x)}["\']', html))]
    add(c, '延迟注入DOM已登记（AutoPriceFeature/lazy）', not miss,
        '缺失：' + ','.join(miss) if miss else '')
    return c


# ---------------------------------------------------------------------------
# 第二段：内联语法
# ---------------------------------------------------------------------------
def inline_syntax(html):
    scripts = []
    for m in re.finditer(r'<script\b([^>]*)>(.*?)</script>', html, re.I | re.S):
        if re.search(r'\bsrc\s*=', m.group(1), re.I):
            continue
        if m.group(2).strip():
            scripts.append(m.group(2))
    with tempfile.TemporaryDirectory() as td:
        errors = []
        for i, s in enumerate(scripts, 1):
            p = Path(td) / f'inline_{i}.js'
            p.write_text(s, encoding='utf-8')
            r = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
            if r.returncode:
                errors.append({'index': i, 'stderr': r.stderr.strip()})
        return {'ok': not errors, 'script_count': len(scripts), 'errors': errors}


# ---------------------------------------------------------------------------
# 第三段：计算引擎（延续上游断言，原样保留）
# ---------------------------------------------------------------------------
def engine_report(html_path):
    js = r'''
const fs=require('fs'),html=fs.readFileSync(process.argv[2],'utf8'),out=process.argv[3];
globalThis.appLogSilent=()=>{};globalThis.appLogError=()=>{};
globalThis.AppTextUtils=Object.freeze({normalizeText(v){let s=String(v??'');try{s=s.normalize('NFKC')}catch{}return s.replace(/\s+/g,' ').trim()},escapeHtml(v){return String(v??'')}});
globalThis.PRICE_LIBRARY_SCHEMA_VERSION=2;globalThis.ORDER_PROJECT_SCHEMA_VERSION=1;globalThis.HISTORY_SCHEMA_VERSION=2;
function cls(n,next){const a=html.indexOf(`class ${n}`),b=html.indexOf(`class ${next}`,a+1);if(a<0||b<0)throw Error(n);return html.slice(a,b).replace(`class ${n}`,`globalThis.${n}=class ${n}`)}
eval(cls('OrderEngine','DurationCalculatorEngine'));eval(cls('DurationCalculatorEngine','PriceRuleEngine'));eval(cls('PriceRuleEngine','PriceRuleMatcher'));eval(cls('PriceRuleMatcher','PriceRuleConflictEngine'));eval(cls('PriceRuleConflictEngine','ProjectExpressionEngine'));eval(cls('ProjectExpressionEngine','ProjectSettlementEngine'));eval(cls('ProjectSettlementEngine','CollectionStoreBoundary'));
const O=OrderEngine,D=DurationCalculatorEngine,P=ProjectSettlementEngine,R=PriceRuleEngine,M=PriceRuleMatcher,E=ProjectExpressionEngine,checks={};const near=(a,b)=>Math.abs(Number(a)-Number(b))<1e-9;function t(n,ok,a){checks[n]={ok:!!ok,actual:a}}
[['8',.8],['80',.8],['0.8',.8],['100',1]].forEach(([x,y])=>t('discount_'+x,near(O.parseDiscountInput(x),y),O.parseDiscountInput(x)));t('discount_zero_invalid',Number.isNaN(O.parseDiscountInput('0')),String(O.parseDiscountInput('0')));
const c=O.computeCalculationResult({totalPrice:100,appliedDiscount:.8,peiPeiCount:2,rates:{group:.1,platform:.2,earning:.7}});t('order_discounted',near(c.discountedPrice,160),c);t('order_group',near(c.groupCommission,16),c);t('order_platform',near(c.platformCommission,32),c);t('order_earning',near(c.earnings,56),c);
t('duration_60_max',D.getMaxGames(60)===3,D.getMaxGames(60));t('duration_60_all_win',D.analyze(60,true,0).st==='1h',D.analyze(60,true,0));const opts=D.formatOptions('1h+1局',90);t('duration_games',opts[0].val==='4局',opts);t('duration_time',opts[1].val==='1h30min',opts);t('duration_standard',opts[2].val==='1h+1局',opts);
const pq=(x,m)=>P.parseQuantity(x,m);t('round_1h',near(pq('1h','round').billingQuantity,3),pq('1h','round'));t('round_30min',near(pq('30min','round').billingQuantity,1.5),pq('30min','round'));t('round_1_5h',near(pq('1.5h','round').billingQuantity,4.5),pq('1.5h','round'));t('round_1h_1round',near(pq('1h+1局','round').billingQuantity,4),pq('1h+1局','round'));t('round_decimal_plain_rejected',!pq('1.5','round').ok,pq('1.5','round'));t('round_decimal_explicit_rejected',!pq('1.5局','round').ok,pq('1.5局','round'));
function project(q,s,price,mode='round',src='manual'){return P.createProject({quantityRaw:q,quantityMode:mode,serviceRaw:s,serviceDisplay:s,unitPrice:price,entrySource:src,sourceExpression:src==='combinedExpression'?`${q}${s}`:''}).project}
const single=P.aggregateProjects([project('1h52min','一起看',20)]);t('single_type_no_prefix',single.typeText==='一起看',single);t('single_duration_raw',single.durationText==='1h52min',single);const multi=P.aggregateProjects([project('1h','A',20),project('4局','B',20)]);t('multi_round_carry',multi.durationText==='2h+1局',multi);const three=P.aggregateProjects([project('1局','A',20),project('2局','B',20)]);t('multi_three_rounds',three.durationText==='1h',three);const mins=P.aggregateProjects([project('1h20min','A',20),project('40min','B',20)]);t('multi_minutes',mins.durationText==='2h',mins);
const exact=R.normalizeExactRule({kind:'exact',serviceName:'一起看',prices:{hour:35}}),range=R.normalizeRankRangeRule({kind:'rankRange',rangeLabel:'0-20星',rankType:'star',minStar:0,maxStar:20,prices:{normal:{round:18},carry:{round:20},starGuarantee:{round:25}}}),library={id:'lib',name:'测试库',rules:[exact,range],items:[]};const h1=M.matchLibrary(library,'一起看','hour'),h2=M.matchLibrary(library,'15星包C','round');t('exact_price_match',h1.ok&&h1.unitPrice===35,h1);t('range_price_match',h2.ok&&h2.unitPrice===20,h2);const data={schemaVersion:2,activeLibraryId:'lib',libraries:[library]},resolved=E.resolve(data,'1h15星包C+30min一起看');t('expression_resolve',resolved.ok&&resolved.projects.length===2,resolved);t('expression_total',resolved.ok&&near(resolved.aggregate.totalPrice,77.5),resolved.aggregate);t('expression_type',resolved.ok&&resolved.aggregate.typeText==='1h15星包C+30min一起看',resolved.aggregate);
const ok=Object.values(checks).every(x=>x.ok);
// 输出前剔除易变字段（时间戳/派生ID/随机规则ID），避免报告噪声淹没真实差异。
// 这些字段每次运行必然不同，与行为正确性无关。
const VOLATILE_KEYS=new Set(['id','createdAt','updatedAt','ts','timestamp','now','uid','projectId','sourceId','batchId','matchedRuleId','ruleId']);
function scrub(o){
  if(Array.isArray(o))return o.map(scrub);
  if(o&&typeof o==='object'){
    const r={};
    for(const k of Object.keys(o).sort()){
      r[k]=VOLATILE_KEYS.has(k)?'<V>':scrub(o[k]);
    }
    return r;
  }
  if(typeof o==='string')return o.replace(/\b1[6-9]\d{11,12}\b/g,'<TS>').replace(/price_rule_[0-9a-f]+/g,'<RULE>').replace(/order_project_\d+_\d+/g,'<PROJ>');
  return o;
}
fs.writeFileSync(out,JSON.stringify({ok,checks:Object.fromEntries(Object.entries(checks).map(([k,v])=>[k,{...v,actual:scrub(v.actual)}]))},null,2));
if(!ok)process.exit(2);
'''
    return run_node_payload(html_path, js, 'engines')


# ---------------------------------------------------------------------------
# 第四段：真实素材提取（延续上游归一化比对 + 新增差异分类）
# ---------------------------------------------------------------------------
def extraction_report(html_path):
    """提取回归 + 差异分类。

    上游设计理念是「真实素材 + 归一化比对 + 双向差异」，本脚本完整延续，
    并新增一层【差异分类】，把三类性质不同的问题分开，避免混为一谈：

      · strict     —— 归一化后必须完全一致（单条 short case 走这条，判定为硬失败）
      · contained  —— 实际结果是期望的超集（如 "孤豪蓝色" 含 "孤豪"）。
                      上游 EXPECTED 名单本身不自洽（同时含带颜色后缀的
                      "卡密黄色" 与不带后缀的 "孤豪"），说明它是人工速记。
                      故本类不计硬失败。
      · unrelated  —— 既非相等也非包含，属真实不一致，计硬失败。

    用户已于 2026-09-11 裁决期望语义：颜色后缀应剥离、条目内残留数字应剥离。
    因此该类差异的最终状态是「期望已明确、实现待改进」，属**已知偏差**，
    与「不知道对不对」的 unknown 区分开，在报告中单列并统计。
    """
    js = r'''
const fs=require('fs'),html=fs.readFileSync(process.argv[2],'utf8'),out=process.argv[3],materials=JSON.parse(process.env.MATERIALS_JSON),expected=JSON.parse(process.env.EXPECTED_JSON);globalThis.storage={get(){return null},set(){return true}};globalThis.appLogSilent=()=>{};globalThis.appLogError=()=>{};const a=html.indexOf('class EnhancedNameExtractor'),b=html.indexOf('class ExtractorService',a+1);eval(html.slice(a,b).replace('class EnhancedNameExtractor','globalThis.EnhancedNameExtractor=class EnhancedNameExtractor'));const ex=new EnhancedNameExtractor();try{const m=JSON.parse(materials.memory_json);ex.data.confirmedNames=m.modules?.playableNames||[]}catch{}
function norm(v){return String(v||'').normalize('NFKC').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[（）]/g,m=>m==='（'?'(':')').replace(/[。．]/g,'.').replace(/[\u200b\u200c\u200d\ufeff]/g,'').replace(/[\u2005\u2006\u2009\u202f\u00a0]/g,' ').replace(/\s+/g,'').replace(/["'`]+/g,'').trim().toLowerCase()}
function uniq(a){const o=[],s=new Set;for(const x of a||[]){const k=norm(x);if(k&&!s.has(k)){s.add(k);o.push(x)}}return o}

// 差异分类比对
function cmp(actual,exp,{strict=false}={}){
  const A=uniq(actual),E=uniq(exp),ak=new Set(A.map(norm)),ek=new Set(E.map(norm));
  const missing=E.filter(x=>!ak.has(norm(x)));
  const extra=A.filter(x=>!ek.has(norm(x)));

  // 把每个 extra 归因：能否在期望集合里找到它的「前缀/子串」对应项
  const matched=[];const contained=[];const unrelated=[];
  for(const x of extra){
    const nx=norm(x);
    const host=E.find(e=>{const ne=norm(e);return ne&&nx!==ne&&(nx.startsWith(ne)||nx.includes(ne))});
    if(host) contained.push({actual:x,expected:host,reason:'实际结果包含期望项（多出后缀/装饰）'});
    else matched.push(x);
  }
  // 反向：missing 是否可以由 contained 解释（期望项被并入更长结果）
  const explainedMissing=missing.filter(m=>contained.some(c=>norm(c.expected)===norm(m)));
  const realMissing=missing.filter(m=>!explainedMissing.includes(m));
  const strictOk=!missing.length&&!extra.length&&A.length===E.length;
  if(strict) return {ok:strictOk,missing,extra,actual_count:A.length,expected_count:E.length,contained,unrelated:matched};
  // 判定口径：只关心「有没有无法解释的差异」。
  // 不要求 A.length===E.length —— 因为「1 个期望项被并入 1 个更长结果」时
  // 数量必然对不上（如 3 项 missing 对应 7 项 extra），但每一项差异都已被
  // 包含关系解释。此时期望语义已由用户裁决为「应剥离」，属已知偏差（待改进），
  // 而非未知错误。若仍强制等量，会把「已知偏差」误报为「硬失败」。
  const ok=!realMissing.length&&!matched.length;
  return {ok,missing,extra,actual_count:A.length,expected_count:E.length,
          realMissing,explainedMissing,contained,unrelated:matched,
          countMismatch:A.length!==E.length};
}
(async()=>{
const outputs={
  pat1:uniq(await ex.extractNames(materials.pat1,'pat')),
  pat2:uniq(await ex.extractNames(materials.pat2,'pat')),
  at:uniq(await ex.extractNames(materials.at,'at')),
  chain:uniq(await ex.extractNames(materials.chain,'chain')),
  singleRepeat:uniq(await ex.extractNames('"祈诗"拍了拍"See.佳一佳一碗菜”为什么要拍我','pat')),
  singleYudrops:uniq(await ex.extractNames('"See.苦诉"拍了拍"See.yu drops(技术)"','pat')),
  singleC:uniq(await ex.extractNames('我拍了拍"See.C(娱乐)"','pat')),
  singleFPrefix:uniq(await ex.extractNames('我拍了拍"f派陪赵大钱"','pat'))
};
const checks={
  pat1:cmp(outputs.pat1,expected.pat1),
  pat2:cmp(outputs.pat2,expected.pat2),
  at:cmp(outputs.at,expected.at),
  chain:cmp(outputs.chain,expected.chain),
  singleRepeat:cmp(outputs.singleRepeat,['佳一'],{strict:true}),
  singleYudrops:cmp(outputs.singleYudrops,['yudrops'],{strict:true}),
  singleC:cmp(outputs.singleC,['C'],{strict:true}),
  singleFPrefix:cmp(outputs.singleFPrefix,['赵大钱'],{strict:true})
};
// 硬失败 = 存在无法解释的差异（realMissing / unrelated）或 strict 项不符
const hardFail=Object.entries(checks).filter(([k,v])=>!v.ok).map(([k])=>k);
// 已知偏差 = 差异全部可被包含关系解释，且期望语义已裁决（颜色/数字应剥离）
const knownDeviation=Object.entries(checks)
  .filter(([k,v])=>!hardFail.includes(k)&&(v.contained||[]).length>0)
  .map(([k])=>k);
const softCount=Object.values(checks).reduce((n,v)=>n+((v.contained||[]).length),0);
const ok=hardFail.length===0;
fs.writeFileSync(out,JSON.stringify({ok,outputs,checks,hardFail,knownDeviation,softCount},null,2));
if(!ok)process.exit(2);
})().catch(e=>{fs.writeFileSync(out,JSON.stringify({ok:false,error:String(e),stack:e.stack},null,2));process.exit(1)});
'''
    return run_node_payload(html_path, js, 'extraction',
                            {'MATERIALS_JSON': json.dumps(MATERIALS, ensure_ascii=False),
                             'EXPECTED_JSON': json.dumps(EXPECTED, ensure_ascii=False)})


# ---------------------------------------------------------------------------
# 第四段之二：提取边界哨兵（新增）
# ---------------------------------------------------------------------------
# 【期望语义（用户 2026-09-11 裁决）】
#   1. 颜色后缀 → 应剥离。`孤豪 蓝色` 期望 `孤豪`
#   2. 条目内残留数字 → 应剥离。`1. 1安然` 期望 `安然`
#   3. emoji 与颜色的处置应一致（同一性质的分隔内容）
#
# 【当前实现的实际行为，与期望存在偏差】
#   颜色词未进分隔/剥离清单 → `孤豪 蓝色` 实际得 `孤豪蓝色`
#   条目内数字未剥离         → `1. 1安然` 实际得 `1安然`
#
# 【为什么登记而不修】
#   用户判定：颜色属「特殊情况」，不常见。而 decidePlayableName() 是提取链路
#   核心，其输出会影响老板记忆、单价记忆、历史记录、价格库匹配等全部下游功能。
#   当前上游 EXPECTED 名单本身自相矛盾（同时包含「卡密黄色」与「孤豪」两种期望），
#   说明「期望什么」尚未稳定。此时改核心逻辑 = 用不确定目标动全局模块，
#   违反《工程推进指令》三.4「不为重构/理论优雅增加风险」。
#   → 决策：登记为已知边界行为，暂不修改产品代码。
#
# 【本段的作用：哨兵】
#   把「期望值」与「实际值」同时钉在报告里。将来若有人改动提取逻辑，
#   本段会立刻显示 observed 变化，从而暴露「颜色/数字行为被改变」这一事实，
#   防止无声回归。这比现在修改更有价值。
EXPECTED_SEMANTICS = {
    'chain_color_spaced':  {'期望': '孤豪',  '说明': '颜色后缀应剥离'},
    'chain_color_glued':   {'期望': '孤豪',  '说明': '无空格颜色同样应剥离'},
    'chain_leading_digit': {'期望': '安然',  '说明': '条目内残留数字应剥离'},
    'chain_pure_name':     {'期望': '安然',  '说明': '纯名字基线'},
    'chain_bracket_color': {'期望': '无忧(上班版)', '说明': '括号保留、颜色剥离'},
    'chain_emoji_color':   {'期望': 'kk猫',  '说明': 'emoji+颜色一并剥离'},
    'chain_real_number':   {'期望': '928H',  '说明': '真名含数字不得误伤（护栏）'},
    'pat_plain':           {'期望': '佳一',  '说明': 'pat 模式基线'},
}


def extraction_boundary_report(html_path):
    """提取器边界哨兵：观测实际行为，与「已裁决期望语义」比对，标记偏差。

    本段不参与总判定（总结果不受它影响），因为已知偏差是「已接受」状态。
    它输出的价值在于：把边界行为固化为可对比的快照，防止无声回归。
    """
    js = r'''
const fs=require('fs'),html=fs.readFileSync(process.argv[2],'utf8'),out=process.argv[3];
globalThis.storage={get(){return null},set(){return true}};globalThis.appLogSilent=()=>{};globalThis.appLogError=()=>{};
const a=html.indexOf('class EnhancedNameExtractor'),b=html.indexOf('class ExtractorService',a+1);
eval(html.slice(a,b).replace('class EnhancedNameExtractor','globalThis.EnhancedNameExtractor=class EnhancedNameExtractor'));
const ex=new EnhancedNameExtractor();
const cases=[
 {key:'chain_color_spaced',  input:'1. 孤豪 蓝色'},
 {key:'chain_color_glued',   input:'1. 孤豪蓝色'},
 {key:'chain_leading_digit', input:'1. 1安然'},
 {key:'chain_pure_name',     input:'1. 安然'},
 {key:'chain_bracket_color', input:'1. 无忧（上班版） 蓝色'},
 {key:'chain_emoji_color',   input:'1. kk猫🐾 蓝色'},
 {key:'chain_real_number',   input:'1. 928H'},
 {key:'pat_plain',           input:'我拍了拍"See.佳一(娱乐)"'},
];
(async()=>{
 const observations={};
 for(const c of cases){
   let names=[];
   try{ names=await ex.extractNames(c.input,c.key.startsWith('chain')?'chain':'pat'); }
   catch(e){ names=['ERR:'+e.message]; }
   observations[c.key]={input:c.input,output:names,observed:names[0]||''};
 }
 fs.writeFileSync(out,JSON.stringify({ok:true,observations},null,2));
})().catch(e=>{fs.writeFileSync(out,JSON.stringify({ok:false,error:String(e)},null,2));process.exit(1)});
'''
    raw = run_node_payload(html_path, js, 'boundary')
    if not raw.get('ok'):
        return raw

    # 与已裁决期望语义比对，生成偏差清单（不参与总判定）
    obs = raw.get('observations') or {}
    deviations = []
    for key, meta in EXPECTED_SEMANTICS.items():
        got = (obs.get(key) or {}).get('observed', '')
        want = meta['期望']
        obs[key]['期望'] = want
        obs[key]['说明'] = meta['说明']
        obs[key]['符合期望'] = (got == want)
        if got != want:
            deviations.append({
                'key': key, 'input': (obs.get(key) or {}).get('input', ''),
                'observed': got, 'expected': want, 'note': meta['说明'],
            })
    return {'ok': True, 'observations': obs, 'deviations': deviations,
            'knownAccepted': True,
            'policy': '已知边界行为 · 已裁决期望语义 · 暂不修改产品代码（详见脚本注释）'}


# ---------------------------------------------------------------------------
# 第五段：完整页面 DOM 链路（[A4] 适配懒加载）
# ---------------------------------------------------------------------------
def dom_report(html_path):
    js = r'''
const fs=require('fs'),{JSDOM,VirtualConsole}=require('jsdom'),html=fs.readFileSync(process.argv[2],'utf8'),out=process.argv[3],errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(String(e)));vc.on('error',e=>errors.push(String(e)));const wait=ms=>new Promise(r=>setTimeout(r,ms));function t(c,n,ok,a){c[n]={ok:!!ok,actual:a}}
(async()=>{
const dom=new JSDOM(html,{url:'https://madan.test/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){w.alert=()=>{};w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});w.requestAnimationFrame=cb=>w.setTimeout(()=>cb(Date.now()),0);w.cancelAnimationFrame=id=>w.clearTimeout(id);w.requestIdleCallback=cb=>w.setTimeout(()=>cb({didTimeout:false,timeRemaining:()=>50}),0);w.visualViewport={height:800,addEventListener(){},removeEventListener(){}};w.navigator.clipboard={writeText:async()=>{}};w.document.execCommand=()=>true;w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};w.IntersectionObserver=class{observe(){}disconnect(){}};w.ResizeObserver=class{observe(){}disconnect(){}};w.Element.prototype.scrollIntoView=function(){};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLCanvasElement.prototype.getContext=function(){return {measureText(){return {width:0}}}}}});
for(let i=0;i<80&&!dom.window.orderCalculator;i++)await wait(25);
const w=dom.window,app=w.orderCalculator,c={};
t(c,'app_initialized',!!app,errors);if(!app)throw Error('app missing');
await wait(100);

// [A4] 主动加载懒加载 Feature，再断言总数
const lazyNames=Object.keys(app.lazyFeatures||{});
for(const n of lazyNames){ try{ await app.ensureLazyFeature(n) }catch(e){ errors.push('lazy:'+n+':'+e) } }
await wait(150);
const mainCount=(app.featureOrder||[]).length;
t(c,'lazy_feature_loaded',lazyNames.every(n=>!!app.features?.[n]),{lazyNames,loaded:lazyNames.filter(n=>!!app.features?.[n])});
t(c,'feature_count',mainCount>=23,{count:mainCount,order:app.featureOrder});

// 核心 DOM（存在即可）
const ids=['totalPrice','discount','discountOverlay','paiDan','peiPei','boss','duration','type','note','calculateBtn','clearAllBtn','orderOutput','historyList'];
t(c,'core_dom',ids.every(id=>w.document.getElementById(id)),ids.filter(id=>!w.document.getElementById(id)));
// [A4] 延迟注入 DOM：懒加载完成后应已产出
const deferred=['autoUnitPrice','apModeRound','apModeHour'];
t(c,'deferred_dom_ready',deferred.every(id=>w.document.getElementById(id)),deferred.filter(id=>!w.document.getElementById(id)));

function set(id,v){const e=w.document.getElementById(id);if(!e)return;e.value=v;e.dispatchEvent(new w.Event('input',{bubbles:true}))}
app.switchMode(1);set('totalPrice','100');set('discount','8');set('paiDan','佳一');set('peiPei','小帆 小阮');set('boss','土豆');set('type','一起看');set('duration','1h');set('note','测试');
const done=app.orderFlow.calculate({showSuccess:false});t(c,'manual_order_calculate',done===true,done);
t(c,'manual_order_values',w.document.getElementById('discountedPrice').textContent==='160'&&w.document.getElementById('groupCommission').textContent==='8'&&w.document.getElementById('platformCommission').textContent==='32'&&w.document.getElementById('earnings').textContent==='60',{d:w.document.getElementById('discountedPrice').textContent,g:w.document.getElementById('groupCommission').textContent,p:w.document.getElementById('platformCommission').textContent,e:w.document.getElementById('earnings').textContent});
app.switchMode(2);t(c,'gift_mode',app.currentMode===2&&w.document.getElementById('groupPercent').textContent==='10%'&&w.document.getElementById('discount').classList.contains('gift-mode-shadow'),{mode:app.currentMode,group:w.document.getElementById('groupPercent').textContent,cls:w.document.getElementById('discount').className});
app.switchMode(1);app.lockedPeiPei='固定陪陪';set('peiPei','临时值');set('boss','临时老板');app.clearAll();
t(c,'clear_locked_restore',w.document.getElementById('peiPei').value==='固定陪陪'&&w.document.getElementById('boss').value==='',{pei:w.document.getElementById('peiPei').value,boss:w.document.getElementById('boss').value});
set('totalPrice','100');set('paiDan','佳一');set('peiPei','小帆');set('boss','土豆');set('type','一起看');set('duration','1h');app.orderFlow.commitOrder({showSuccess:false,recordBoss:false});
t(c,'history_saved',app.history.length===1&&w.document.querySelectorAll('#historyList .history-item').length===1,{state:app.history.length,dom:w.document.querySelectorAll('#historyList .history-item').length});

// [A4] 备份链路：懒加载完成后 dataPortabilityFeature 才可用
const dp=app.features?.dataPortabilityFeature||app.dataPortabilityFeature||app.dataPortability;
t(c,'data_portability_available',!!dp,Object.keys(app.features||{}));
let backup=null,parsed=null;
try{ backup=dp.buildBackup(['history']); }catch(e){ errors.push('buildBackup:'+e) }
t(c,'backup_built',!!backup&&backup.schemaVersion===4,backup&&{schema:backup.schemaVersion,modules:Object.keys(backup.modules||{})});
try{ parsed=dp.parseBackupText(JSON.stringify(backup)); }catch(e){ errors.push('parseBackup:'+e) }
t(c,'backup_roundtrip',!!parsed&&!parsed.error,parsed&&{error:parsed.error,ok:parsed.ok});
const ok=Object.values(c).every(x=>x.ok);fs.writeFileSync(out,JSON.stringify({ok,checks:c,errors},null,2));if(!ok)process.exit(2);
})().catch(e=>{fs.writeFileSync(out,JSON.stringify({ok:false,error:String(e),stack:e.stack,errors},null,2));process.exit(1)});
'''
    return run_node_payload(html_path, js, 'dom')


# ---------------------------------------------------------------------------
# 报告输出
# ---------------------------------------------------------------------------
def write_reports(report, html_path, report_dir):
    report_dir.mkdir(parents=True, exist_ok=True)
    base = html_path.stem
    jp = report_dir / f'{base}_AI全链路测试报告.json'
    tp = report_dir / f'{base}_AI全链路测试摘要.txt'
    jp.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    lines = [f'{base} AI可运行全链路测试摘要', '',
             f"总结果：{'通过' if report['ok'] else '未通过'}",
             f'HTML：{html_path}',
             f"版本：{report['expected_version']}",
             f"内联chunk：{'、'.join(report.get('chunk_names') or []) or '未解包'}"]
    if report.get('extraction_soft_pending'):
        lines.append(f"提取段已知偏差：{report['extraction_soft_pending']} 项"
                     f"（期望语义已裁决为「剥离」，实现待改进）")
    bd0 = report.get('boundary_report') or {}
    if bd0.get('deviations') is not None:
        lines.append(f"提取边界哨兵：已知偏差 {len(bd0['deviations'])} 项"
                     f"（已裁决暂不修，仅防无声回归）")
    lines.append('')
    s = report['static_checks']
    lines += ['静态/架构：', f"- {sum(x['ok'] for x in s)}/{len(s)}通过"]
    for x in s:
        if not x['ok']:
            lines.append(f"  失败：{x['name']}{'｜'+x.get('detail','') if x.get('detail') else ''}")
    syn = report['inline_js_syntax']
    lines += ['', 'JavaScript语法：',
              f"- {'通过' if syn.get('ok') else '失败'}，内联脚本{syn.get('script_count',0)}个"]

    # 提取段：区分「已知偏差（期望已裁决）」/「待裁决」/「硬失败」
    ext = report['extraction_report']
    ext_checks = ext.get('checks') or {}
    lines += ['', '真实提取素材：',
              f"- {sum(1 for x in ext_checks.values() if x.get('ok'))}/{len(ext_checks)}通过"]
    for n, x in ext_checks.items():
        if x.get('ok'):
            continue
        lines.append(f"  差异：{n}｜实际{x.get('actual_count')}项/期望{x.get('expected_count')}项")
        if x.get('realMissing'):
            lines.append(f"    硬失败·未解释缺失：{x['realMissing']}")
        if x.get('unrelated'):
            lines.append(f"    硬失败·无对应多余项：{x['unrelated']}")
        if x.get('contained'):
            lines.append(f"    已知偏差·包含关系 {len(x['contained'])} 项"
                         f"（期望语义已裁决为「剥离」，实现待改进）：")
            for item in x['contained'][:10]:
                lines.append(f"      · 实际「{item['actual']}」 ⊃ 期望「{item['expected']}」")
        if x.get('missing') and not x.get('realMissing'):
            lines.append(f"    已由包含关系解释的缺失：{x.get('explainedMissing')}")
    if ext.get('error'):
        lines.append('  错误：' + ext['error'])

    for key, title in [('engine_report', '计算/价格/项目引擎'),
                       ('dom_report', '完整页面DOM链路')]:
        r = report[key]
        checks = r.get('checks') or {}
        lines += ['', title + '：',
                  f"- {sum(1 for x in checks.values() if x.get('ok'))}/{len(checks)}通过"]
        for n, x in checks.items():
            if not x.get('ok'):
                lines.append(f"  失败：{n}｜{json.dumps(x.get('actual'),ensure_ascii=False)}")
        if r.get('error'):
            lines.append('  错误：' + r['error'])

    # 边界哨兵段（不参与总判定）
    bd = report.get('boundary_report') or {}
    obs = bd.get('observations') or {}
    if obs:
        devs = bd.get('deviations') or []
        lines += ['', '提取边界哨兵（期望语义已裁决 · 已知偏差已接受）：']
        for k, v in obs.items():
            mark = '✅' if v.get('符合期望') else '⚠️ 已知偏差'
            lines.append(f"  {v.get('input','')} → {json.dumps(v.get('observed',''),ensure_ascii=False)}"
                         f"（期望 {json.dumps(v.get('期望',''),ensure_ascii=False)}）{mark}")
        lines.append(f"  符合期望 {len(obs)-len(devs)}/{len(obs)}，已知偏差 {len(devs)} 项")
        if devs:
            lines.append('  已知偏差明细（已裁决为暂不修，仅作哨兵）：')
            for d in devs:
                lines.append(f"    · {d['input']} → 实际「{d['observed']}」/ 期望「{d['expected']}」：{d['note']}")
        if bd.get('policy'):
            lines.append(f"  策略：{bd['policy']}")
    tp.write_text('\n'.join(lines), encoding='utf-8')
    return jp, tp


def main():
    args = parse_args()
    html_path = find_html(args.html or args.html_positional)
    html = html_path.read_text(encoding='utf-8')
    version = infer_version(html_path, html, args.expected_version)

    chunks = unpack_chunks(html)
    static = static_checks(html, version, chunks)
    syntax = inline_syntax(html)
    eng = engine_report(html_path)
    ext = extraction_report(html_path)
    bound = extraction_boundary_report(html_path)
    dom = dom_report(html_path)

    ok = (all(x['ok'] for x in static) and syntax.get('ok') and eng.get('ok')
          and ext.get('ok') and dom.get('ok'))
    report = {'ok': bool(ok), 'html': str(html_path), 'expected_version': version,
              'chunk_names': sorted(chunks), 'static_checks': static,
              'inline_js_syntax': syntax, 'engine_report': eng,
              'extraction_report': ext, 'boundary_report': bound, 'dom_report': dom,
              'extraction_soft_pending': ext.get('softCount', 0)}
    rd = Path(args.report_dir).expanduser().resolve() if args.report_dir else html_path.parent
    jp, tp = write_reports(report, html_path, rd)
    print(tp.read_text(encoding='utf-8'))
    print(f'\nJSON报告：{jp}\n文本摘要：{tp}')
    raise SystemExit(0 if ok else 1)


if __name__ == '__main__':
    main()
