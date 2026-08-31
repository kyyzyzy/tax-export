/**
 * popup.js —— 控制台逻辑
 *
 * 职责:
 *   1. 打开时从 background 拉取当前状态(进度/日志/是否有未完成任务)并渲染
 *   2. 实时接收 background 广播的日志/状态/进度,追加显示
 *   3. 「开始采集」按钮 → 向当前 tab 的 content script 发 START_TASK
 *   4. 「历史」tab:列出历次采集结果,支持重新导出 / 单条删除 / 一键清除
 */
'use strict';

var startBtn = document.getElementById('startBtn');
var clearTaskBtn = document.getElementById('clearTaskBtn');
var yearSel = document.getElementById('yearSel');
var hint = document.getElementById('hint');
var statusBadge = document.getElementById('statusBadge');
var statusText = document.getElementById('statusText');
var progressBar = document.getElementById('progressBar');
var logBox = document.getElementById('logBox');

/* ---------- Tab 切换 ---------- */

var tabCollect = document.getElementById('tabCollect');
var tabHistory = document.getElementById('tabHistory');
var panelCollect = document.getElementById('panelCollect');
var panelHistory = document.getElementById('panelHistory');
var histCount = document.getElementById('histCount');
var clearHistBtn = document.getElementById('clearHistBtn');
var historyBox = document.getElementById('historyBox');

/* ---------- 采集年份选择 ---------- */
/* 偏移语义:N=偏移量,申报起始年=当前年-N,扣除年度=当前年-N..当前年-1(今年不采)。默认 3,上限 5。 */
var YEARS_KEY = 'tax_export_years';
var DEFAULT_YEARS = 3;
var MAX_YEARS = 5;

/** 取已持久化的采集年份(1~5);非法/缺失回退默认 3。 */
function clampYears(n) {
  n = parseInt(n, 10);
  if (isNaN(n) || n < 1) return DEFAULT_YEARS;
  if (n > MAX_YEARS) return MAX_YEARS;
  return n;
}

/** 读取采集年份:优先 storage,否则默认值。返回 Promise<number>。 */
function loadYears() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(YEARS_KEY, function (res) {
      var n = res && res[YEARS_KEY];
      resolve(n != null ? clampYears(n) : DEFAULT_YEARS);
    });
  });
}

/** 持久化采集年份。返回 Promise<void>。 */
function saveYears(n) {
  n = clampYears(n);
  return new Promise(function (resolve) {
    var o = {}; o[YEARS_KEY] = n;
    chrome.storage.local.set(o, function () { resolve(); });
  });
}

// 初始化:回填 select,绑定变更持久化
loadYears().then(function (n) { yearSel.value = String(n); });
yearSel.addEventListener('change', function () {
  saveYears(yearSel.value).then(function () {
    hint.textContent = '采集年份已设为 ' + clampYears(yearSel.value) + ' 年,点「开始采集」生效';
    hint.style.color = 'var(--muted)';
  });
});

function switchTab(name) {
  var toHist = name === 'history';
  tabCollect.classList.toggle('active', !toHist);
  tabHistory.classList.toggle('active', toHist);
  panelCollect.classList.toggle('active', !toHist);
  panelHistory.classList.toggle('active', toHist);
  if (toHist) loadHistory();
}
tabCollect.addEventListener('click', function () { switchTab('collect'); });
tabHistory.addEventListener('click', function () { switchTab('history'); });

/* ---------- 状态渲染 ---------- */

function setBadge(cls, text) {
  statusBadge.className = 'badge ' + cls;
  statusBadge.textContent = text;
}

function renderStatus(s) {
  // s: { status, progress:{done,total}, logs, hasJob }
  statusText.textContent = s.status || '';
  if (s.progress) {
    var pct = s.progress.total > 0 ? (s.progress.done / s.progress.total * 100) : 0;
    progressBar.style.width = pct + '%';
  }
  if (/完成|done/.test(s.status || '')) setBadge('ok', '已完成');
  else if (/失败|err/.test(s.status || '')) setBadge('err', '失败');
  else if (s.hasJob || /续采|采集|启动/.test(s.status || '')) setBadge('run', '运行中');
  else setBadge('idle', '就绪');

  if (s.logs && s.logs.length) {
    logBox.innerHTML = '';
    s.logs.forEach(appendLog);
    logBox.scrollTop = logBox.scrollHeight;
  }
}

function appendLog(entry) {
  var div = document.createElement('div');
  if (entry.level) div.className = entry.level;
  var time = new Date(entry.time || Date.now()).toLocaleTimeString();
  div.textContent = '[' + time + '] ' + entry.message;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

/* ---------- 与 background 通信 ---------- */

function send(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (r) { resolve(r); });
  });
}

function getActiveTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      resolve(tabs && tabs[0]);
    });
  });
}

/* ---------- 历史 ---------- */

function renderHistory(list) {
  list = list || [];
  histCount.textContent = list.length;
  histCount.classList.toggle('has', list.length > 0);
  clearHistBtn.disabled = list.length === 0;

  if (!list.length) {
    historyBox.innerHTML = '<div class="empty">暂无历史记录</div>';
    return;
  }

  // 新 → 旧
  var sorted = list.slice().sort(function (a, b) { return (b.time || 0) - (a.time || 0); });
  historyBox.innerHTML = '';
  sorted.forEach(function (rec) {
    var s = rec.summary || { years: 0, declareDetails: 0, deductionYears: 0, deductionItems: 0 };
    var item = document.createElement('div');
    item.className = 'hist-item';
    var stats = [];
    if (s.years) stats.push('年度汇算 <b>' + s.years + ' 年</b>');
    if (s.deductionYears) stats.push('扣除 <b>' + s.deductionYears + ' 年 / ' + s.deductionItems + ' 条</b>');
    item.innerHTML =
      '<div class="time">' + esc(rec.timeStr || '') + '</div>' +
      '<div class="stats">' + (stats.length ? stats.join('') : '无数据') + '</div>' +
      '<div class="actions">' +
        '<button class="btn mini primary" data-act="pdf">导出 PDF</button>' +
        '<button class="btn mini danger" data-act="delete">删除</button>' +
      '</div>';
    item.querySelector('[data-act="pdf"]').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      btn.disabled = true; var prev = btn.textContent; btn.textContent = '生成中…';
      send({ type: 'EXPORT_PDF_HISTORY', id: rec.id }).then(function (r) {
        if (r && r.ok && r.pending) {
          // 异步生成:真正结果通过日志体现,按钮保持「生成中」2.5s 后恢复
          btn.textContent = '生成中…请看日志';
          setTimeout(function () { btn.textContent = prev; btn.disabled = false; }, 2500);
        } else {
          flash(btn, r && r.ok ? '已下载 PDF' : '失败', prev);
        }
      });
    });
    item.querySelector('[data-act="delete"]').addEventListener('click', function () {
      send({ type: 'DELETE_HISTORY', id: rec.id }).then(function (r) {
        if (r && r.ok) renderHistory(r.history);
      });
    });
    historyBox.appendChild(item);
  });
}

function loadHistory() {
  send({ type: 'GET_HISTORY' }).then(function (r) {
    renderHistory(r && r.history);
  });
}

clearHistBtn.addEventListener('click', function () {
  if (clearHistBtn.disabled) return;
  if (!confirm('确定清除全部历史记录?此操作不可撤销。')) return;
  send({ type: 'CLEAR_HISTORY' }).then(function (r) {
    if (r && r.ok) renderHistory([]);
  });
});

/** 临时把按钮文案改成提示文字,1.5s 后还原。btn:被点击的按钮元素 */
function flash(btn, text, prevText) {
  var prev = prevText || btn.textContent;
  btn.disabled = true;
  btn.textContent = text;
  setTimeout(function () {
    btn.textContent = prev;
    btn.disabled = false;
  }, 1500);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- 实时消息(日志/状态/进度增量 + 历史更新) ---------- */

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'LOG' && msg.entry) {
    appendLog(msg.entry);
  } else if (msg.type === 'STATUS') {
    statusText.textContent = msg.status || '';
    if (/完成/.test(msg.status || '')) setBadge('ok', '已完成');
    else if (/失败/.test(msg.status || '')) setBadge('err', '失败');
    else if (msg.status && msg.status !== '就绪') setBadge('run', '运行中');
  } else if (msg.type === 'PROGRESS') {
    var pct = msg.total > 0 ? (msg.done / msg.total * 100) : 0;
    progressBar.style.width = pct + '%';
  } else if (msg.type === 'HISTORY_UPDATED') {
    // 采集完成新增历史、删除、清除都会广播;无论当前在哪个 tab 都刷新计数与列表
    renderHistory(msg.history);
  }
});

/* ---------- 启动按钮 ---------- */

startBtn.addEventListener('click', function () {
  startBtn.disabled = true;
  setBadge('run', '启动中');
  getActiveTab().then(function (tab) {
    if (!tab || !/etax\.chinatax\.gov\.cn/.test(tab.url || '')) {
      hint.textContent = '⚠ 请先在电子税务局页面操作';
      hint.style.color = 'var(--err)';
      startBtn.disabled = false;
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'START_TASK', yearOffset: clampYears(yearSel.value) }, function () {
      void chrome.runtime.lastError;
      hint.textContent = '任务已启动,采集完成后自动生成 PDF,刷新会自动续采';
      hint.style.color = 'var(--muted)';
      setTimeout(function () { startBtn.disabled = false; }, 2000);
    });
  });
});

/* ---------- 结束任务按钮 ---------- */

clearTaskBtn.addEventListener('click', function () {
  if (!confirm('确定结束当前任务?下次「开始采集」将以全新任务运行。')) return;
  clearTaskBtn.disabled = true;
  // 1. 通知 background 结束任务(RESET 清 job + 状态,但保留日志,并追加一条结束日志)
  send({ type: 'RESET' }).then(function () {
    // 2. 通知当前 tab 的 content script 停止(running=false,丢弃内存 job 引用)
    getActiveTab().then(function (tab) {
      if (tab && /etax\.chinatax\.gov\.cn/.test(tab.url || '')) {
        chrome.tabs.sendMessage(tab.id, { type: 'RESET' }, function () { void chrome.runtime.lastError; });
      }
    });
    // 3. 重置状态显示(不清空日志:结束日志由 background 广播追加,历史日志保留)
    statusText.textContent = '';
    progressBar.style.width = '0%';
    setBadge('idle', '就绪');
    hint.textContent = '任务已结束,点「开始采集」启动新任务';
    hint.style.color = 'var(--muted)';
    clearTaskBtn.disabled = false;
  });
});



/* ---------- 打开时拉取状态 + 历史 ---------- */

send({ type: 'GET_STATE' }).then(function (s) {
  if (s) renderStatus(s);
});
loadHistory();

// 检查当前标签是否在电子税务局
getActiveTab().then(function (tab) {
  if (tab && /etax\.chinatax\.gov\.cn/.test(tab.url || '')) {
    hint.textContent = '点击「开始采集」即可,刷新会自动续采';
  } else {
    hint.textContent = '⚠ 请先打开电子税务局页面';
    hint.style.color = 'var(--err)';
    startBtn.disabled = true;
  }
});
