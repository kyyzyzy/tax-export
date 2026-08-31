/**
 * content/datepickers.js —— Element UI 日期组件操作
 *
 * 真机 DOM 校准（2026-08 实测面板结构）：
 *   税款所属期 = 两个独立 month picker(.el-date-editor input)
 *     面板: .el-picker-panel.el-date-picker
 *     年份显示: 头部「YYYY 年」(第一个 .el-date-picker__header-label)
 *     月份/年份/日期三张 table 共存于面板内,只有目标那张 display != 'none'
 *       el-date-table / el-year-table / el-month-table
 *     月份格: .el-month-table td,文字「1月」..「12月」(在 td 文本或内层 a.cell)
 *     年切换: button[aria-label="前一年"|"后一年"] / .el-icon-d-arrow-{left,right}
 *
 *   申报日期   = 两个独立 date picker(.el-date-editor--date input)
 *     面板: 同上 class,日视图(el-date-table 可见)
 *     年/月显示: 头部第 1 个 label = 年,第 2 个 label = 月
 *     月切换: button[aria-label="上个月"|"下个月"] / .el-icon-arrow-{left,right}
 *     日格: .el-date-table td(排除 .prev/.next/.disabled)
 *
 * 关键问题(2026-08 实测):
 *   1. 页面同时存在多个 .el-picker-panel,切换年/月时每轮重查 visiblePanels()[0]
 *      会漂移到错误面板 → 锁定一个面板引用,后续操作全部限定在其子树内。
 *   2. 普通合成 click(detail=0、无坐标)在部分加固页面不会弹出日期面板
 *      (弹层由组件内 Vue 处理器控制,可能校验 detail/isTrusted)。
 *      因此采用「点击弹面板 → 直接写入 input 值 → Vue 实例改值」三级兜底,
 *      每级都校验最终 input 值是否变成目标值。
 */
(function () {
  'use strict';
  var T = window.__taxExport;

  /** 取所有「可见」的 date-picker 面板 */
  function visiblePanels() {
    return T.qsa('.el-picker-panel.el-date-picker').filter(function (p) {
      if (p.style.display === 'none') return false;
      return T.isVisible(p);
    });
  }

  /** 循环 cond() 直到返回 true;每次失败 sleep pause,最多 maxIter 次 */
  function repeatUntil(cond, maxIter, pause) {
    pause = pause || 120;
    maxIter = maxIter || 30;
    var i = 0;
    var step = function () {
      if (cond()) return true;
      if (++i > maxIter) throw new Error('导航超过最大次数');
      return T.sleep(pause).then(step);
    };
    return Promise.resolve(step());
  }

  /** 从一个已锁定的面板头部读年份(第 1 个 header-label 的 4 位数字) */
  function readYear(panel) {
    var labels = T.qsa('.el-date-picker__header-label', panel);
    var ym = (labels[0] && labels[0].textContent || '').match(/(\d{4})/);
    return ym ? parseInt(ym[1], 10) : null;
  }

  /** 从已锁定面板头部读月份(第 2 个 header-label 的数字) */
  function readMonth(panel) {
    var labels = T.qsa('.el-date-picker__header-label', panel);
    var mm = (labels[1] && labels[1].textContent || '').match(/(\d{1,2})/);
    return mm ? parseInt(mm[1], 10) : null;
  }

  /** 在「已锁定面板」内点年份切换按钮;返回是否点到了按钮 */
  function clickYearBtn(panel, earlier) {
    var btn = earlier
      ? panel.querySelector('button[aria-label="前一年"], .el-icon-d-arrow-left')
      : panel.querySelector('button[aria-label="后一年"], .el-icon-d-arrow-right');
    if (!btn) return false;
    if (!T.isVisible(btn)) {
      // 偶发:按钮 inline 隐藏但父级可见,仍可点
      try { T.clickEl(btn); return true; } catch (e) { return false; }
    }
    T.clickEl(btn);
    return true;
  }

  /** 在「已锁定面板」内点月份切换按钮 */
  function clickMonthBtn(panel, earlier) {
    // 真机 aria-label 为「上个月 / 下个月」,同时兼容历史文案
    var btn = earlier
      ? panel.querySelector('button[aria-label="上个月"], button[aria-label="上一月"], button[aria-label="前一个月"], .el-icon-arrow-left')
      : panel.querySelector('button[aria-label="下个月"], button[aria-label="下一月"], button[aria-label="后一个月"], .el-icon-arrow-right');
    if (!btn) return false;
    if (!T.isVisible(btn)) {
      try { T.clickEl(btn); return true; } catch (e) { return false; }
    }
    T.clickEl(btn);
    return true;
  }

  /** 锁定一个可见面板:等待面板出现并稳定,返回该 DOM 引用(后续操作都基于它) */
  function lockPanel() {
    return T.waitFor(function () { return visiblePanels().length > 0; }, 8000)
      .catch(function () { throw new Error('日期面板未出现(可见面板数=0)'); })
      .then(function () { return T.sleep(400); })
      .then(function () {
        var ps = visiblePanels();
        if (!ps.length) throw new Error('日期面板未出现(可见面板数=0)');
        return ps[0];
      });
  }

  /** 在「已锁定面板」内把年份切到 targetYear(month/date 面板通用) */
  function navigatePanelYear(panel, targetYear) {
    return repeatUntil(function () {
      var cur = readYear(panel);
      if (cur === null) throw new Error('读不到面板年份');
      if (cur === targetYear) return true;
      if (!clickYearBtn(panel, targetYear < cur)) throw new Error('找不到年份切换按钮');
      return false;
    }, 15, 140);
  }

  /** 在「已锁定面板」内把年/月切到目标(date picker 用) */
  function navigatePanelYM(panel, targetYear, targetMonth) {
    return repeatUntil(function () {
      var y = readYear(panel);
      var m = readMonth(panel);
      if (y === null || m === null) throw new Error('读不到面板年/月');
      if (y === targetYear && m === targetMonth) return true;
      if (y !== targetYear) {
        clickYearBtn(panel, targetYear < y);
        return false;
      }
      // 同年,切月
      if (m !== targetMonth) {
        clickMonthBtn(panel, targetMonth < m);
        return false;
      }
      return false;
    }, 30, 140);
  }

  /** 点月份格(限定在已锁定面板内;文字可能在 td 本身或内层 a.cell) */
  function clickMonthCell(panel, monthText) {
    var ok = false;
    T.qsa('.el-month-table td', panel).forEach(function (td) {
      if (ok) return;
      var txt = ((td.textContent || '')).replace(/\s+/g, '');
      if (txt === monthText) { T.clickEl(td); ok = true; }
    });
    if (!ok) {
      var texts = T.qsa('.el-month-table td', panel).map(function (td) { return (td.textContent || '').trim(); });
      throw new Error('未找到月份格「' + monthText + '」(面板内月份格文字:[' + texts.join(',') + '])');
    }
  }

  /** 点日格(限定在已锁定面板内,排除 prev/next/disabled) */
  function clickDayCell(panel, day) {
    var ok = false;
    T.qsa('.el-date-table td', panel).forEach(function (td) {
      if (ok) return;
      if (td.classList.contains('prev') || td.classList.contains('next') || td.classList.contains('disabled')) return;
      if ((td.textContent || '').trim() === String(day)) { T.clickEl(td); ok = true; }
    });
    if (!ok) {
      var dayTexts = T.qsa('.el-date-table td', panel).map(function (td) { return (td.textContent || '').trim(); });
      throw new Error('未找到日期格「' + day + '」号(面板内日格文字:[' + dayTexts.slice(0, 15).join(',') + '...])');
    }
  }

  /** 用 chrome.debugger(CDP)在元素中心发一次真鼠标左键单击(isTrusted=true)。
   *  这是打开瑞数加固页面日期面板的关键 —— 合成 JS 事件 isTrusted=false 会被组件忽略。
   *  返回 Promise<boolean>:CDP 成功派发返回 true;失败(权限被拒/attach 失败)返回 false。 */
  function cdpClick(el) {
    if (!el) return Promise.resolve(false);
    var rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { rect = { left: 0, top: 0, width: 0, height: 0 }; }
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    return T.sendMessage({ type: 'CDP_CLICK', x: x, y: y })
      .then(function (res) { return !!(res && res.ok); })
      .catch(function () { return false; });
  }

  /** 合成 JS 点击兜底(CDP 失败时用):pointer+mouse 完整序列,带坐标与 detail=1 */
  function jsClick(el) {
    if (!el) return;
    try { el.focus && el.focus(); } catch (e) {}
    var rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { rect = { left: 0, top: 0, width: 0, height: 0 }; }
    var opts = {
      bubbles: true, cancelable: true, view: window, button: 0, detail: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (type) {
      var ev;
      try { ev = new PointerEvent(type, opts); } catch (e) { ev = new MouseEvent(type, opts); }
      try { el.dispatchEvent(ev); } catch (e) {}
    });
    try { el.click(); } catch (e) {}
  }

  /** 点击元素:CDP 可信点击优先,失败回退 JS 合成点击。返回 Promise<void>。
   *  瑞数加固页面下,日期/年份面板只有 isTrusted=true 的真点击能打开。 */
  function realClick(el) {
    if (!el) return Promise.resolve();
    return cdpClick(el).then(function (ok) {
      if (ok) return;
      // CDP 失败(权限被拒/attach 失败/用户关了调试条)→ 回退 JS 合成点击
      jsClick(el);
    });
  }

  /** 尝试把日期输入框的日期面板点出来;返回是否出现可见面板。
   *  优先 CDP 点击 input,失败/无面板再 CDP 点击日历图标,最后回退 JS。 */
  function tryOpenPicker(input) {
    return realClick(input)
      .then(function () { return T.sleep(700); })
      .then(function () {
        if (visiblePanels().length) return true;
        // 兜底 1:点日历图标(el-input__icon),Element UI 同样会弹面板
        var editor = null;
        try { editor = input.closest ? input.closest('.el-date-editor') : null; } catch (e) {}
        if (!editor) return false;
        var icon = editor.querySelector('.el-input__icon');
        if (!icon) return false;
        return realClick(icon).then(function () { return T.sleep(700); })
          .then(function () { return visiblePanels().length > 0; });
      });
  }

  /** 直接写入 input 值并派发事件,让 Element 组件同步 v-model(绕过面板 UI)。
   *  readonly 不影响程序化写值;用原生 setter 绕过可能的 Vue 值守卫。
   *  返回是否在超时内变成目标文本。 */
  function injectInputValue(input, text) {
    try {
      var proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (proto && proto.set) proto.set.call(input, text); else input.value = text;
    } catch (e) { input.value = text; }
    ['input', 'change'].forEach(function (type) {
      try { input.dispatchEvent(new Event(type, { bubbles: true })); } catch (e) {}
    });
    return T.waitFor(function () { return (input.value || '').indexOf(text) !== -1; }, 2000)
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  /** 诊断:面板打不开时,报告日期框的关键事实,用于判断该走哪条兜底路径。
   *  - readOnly:readonly input 通常不收 input 事件写入(组件显示值由组件控制)
   *  - __vue__:存在则说明是开发构建,可走 Vue 实例;生产构建多为 null
   *  - pickerType:若 __vue__ 存在,确认是不是 month/date picker 实例 */
  function diagPicker(input) {
    var editor = null;
    try { editor = input.closest ? input.closest('.el-date-editor') : null; } catch (e) {}
    var vm = editor && editor.__vue__;
    var facts = [];
    facts.push('readOnly=' + input.readOnly);
    facts.push('__vue__=' + (!!vm));
    if (vm) {
      facts.push('vm.type=' + (vm.type || '?'));
      if (vm.$options) facts.push('vm.name=' + (vm.$options.name || '?'));
    }
    // 页面是否在 window 上暴露了 Vue(开发构建标志之一)
    try { facts.push('window.Vue=' + (!!window.Vue)); } catch (e) {}
    return facts.join(' ');
  }

  /** 从元素向上收集 Vue 实例(含每个实例的 $parent 链)。
   *  组件根元素共享时 __vue__ 可能只指内层实例(el-input),DatePicker 实例在其 $parent 上。 */
  function collectVms(startEl) {
    var vms = [];
    var seen = {};
    var node = startEl;
    while (node && node !== document.body && vms.length < 12) {
      if (node.__vue__) {
        var cur = node.__vue__;
        for (var i = 0; cur && i < 6; i++) {
          if (!cur || seen[cur._uid]) break;
          seen[cur._uid] = 1;
          vms.push(cur);
          cur = cur.$parent;
        }
      }
      node = node.parentElement;
    }
    return vms;
  }

  /** 兜底:通过 Vue 组件实例改值(Element UI 2.x)。
   *  优先对 DatePicker 实例(type=month/date 或组件名含 DatePicker)$emit('input', date),
   *  同步父级 v-model 与内部显示文本;找不到则对所有实例逐个尝试(无效的会抛异常被吞),
   *  最后校验显示文本是否变成目标值。 */
  function setViaVue(editorEl, date, expectedText) {
    var vms = collectVms(editorEl);
    var pickerVm = null;
    vms.forEach(function (vm) {
      if (pickerVm) return;
      if (vm.type === 'month' || vm.type === 'date' ||
          (vm.$options && /date-?picker/i.test(vm.$options.name || ''))) pickerVm = vm;
    });
    var targets = pickerVm ? [pickerVm] : vms;
    targets.forEach(function (vm) {
      try {
        vm.$emit('input', date);
        vm.$emit('change', date);
      } catch (e) {}
    });
    return T.sleep(400).then(function () {
      var input = T.qs('input', editorEl);
      return !!(input && (input.value || '').indexOf(expectedText) !== -1);
    });
  }

  /** 设置税款所属期起始月(targetYM 如 "2022-01"):month picker。
   *  策略:点 input 弹面板(带坐标/pointer/detail) → 面板内切年点月;
   *  若面板点不开,直接写入 input 值;再不行走 Vue 实例。 */
  function setStartMonth(targetYM) {
    var parts = targetYM.split('-');
    var targetYear = parseInt(parts[0], 10);
    var monthText = parseInt(parts[1], 10) + '月';

    var inputs = T.qsa('.el-date-editor input');
    if (inputs.length < 2) throw new Error('税款所属期 input 不足(' + inputs.length + ')');
    var input = inputs[0];
    var panel = null;

    return tryOpenPicker(input)
      .then(function (opened) {
        if (!opened) {
          T.report('    [setStartMonth] 面板未弹出(' + diagPicker(input) + '),改用直接写入 ' + targetYM);
          return injectInputValue(input, targetYM).then(function (ok) {
            return ok || setViaVue(input.parentElement, new Date(targetYear, parseInt(parts[1], 10) - 1, 1), targetYM);
          }).then(function (ok) {
            if (!ok) throw new Error('税款所属期写入失败:点击无面板,直接写入与 Vue 实例兜底均未生效(value=' + input.value + ')');
          });
        }
        // 面板已弹出:锁定面板 → 切年 → 点月份格
        return lockPanel()
          .then(function (p) { panel = p; return navigatePanelYear(panel, targetYear); })
          .then(function () { return T.sleep(150); })
          .then(function () { clickMonthCell(panel, monthText); });
      })
      .then(function () { return T.sleep(600); });
  }

  /** 设置申报日期起始(targetYM 如 "2022-01")到当月 1 号:date picker。策略同上。 */
  function setDeclareDateStart(targetYM) {
    var parts = targetYM.split('-');
    var targetYear = parseInt(parts[0], 10);
    var targetMonth = parseInt(parts[1], 10);
    var dateText = targetYM + '-01';

    var startInput = T.qs('.el-date-editor--date input');
    if (!startInput) {
      var all = T.qsa('.el-date-editor input');
      if (all.length < 4) throw new Error('申报日期 input 未找到(无 .el-date-editor--date,且 .el-date-editor input 仅 ' + all.length + ' 个)');
      startInput = all[2];
    }
    var panel = null;

    return tryOpenPicker(startInput)
      .then(function (opened) {
        if (!opened) {
          T.report('    [setDeclareDateStart] 面板未弹出(' + diagPicker(startInput) + '),改用直接写入 ' + dateText);
          return injectInputValue(startInput, dateText).then(function (ok) {
            return ok || setViaVue(startInput.parentElement, new Date(targetYear, targetMonth - 1, 1), dateText);
          }).then(function (ok) {
            if (!ok) throw new Error('申报日期写入失败:点击无面板,直接写入与 Vue 实例兜底均未生效(value=' + startInput.value + ')');
          });
        }
        // 面板已弹出:锁定面板 → 切年/月 → 点 1 号
        return lockPanel()
          .then(function (p) { panel = p; return navigatePanelYM(panel, targetYear, targetMonth); })
          .then(function () { return T.sleep(150); })
          .then(function () { clickDayCell(panel, 1); });
      })
      .then(function () { return T.sleep(600); });
  }

  /** 按下 Escape 关闭可能残留的日期面板 + 点遮罩兜底
   *  注意:不能 clickEl(panel)——点在面板内部不会关面板,反而可能触发单元格点击。
   *  正确做法:Escape 关面板;若仍残留,点遮罩层(.v-modal)关闭。 */
  function closeOverlays() {
    try {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    } catch (e) {}
    return T.sleep(120)
      .then(function () {
        // 点遮罩层(若有);不点 .el-picker-panel 本身
        T.qsa('.v-modal').forEach(function (el) {
          if (T.isVisible(el)) { try { T.clickEl(el); } catch (e) {} }
        });
        // 兜底:若仍有可见面板,再发一次 Escape
        if (visiblePanels().length) {
          try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
          } catch (e) {}
        }
        return T.sleep(200);
      });
  }

  T.datepickers = {
    setStartMonth: setStartMonth,
    setDeclareDateStart: setDeclareDateStart,
    closeOverlays: closeOverlays,
    // 公共兜底能力(供 deduction.js 的 year picker 复用,逻辑同上)
    realClick: realClick,
    cdpClick: cdpClick,
    tryOpenPicker: tryOpenPicker,
    injectInputValue: injectInputValue,
    setViaVue: setViaVue,
    diagPicker: diagPicker,
    visiblePanels: visiblePanels
  };
})();
