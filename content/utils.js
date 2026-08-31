/**
 * content/utils.js —— 底层工具 + 任务状态持久化 + 日志适配层
 *
 * 仅在 https://etax.chinatax.gov.cn/ 由 content_scripts 注入。
 * 所有「纯 DOM 操作」工具在此定义,被 datepickers/list/detail/main 复用。
 */
(function () {
  'use strict';

  /* ============================ 配置 ============================ */

  // 目标起始月:当前年份 + YEAR_OFFSET 的 MONTH 月(对齐 tax-tool:2026 → 2022-01)
  var YEAR_OFFSET = -4;
  var MONTH = 1;

  // 专项附加扣除:起始年度 = 当前年 + DEDUCT_YEARS_OFFSET,逐年抓到当前年(2026 → 2023..2026);与 popup 默认 3 年一致
  var DEDUCT_YEARS_OFFSET = -3;

  // 采集上限
  var MAX_ROWS = 50;     // 申报列表最多处理条数
  var MAX_PAGES = 50;    // 工资薪金明细最多翻页数

  // 轮询参数
  var POLL_INTERVAL = 160;  // ms
  var POLL_TIMEOUT = 15000; // ms,单步最长等待

  /* ============================ DOM 基础工具 ============================ */

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** 轮询直到 test() 返回真值(返回该真值);超时 reject */
  function waitFor(test, timeout) {
    timeout = timeout || POLL_TIMEOUT;
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      (function tick() {
        var v;
        try { v = test(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return reject(new Error('等待超时'));
        setTimeout(tick, POLL_INTERVAL);
      })();
    });
  }

  /** 轮询直到出现「可见」(有尺寸 + 非 display:none)的目标元素 */
  function waitForVisible(sel, timeout) {
    return waitFor(function () {
      var els = qsa(sel);
      for (var i = 0; i < els.length; i++) { if (isVisible(els[i])) return els[i]; }
      return null;
    }, timeout);
  }

  function isVisible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return true;
  }

  /** 贴近真实用户的点击:focus + mousedown/mouseup + 单次 click(不重复触发) */
  function clickEl(el) {
    if (!el) throw new Error('clickEl: 目标为空');
    try { el.focus && el.focus(); } catch (e) {}
    ['mousedown', 'mouseup'].forEach(function (type) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 })); } catch (e) {}
    });
    var clicked = false;
    try { el.click(); clicked = true; } catch (e) {}
    if (!clicked) {
      try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 })); } catch (e) {}
    }
  }

  /** 在所有 .card-item 里按标题文字找卡片 */
  function findCard(title) {
    return qsa('a.card-item').filter(function (a) {
      var t = qs('.card-title', a);
      return t && (t.textContent || '').indexOf(title) !== -1;
    })[0];
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function targetStartMonth() {
    return targetStartMonthFor(YEAR_OFFSET);
  }

  /** 按偏移量计算目标起始月(offset 为负整数,如 -4)。
   *  供「采集年份」选择器:offset=-(采集年份)。例 offset=-4 → 2022-01。 */
  function targetStartMonthFor(offset) {
    var now = new Date();
    return (now.getFullYear() + offset) + '-' + pad(MONTH);
  }

  /** 按文字内容找按钮/链接(精确或包含) */
  function findByText(sel, text, exact) {
    return qsa(sel).filter(function (el) {
      var t = (el.textContent || '').trim();
      return exact ? t === text : t.indexOf(text) !== -1;
    });
  }

  function timestampStr() {
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /* ============================ 任务状态持久化(JobStore)=============================
   * 页面刷新会销毁 content script 上下文。把采集进度存到 chrome.storage.local
   * (由 background 中转),content script 启动时读回进度,从断点继续。
   *
   * 进度结构(job):
   *   stage:     'list' | 'detail' | 'returning' | 'done'
   *   targetYM:  目标起始月(如 "2022-01")
   *   startedAt: 任务开始时间字符串(导出用,跨刷新保持一致)
   *   rows:      全量申报列表(S5 后固定)
   *   total:     要处理的条数
   *   current:   当前正在抓的索引(0-based)
   *   details:   已抓详情数组
   */
  var STORAGE_KEY = 'tax_export_job';

  /** 写进度(异步,通过 background 中转 storage.local) */
  function saveJob(job) {
    return sendMessage({ type: 'SAVE_JOB', job: job }).catch(function () {});
  }
  function clearJob() {
    return sendMessage({ type: 'CLEAR_JOB' }).catch(function () {});
  }

  /** 判断当前页面是不是申报列表页 */
  function isOnListPage() {
    if (location.href.indexOf('declare-query-list') !== -1) return true;
    var tbls = qsa('.el-table');
    return tbls.some(function (t) {
      return isVisible(t) && (t.textContent || '').indexOf('查看') !== -1;
    });
  }

  /** 判断当前页面是不是申报详情页 */
  function isOnDetailPage() {
    return !!(qs('li.its-tab, .its-tab-title li') ||
              qs('.its-breadcrumb, .breadcrumb') ||
              qs('.J_BaseInfoContent, .details-panel'));
  }

  /** 判断当前页面是不是专项附加扣除「列表页」(路由含 special-additional 且有年份控件或卡片) */
  function isOnDeductionListPage() {
    if (location.href.indexOf('special-additional') !== -1 &&
        (qs('.list-group-wrapper') || qs('.el-date-editor--year'))) {
      return true;
    }
    // 兜底:有卡片或年份控件且不在明细页
    if ((qs('.list-group-wrapper') || qs('.el-date-editor--year')) && !isOnDeductionDetailPage()) {
      return true;
    }
    return false;
  }

  /** 判断当前页面是不是专项附加扣除「明细页」(有 detail-table-wrapper / special-table-wrapper) */
  function isOnDeductionDetailPage() {
    return !!(qs('.detail-table-wrapper') || qs('.special-table-wrapper'));
  }

  /* ============================ 日志/状态适配层 ============================
   * content script 无法直接操作 popup DOM,统一通过 chrome.runtime.sendMessage
   * 发给 background,background 再转发给 popup(若打开)。
   */

  function sendMessage(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }

  function report(msg, level) {
    // level: 'info' | 'ok' | 'err' | undefined
    var line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    if (level === 'err') console.error('[tax-export]', msg);
    else console.log('[tax-export]', msg);
    sendMessage({ type: 'LOG', message: msg, level: level || 'info', line: line });
  }
  function setStatus(msg) { sendMessage({ type: 'STATUS', status: msg || '' }); }
  function setProgress(done, total) { sendMessage({ type: 'PROGRESS', done: done, total: total }); }

  /* ============================ 暴露 API ============================ */
  window.__taxExport = {
    // 配置
    YEAR_OFFSET: YEAR_OFFSET, MONTH: MONTH, MAX_ROWS: MAX_ROWS, MAX_PAGES: MAX_PAGES,
    DEDUCT_YEARS_OFFSET: DEDUCT_YEARS_OFFSET,
    POLL_INTERVAL: POLL_INTERVAL, POLL_TIMEOUT: POLL_TIMEOUT,
    // 工具
    qs: qs, qsa: qsa, sleep: sleep, waitFor: waitFor, waitForVisible: waitForVisible,
    isVisible: isVisible, clickEl: clickEl, findCard: findCard, findByText: findByText,
    pad: pad, targetStartMonth: targetStartMonth, targetStartMonthFor: targetStartMonthFor, timestampStr: timestampStr,
    // 状态
    STORAGE_KEY: STORAGE_KEY, saveJob: saveJob, clearJob: clearJob,
    isOnListPage: isOnListPage, isOnDetailPage: isOnDetailPage,
    isOnDeductionListPage: isOnDeductionListPage, isOnDeductionDetailPage: isOnDeductionDetailPage,
    // 通信
    sendMessage: sendMessage, report: report, setStatus: setStatus, setProgress: setProgress
  };
})();
