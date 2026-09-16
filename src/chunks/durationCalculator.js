// ============================================
// 时长计算 Feature（DurationCalculatorFeature）· 内联 chunk
// 职责：时长/局数输入表单的渲染与交互，调用 DurationCalculatorEngine 计算档位并回填主表单。
// 说明：本文件为「内联 chunk」，源码存于 index.html 的 __INLINE_CHUNKS_RAW__ 单行字符串中，
//       由 InlineChunkLoader 延迟加载。修改后必须同步更新该字符串，否则运行时与源文件不一致。
// ============================================
window.DurationCalculatorFeature = class {
 constructor(app) {
 this.app = app;
 this.engine = DurationCalculatorEngine;
 this.selectedFill = null;
 this.fillTarget = 'type';
 this.fillButtonIds = ['dcFillTypeBtn'];
 this.boxOrder = ['dcStartH', 'dcStartM', 'dcEndH', 'dcEndM'];
 this.numberInputIds = ['dcTotalGames', 'dcSettleGames'];
 this.boxMax = { dcStartH: 23, dcStartM: 59, dcEndH: 23, dcEndM: 59 };
 this._initialized = false;
 this._ready = false;
 }

 // DurationCalculatorFeature 依赖清单：显式声明渲染、输入流、弹窗与主表单协作边界。
 get uiRender() { return this.app.uiRender; }
 get inputFlowFeature() { return this.app.inputFlowFeature; }
 get autoPriceFeature() { return this.app.autoPriceFeature; }
 get dialogManager() { return window.appDialogManager; }
 getElement(...args) { return this.uiRender.getElement(...args); }
 escapeHtml(...args) { return this.uiRender.escapeHtml(...args); }
 setRenderedHtml(...args) { return this.uiRender.setRenderedHtml(...args); }
 renderAttributes(...args) { return this.uiRender.renderAttributes(...args); }
 renderButtonMarkup(...args) { return this.uiRender.renderButtonMarkup(...args); }
 renderDialogHeader(...args) { return this.uiRender.renderDialogHeader(...args); }
 showSuccess(...args) { return this.app.showSuccess(...args); }
 scrollBossInputIntoView(...args) { return this.app.scrollBossInputIntoView(...args); }

 getInputConfigs() {
 return [
 { label: '游戏时间段', type: 'timeBoxes' },
 {
 label: '局数（总局 / 达标）',
 controls: [
 { id: 'dcTotalGames', type: 'number', attrs: { min: '0', placeholder: '0', inputmode: 'numeric', pattern: '[0-9]*' } },
 { tag: 'span', className: 'dc-sep', text: '/' },
 { id: 'dcSettleGames', type: 'number', attrs: { min: '0', placeholder: '0', inputmode: 'numeric', pattern: '[0-9]*' } }
 ],
 quickButtons: [
 { id: 'dcAllWinBtn', className: 'dc-quick-btn', label: '🏆 全达标' },
 { id: 'dcResetBtn', className: 'dc-quick-btn', label: '🔄 重置' }
 ]
 }
 ];
 }

 getStatConfigs() {
 return [
 { label: '总时长', valueHtml: '<div class="dc-stat-value" id="dcDuration">--</div>' },
 { label: '达标情况', valueHtml: '<div class="dc-stat-value" id="dcGamesInfo">--</div>' },
 { label: '总分钟 / 溢出', valueHtml: '<div class="dc-stat-value"><span id="dcMinutes">--</span> (<span id="dcOvertime">--</span>)</div>' },
 { label: '时长最大局数上限', valueHtml: '<div class="dc-stat-value" id="dcMaxGames">--</div>' }
 ];
 }

 getFillActionConfigs() {
 return [
 { id: 'dcFillTypeBtn', className: 'dc-fill-btn dc-fill-btn-type', labelHtml: '填入<br>服务类型<br><span style="font-weight:normal;opacity:0.9;font-size:11px;">+服务时长</span><br><small style="font-weight:normal;opacity:0.82;font-size:10px;">多项目</small>' }
 ];
 }

 renderInputGroup(group) {
 if (group.type === 'timeBoxes') {
 const renderBox = id => `<input type="tel" id="${id}" class="dc-box-input" maxlength="2" inputmode="numeric" pattern="[0-9]*" placeholder="00" autocomplete="off">`;
 const renderPair = ([hourId, minuteId]) => `<div class="dc-time-pair">${renderBox(hourId)}<span class="dc-time-colon">:</span>${renderBox(minuteId)}</div>`;
 const timeBoxes = [['dcStartH', 'dcStartM'], ['dcEndH', 'dcEndM']].map(renderPair).join('<span class="dc-sep">至</span>');
 return `<div class="dc-input-group"><label>${this.escapeHtml(group.label)}</label><div class="dc-time-row">${timeBoxes}</div><div class="dc-next-day-hint hidden" id="dcNextDayHint">🌙 次日</div></div>`;
 }
 const controls = group.controls.map(control => {
 if (control.tag === 'span') return `<span class="${control.className}">${this.escapeHtml(control.text)}</span>`;
 return `<input ${this.renderAttributes({ id: control.id, type: control.type, value: control.value, ...control.attrs })}>`;
 }).join('');
 const quickButtons = group.quickButtons ? `<div class="dc-quick-btns">${group.quickButtons.map(button => this.renderButtonMarkup(button)).join('')}</div>` : '';
 return `<div class="dc-input-group"><label>${this.escapeHtml(group.label)}</label><div class="dc-flex">${controls}</div>${quickButtons}</div>`;
 }

 renderLayout() {
 return this.setRenderedHtml('durationCalcContent', `
 ${this.renderDialogHeader({ className: 'duration-calc-header dialog-header', title: '⏱️ 时长结算计算器', close: { id: 'durationCalcCloseBtn', className: 'duration-calc-close', modalId: 'durationCalcModal', label: '退出时长结算计算器' } })}
 <div class="duration-calc-body app-modal__body">
 <div class="dc-input-grid">${this.getInputConfigs().map(group => this.renderInputGroup(group)).join('')}</div>
 <div class="dc-result-box" id="dcResultBox">
 <div class="dc-highlight"><div class="dc-label">最终结算标准</div><div class="dc-value" id="dcStandard">--</div><div class="dc-sub" id="dcLogic">等待输入数据...</div><div class="dc-hint" id="dcExplain">--</div></div>
 <div class="dc-stats">${this.getStatConfigs().map(stat => `<div class="dc-stat"><div class="dc-stat-label">${this.escapeHtml(stat.label)}</div>${stat.valueHtml}</div>`).join('')}</div>
 </div>
 <details class="dc-rules"><summary>📋 结算规则参考</summary><div class="dc-rules-body"><p>• <strong>全达标/普排：</strong>优先判定特殊时间档位（如1小时、1.5小时等）。</p><p>• <strong>部分达标：</strong>按“达标局数”结算，但受限于“总时长”可承载的最大局数。</p><p>• <strong>时间余量：</strong>超过整小时 10 分钟及以内不计局，超过 10 分钟按加 1 局计算。</p><div class="dc-rules-note">⚠️ 仅供参考，具体结算时长视具体情况而定。</div></div></details>
 <div class="dc-fill-section" id="dcFillSection" style="display:none;"><div class="dc-fill-title">✅ 选择格式后填入多项目服务类型</div><div class="dc-fill-options" id="dcFillOptions"></div><div class="dc-fill-actions">${this.getFillActionConfigs().map(button => this.renderButtonMarkup({ ...button, attrs: { disabled: true } })).join('')}</div><div class="dc-rules-note">默认已选“标准结算形式”；填入后会追加到服务类型，并同步更新服务时长用于多项目汇总。</div></div>
 </div>`);
 }

 setText(id, text) { const element = this.getElement(id); if (element) element.textContent = text; }
 setHidden(element, hidden) { if (!element) return; element.classList.toggle('hidden', hidden); if (hidden) element.textContent = ''; }
 getBoxTime(prefix) {
 const hour = Math.min(parseInt(this.getElement(`dc${prefix}H`)?.value, 10) || 0, 23);
 const minute = Math.min(parseInt(this.getElement(`dc${prefix}M`)?.value, 10) || 0, 59);
 return hour * 60 + minute;
 }
 updateNextDay() {
 const hint = this.getElement('dcNextDayHint');
 const hasEnd = Boolean(this.getElement('dcEndH')?.value) || Boolean(this.getElement('dcEndM')?.value);
 const nextDay = hasEnd && this.getBoxTime('End') < this.getBoxTime('Start');
 if (hint && nextDay) hint.textContent = '🌙 次日';
 this.setHidden(hint, !nextDay);
 return nextDay;
 }
 refresh() { this.updateNextDay(); return this.calculate(); }
 calculate() {
 let start = this.getBoxTime('Start');
 let end = this.getBoxTime('End');
 let duration = end - start;
 if (duration < 0) duration += 1440;
 const totalGames = parseInt(this.getElement('dcTotalGames')?.value, 10) || 0;
 const isAllWin = this.getElement('dcTotalGames')?.value === '';
 const settledGames = parseInt(this.getElement('dcSettleGames')?.value, 10) || 0;
 const maxGames = this.engine.getMaxGames(duration);
 const result = this.engine.analyze(duration, isAllWin, settledGames, maxGames);
 [['dcDuration', `${Math.floor(duration / 60)}h ${duration % 60}m`], ['dcGamesInfo', isAllWin ? '自动全胜判定' : `${settledGames} / ${totalGames}`], ['dcMinutes', `${duration}min`], ['dcMaxGames', `${maxGames}局`], ['dcOvertime', duration % 60 > 10 ? `超${duration % 60}m` : `余${duration % 60}m`], ['dcStandard', result.st], ['dcLogic', result.lg], ['dcExplain', result.ex]].forEach(([id, text]) => this.setText(id, text));
 if (result.st && result.st !== '--') this.buildFillOptions(result.st, duration); else this.clearFillOptions();
 return { duration, totalGames, isAllWin, settledGames, maxGames, ...result };
 }
 updateFillTargetButtons() {
 const hasFill = Boolean(this.selectedFill);
 this.fillButtonIds.forEach(id => {
 const button = this.getElement(id);
 if (!button) return;
 button.disabled = !hasFill;
 button.classList.toggle('selected', id === 'dcFillTypeBtn');
 });
 }
 clearFillOptions() {
 this.selectedFill = null;
 const section = this.getElement('dcFillSection');
 if (section) section.style.display = 'none';
 this.updateFillTargetButtons();
 }
 buildFillOptions(standard, duration) {
 const section = this.getElement('dcFillSection');
 const optionsBox = this.getElement('dcFillOptions');
 if (!section || !optionsBox) return false;
 const options = this.engine.formatOptions(standard, duration);
 const defaultOption = options.find(option => option.label === '标准结算形式') || options[0];
 const retainedOption = options.find(option => option.val === this.selectedFill);
 this.selectedFill = (retainedOption || defaultOption)?.val || null;
 this.fillTarget = 'type';
 section.style.display = 'block';
 optionsBox.innerHTML = options.map(option => `
 <button class="dc-fill-option ${option.val === this.selectedFill ? 'selected' : ''}" data-val="${this.escapeHtml(option.val)}">
 <div class="dc-opt-val">${this.escapeHtml(option.val)}</div>
 <div class="dc-opt-label">${this.escapeHtml(option.label)}</div>
 </button>`).join('');
 this.updateFillTargetButtons();
 return true;
 }
 selectFill(button, value) {
 this.getElement('dcFillOptions')?.querySelectorAll('.dc-fill-option').forEach(item => item.classList.remove('selected'));
  button?.classList.add('selected');
 this.selectedFill = value;
 this.updateFillTargetButtons();
 }
 setFillInput(id, value, append = false, { emitEvents = true, separator = ' ', source = 'durationCalculator' } = {}) {
 const input = this.getElement(id);
 if (!input) return false;
 const current = String(input.value ?? '');
 const incoming = String(value ?? '');
 const nextValue = append && current.trim() ? `${current.trimEnd()}${separator}${incoming}` : incoming;
 if (emitEvents) return this.inputFlowFeature.writeInputValue(id, incoming, { append, separator, emitChange: true, source });
 return this.inputFlowFeature.setInputValue(id, nextValue, { sync: true, source });
 }
 applySelectedFill() {
 const section = this.getElement('dcFillSection');
 if (!this.selectedFill || !section || section.style.display === 'none') return false;
 this.fillTarget = 'type';
 this.updateFillTargetButtons();
 const autoPrice = this.autoPriceFeature;
 const previousSyncing = Boolean(autoPrice?.syncing);
 autoPrice?.cancelExpressionSync?.();
 if (autoPrice) autoPrice.syncing = true;
 let filledType = false;
 let filledDuration = false;
 try {
 filledType = this.setFillInput('type', this.selectedFill, true, { emitEvents: false, separator: ' + ' });
 filledDuration = this.setFillInput('duration', this.selectedFill, false, { emitEvents: false });
 } finally {
 if (autoPrice) autoPrice.syncing = previousSyncing;
 }
 const filled = Boolean(filledType || filledDuration);
 if (!filled) return false;
 const finalInput = this.getElement('type');
 this.inputFlowFeature.emitFieldEvents(finalInput, { change: true, source: 'durationCalculator', meta: { filledDuration: this.selectedFill } });
 this.showSuccess(`已填入多项目服务类型 + 服务时长：${this.selectedFill}`);
 return true;
 }
 applyFillAndClose() {
 if (!this.applySelectedFill()) return false;
 this.closeModal();
 this.scrollBossInputIntoView({ defer: true });
 return true;
 }
 reset() {
 [...this.boxOrder, ...this.numberInputIds].forEach(id => { const element = this.getElement(id); if (element) element.value = ''; });
 this.fillTarget = 'type';
 this.updateNextDay();
 return this.calculate();
 }
 settleAllWin() {
 const total = this.getElement('dcTotalGames')?.value;
 if (!total || parseInt(total, 10) === 0) return false;
 this.getElement('dcSettleGames').value = total;
 this.calculate();
 return true;
 }
 openModal() { this.uiRender.openModal('durationCalcModal'); this.calculate(); return true; }
 closeModal() { return this.uiRender.closeModal('durationCalcModal'); }
 bindClick(id, handler) { const element = this.getElement(id); if (!element) return false; element.addEventListener('click', handler); return true; }
 bindEvents() {
 if (this._eventsBound) return false;
 this._eventsBound = true;
 this.dialogManager.register([{ el: this.getElement('durationCalcModal'), close: () => this.closeModal() }]);
 [['durationCalcBtn', () => this.openModal()], ['dcFillTypeBtn', () => this.applyFillAndClose()], ['dcResetBtn', () => this.reset()], ['dcAllWinBtn', () => this.settleAllWin()]].forEach(([id, handler]) => this.bindClick(id, handler));
 const fillOptions = this.getElement('dcFillOptions');
 fillOptions?.addEventListener('pointerdown', event => {
 const button = event.target.closest('.dc-fill-option');
 if (!button) return;
 event.preventDefault();
 this.selectFill(button, button.dataset.val);
 });
 fillOptions?.addEventListener('click', event => { const button = event.target.closest('.dc-fill-option'); if (button) this.selectFill(button, button.dataset.val); });
 this.boxOrder.forEach((id, index) => {
 const element = this.getElement(id);
 if (!element) return;
 element.addEventListener('input', () => {
 element.value = element.value.replace(/\D/g, '');
 if (element.value.length >= 2) {
 element.value = String(Math.min(parseInt(element.value, 10) || 0, this.boxMax[id])).padStart(2, '0');
 const next = this.getElement(this.boxOrder[index + 1]);
 if (next) { next.focus(); next.select(); }
 }
 this.refresh();
 });
 element.addEventListener('keydown', event => {
 if (event.key !== 'Backspace' || element.value !== '' || index <= 0) return;
 event.preventDefault();
 const previous = this.getElement(this.boxOrder[index - 1]);
 if (previous) { previous.focus(); previous.value = ''; }
 this.refresh();
 });
 element.addEventListener('blur', () => {
 if (element.value !== '') element.value = String(Math.min(parseInt(element.value, 10) || 0, this.boxMax[id])).padStart(2, '0');
 this.refresh();
 });
 element.addEventListener('focus', () => element.select());
 });
 this.numberInputIds.forEach(id => ['input', 'change'].forEach(type => this.getElement(id)?.addEventListener(type, () => this.calculate())));
 }
 start() {
 if (this._ready) return false;
 this._ready = true;
 this.bindEvents();
 return true;
 }
 init() {
 if (this._initialized) return;
 this._initialized = true;
 AppLifecycle.onAppReady(() => this.start());
 }
}
