/**
 * background.js —— MV3 service worker
 *
 * 职责:
 *   1. 存储/读取任务进度(chrome.storage.local) —— content script 每次注入时读回
 *   2. 转发日志/状态/进度给 popup(若打开)
 *   3. 处理导出:接收 content 发来的 JSON payload
 *      a) 下载完整 JSON（结构化存档）
 *      b) 写入历史(带 payload + summary，供 PDF 重新导出)
 *   4. PDF 导出:把 JSON payload 转成 HTML 报表(report.html)
 *      → 隐藏 minimized window 加载 → CDP Page.printToPDF
 *      → pdf-lib 把 payload 内嵌为 PDF 附件(页面不显示,解析端可原样取回) → 下载
 *   5. 弹出 popup 时,补发当前进度与历史日志
 *
 * service worker 是持久的(在 MV3 里会被回收,但消息事件会唤醒它),
 * 所以即便 content script 因页面刷新销毁,进度仍安全存在 storage.local。
 */

// pdf-lib(UMD,importScripts 加载后挂到 self.PDFLib)。用于把 payload JSON
// 内嵌为 PDF 附件;加载失败不致命,attachPayloadToPdfBase64 会降级。
try {
  importScripts('vendor/pdf-lib.min.js');
} catch (e) {
  // 典型原因:加载的扩展文件夹缺 vendor/(解压不完整)。不阻断 SW 注册,
  // 采集与 PDF 导出照常,仅 PDF 内嵌 JSON 附件功能降级。
  console.warn('pdf-lib 加载失败,PDF 将不含 JSON 附件(请确认 vendor/pdf-lib.min.js 存在):', e);
}

// 最近的任务状态(内存缓存,popup 打开时立即返回;真实持久化在 storage.local)
var currentJob = null;       // 任务进度对象
var logs = [];               // 日志缓冲(最多 500 条)
var status = 'idle';         // 当前状态文案
var progress = { done: 0, total: 0 };
var popupPort = null;        // popup 连接端口(可选,用消息替代)

var STORAGE_KEY = 'tax_export_job';
var HISTORY_KEY = 'tax_export_history';
var MAX_LOGS = 500;
var MAX_HISTORY = 20;   // 历史记录上限(超出按时间倒序保留最近 N 条)

/* ------------------------- 存储 ------------------------- */

function persistJob(job) {
  currentJob = job;
  if (job) {
    return chrome.storage.local.set({ tax_export_job: job });
  }
  return chrome.storage.local.remove('tax_export_job');
}

function loadJobFromStorage() {
  return new Promise(function (resolve) {
    chrome.storage.local.get('tax_export_job', function (res) {
      resolve(res && res.tax_export_job || null);
    });
  });
}

/* ------------------------- 日志/状态广播 ------------------------- */

function pushLog(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(logs.length - MAX_LOGS);
  broadcast({ type: 'LOG', entry: entry });
}

function setStatus(s) {
  status = s;
  broadcast({ type: 'STATUS', status: s });
}

function setProgress(done, total) {
  progress = { done: done, total: total };
  broadcast({ type: 'PROGRESS', done: done, total: total });
}

/** 广播给所有标签页的 content script(popup 通过另一通道接收) */
function broadcast(msg) {
  // popup 用 chrome.runtime.onMessage 接收
  try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); } catch (e) {}
}

/* ------------------------- 历史记录 ------------------------- */

/** 读取历史(数组,新到旧)。读取失败返回空数组。 */
function loadHistory() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(HISTORY_KEY, function (res) {
      resolve((res && Array.isArray(res[HISTORY_KEY])) ? res[HISTORY_KEY] : []);
    });
  });
}

function saveHistory(list) {
  return chrome.storage.local.set({ tax_export_history: list });
}

/** 把一次采集结果存入历史(去重/截断后)。返回完整历史。 */
function pushHistory(record) {
  return loadHistory().then(function (list) {
    list.push(record);
    // 按 time 升序 → 保留最近 MAX_HISTORY 条
    list.sort(function (a, b) { return (a.time || 0) - (b.time || 0); });
    if (list.length > MAX_HISTORY) list = list.slice(list.length - MAX_HISTORY);
    return saveHistory(list).then(function () { return list; });
  });
}

function deleteHistory(id) {
  return loadHistory().then(function (list) {
    var next = list.filter(function (r) { return String(r.id) !== String(id); });
    return saveHistory(next).then(function () { return next; });
  });
}

function clearHistory() {
  return saveHistory([]);
}

/** 从 payload 摘要出可在列表展示的统计信息(适配 v2 按年度结构,扣除已下沉到年度内) */
function summarize(payload) {
  var summary = { years: 0, declareDetails: 0, deductionYears: 0, deductionItems: 0 };
  try {
    var settle = (payload && payload['年度汇算']) || {};
    var ykeys = Object.keys(settle);
    summary.years = ykeys.length;
    summary.declareDetails = ykeys.length;  // 每年度一条(列表+详情已融合)
    // 专项附加扣除:已下沉到各年度的 annualSettle[y].专项附加扣除,从年度内汇总
    ykeys.forEach(function (y) {
      var arr = (settle[y] && settle[y]['专项附加扣除']) || [];
      if (arr.length) { summary.deductionYears++; summary.deductionItems += arr.length; }
    });
  } catch (e) {}
  return summary;
}

/* ------------------------- 导出下载 ------------------------- */

function downloadText(filename, content, mime) {
  // MV3 service worker 无 Blob URL,用 data: URL + chrome.downloads
  var dataUrl = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(content);
  chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: false
  }, function () {
    pushLog({ time: Date.now(), level: 'ok', message: '📁 已下载 ' + filename });
  });
}

/** 下载二进制(base64)。PDF 等二进制文件不能用文本 data URL。 */
function downloadBinary(filename, base64, mime) {
  var dataUrl = 'data:' + mime + ';base64,' + base64;
  chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: false
  }, function () {
    pushLog({ time: Date.now(), level: 'ok', message: '📁 已下载 ' + filename });
  });
}

/**
 * 采集完成导出:把 JSON payload 作为缓存写入历史(不再下载 JSON 文件),
 * 然后立即自动生成 PDF 下载。JSON 仅作缓存,供「历史」里重新导出 PDF。
 * data.skipHistory=true 时(内部复用)只写历史不重复触发,不用于采集完成路径。
 */
function exportResults(data) {
  // 写入历史(JSON 作为缓存,供重导出 PDF;不下载 JSON 文件)
  if (!data.skipHistory && data.payload) {
    var rec = {
      id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      time: Date.now(),
      timeStr: new Date().toLocaleString(),
      payload: data.payload,
      realName: data.realName || '',  // 明文姓名:仅用于 PDF 文件名,不进 payload
      summary: summarize(data.payload)
    };
    pushHistory(rec).then(function (history) {
      broadcast({ type: 'HISTORY_UPDATED', history: history });
      // 历史写好后,立即自动生成并下载 PDF(JSON 仅作缓存)
      exportHistoryPdf(rec.id);
    }).catch(function () {});
  }
}

function timestampStr() {
  var d = new Date();
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** PDF 文件名:{姓名}_个税报告_{年度数}_{采集时间}(如 周杨_个税报告_4年_20260818_153012.pdf)。
 *  姓名用 realName(明文,仅文件名;payload 内容仍脱敏);缺省回退 payload 里的脱敏姓名。
 *  掩码 * 换全角＊(Windows 文件名非法字符),其余非法字符一并剔除。 */
function buildPdfFilename(payload, realName, collectedAt) {
  var namePart = '', yearPart = '';
  try {
    var p = payload || {};
    var nm = String(realName || (p['纳税人'] && p['纳税人']['姓名']) || '');
    nm = nm.replace(/\*/g, '＊').replace(/[\\\/:?\"<>|\r\n\s]/g, '');
    if (nm) namePart = nm + '_';
    var settle = p['年度汇算'] || {};
    var n = Object.keys(settle).length;
    if (n) yearPart = n + '年_';
  } catch (e) {}
  var d = collectedAt ? new Date(collectedAt) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  var p2 = function (x) { return x < 10 ? '0' + x : '' + x; };
  return namePart + '个税报告_' + yearPart +
    (d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' +
     p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds())) + '.pdf';
}

/* ------------------------- CDP Page.printToPDF -------------------------
 * 复用既有的 chrome.debugger CDP 基建。
 * 流程:attach → Page.enable → Page.printToPDF → detach。
 * printToPDF 默认会按纸张分页，长表格自然分多页。
 * printBackground=true 保证背景色/样式不丢。
 */

function sendCDP(tabId, method, params) {
  return new Promise(function (resolve, reject) {
    chrome.debugger.sendCommand({ tabId: tabId }, method, params || {}, function (res) {
      var err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(res);
    });
  });
}

/** attach（幂等:已 attached 视为成功）。返回是否本次 attach（用于后续 detach）。 */
function cdpAttach(tabId) {
  return new Promise(function (resolve, reject) {
    chrome.debugger.attach({ tabId: tabId }, '1.3', function () {
      var err = chrome.runtime.lastError;
      var attached = !err || !/already attached/i.test(err.message);
      if (err && !attached) reject(new Error(err.message));
      else resolve(attached);
    });
  });
}

function cdpDetach(tabId) {
  return new Promise(function (resolve) {
    chrome.debugger.detach({ tabId: tabId }, function () { resolve(); });
  });
}

/**
 * 对一个 tab 执行 Page.printToPDF，返回 base64 PDF 字符串。
 * 纸张 A4 纵向，margin 取小值以放更多内容。
 */
function printTabToPdfBase64(tabId) {
  var attached = false;
  return Promise.resolve()
    .then(function () { return cdpAttach(tabId); })
    .then(function (a) { attached = a; })
    .then(function () { return sendCDP(tabId, 'Page.enable', {}); })
    .then(function () {
      return sendCDP(tabId, 'Page.printToPDF', {
        landscape: false,
        displayHeaderFooter: true,   // 页脚输出页码(模板仅用 ASCII,避免中文渲染异常)
        headerTemplate: '<span></span>',
        footerTemplate: '<div style="width:100%;text-align:center;font-size:9px;color:#888;">- <span class="pageNumber"></span> / <span class="totalPages"></span> -</div>',
        printBackground: true,
        paperWidth: 8.27,    // A4 宽(英寸)
        paperHeight: 11.69,  // A4 高(英寸)
        marginTop: 0.3, marginBottom: 0.45, marginLeft: 0.3, marginRight: 0.3,
        scale: 0.85          // 略缩放以减少横向溢出，放更多列
      });
    })
    .then(function (res) {
      if (!res || !res.data) throw new Error('printToPDF 返回空');
      return res.data;  // base64
    })
    .then(function (b64) {
      if (attached) return cdpDetach(tabId).then(function () { return b64; });
      return b64;
    })
    .catch(function (e) {
      if (attached) cdpDetach(tabId).catch(function () {});
      throw e;
    });
}

/* ------------------------- PDF 内嵌 JSON 附件 -------------------------
 * printToPDF 只产出页面内容;这里用 pdf-lib 把 payload JSON 作为
 * EmbeddedFile 附件写回 PDF:
 *   - 阅读器里不显示、页面内容不变(仅 Adobe 等带附件面板的阅读器可见回形针)
 *   - 解析端可直接取回原始 JSON,无需从表格反解:
 *       pypdf:   reader.attachments['payload.json']  (bytes → utf-8 → json.loads)
 *       PDFBox:  doc.getAttachments().get('payload.json')
 *       qpdf:    qpdf --show-attachment payload.json in.pdf out.json
 * payload 先 TextEncoder 编成 UTF-8 字节再挂,中文 round-trip 无损。
 * 任何一步失败都降级返回原 base64,不影响 PDF 正常下载。
 */
function attachPayloadToPdfBase64(b64, payload) {
  if (!payload) return Promise.resolve(b64);
  var json = '';
  try { json = JSON.stringify(payload); } catch (e) { return Promise.resolve(b64); }
  return Promise.resolve()
    .then(function () {
      if (typeof PDFLib === 'undefined') throw new Error('pdf-lib 未加载');
      return PDFLib.PDFDocument.load(b64, { ignoreEncryption: true });
    })
    .then(function (doc) {
      doc.attach(new TextEncoder().encode(json), 'payload.json', {
        mimeType: 'application/json; charset=utf-8',
        description: 'tax-export 原始数据(JSON)'
      });
      return doc.saveAsBase64({ useObjectStreams: false });
    })
    .then(function (outB64) {
      pushLog({ time: Date.now(), level: 'info',
        message: '  已内嵌 JSON 附件 payload.json(' + json.length + ' 字符)' });
      return outB64;
    })
    .catch(function (e) {
      pushLog({ time: Date.now(), level: 'err',
        message: '⚠ JSON 附件嵌入失败,降级为普通 PDF: ' + (e && e.message || e) });
      return b64;
    });
}

/* ------------------------- JSON→PDF 管线 -------------------------
 * MV3 service worker 会被回收,不能依赖「开窗时存的内存状态」等 VIEWER_READY 回来。
 * 改为无状态设计:
 *   1. 开 minimized window 加载 report.html?id=<recId>&winId=<winId>
 *   2. report.js 渲染完毕发 VIEWER_READY { id, winId }
 *   3. background 的 VIEWER_READY 处理:用 sender.tab.id(printToPDF 目标)
 *      + msg.winId(关窗用)直接打印 → 下载 → 关窗。
 *      全程不存内存状态,SW 回收不影响。
 *   4. 失败(渲染超时/打印异常)由 report 页自检超时发 VIEWER_ERROR,background 关窗。
 */

/**
 * 把一条历史记录（payload）转成 PDF 并下载。返回 Promise<{ok}>。
 * 只负责开窗;后续打印/关窗在 VIEWER_READY 消息里完成(无状态)。
 */
function exportHistoryPdf(id) {
  return loadHistory().then(function (list) {
    var rec = list.filter(function (r) { return String(r.id) === String(id); })[0];
    if (!rec || !rec.payload) return { ok: false, error: '记录不存在或无 payload' };
    pushLog({ time: Date.now(), level: 'info', message: '📄 开始生成 PDF(报表渲染中…) id=' + id });
    var url = chrome.runtime.getURL('report.html') +
      '?id=' + encodeURIComponent(id) + '&t=' + Date.now();
    // 注意:type:'popup' + state:'minimized' 在部分 Chrome 下报 Invalid value for state;
    // 而 left/top 负值(屏外)在新 Chrome 下报 bounds must be at least 50% within visible screen。
    // 方案:先建普通可见 popup(右下角小窗),创建后立即 update 最小化(再失败也不影响 CDP 打印)。
    chrome.windows.create({
      url: url, type: 'popup',
      width: 900, height: 700
    }, function (win) {
      if (chrome.runtime.lastError || !win) {
        pushLog({ time: Date.now(), level: 'err',
          message: 'PDF 导出失败:窗口创建失败 ' + (chrome.runtime.lastError && chrome.runtime.lastError.message) });
        return;
      }
      // 创建成功后立即最小化(减少干扰;失败不影响打印)
      try {
        chrome.windows.update(win.id, { state: 'minimized', drawAttention: false },
          function () { void chrome.runtime.lastError; });
      } catch (e) {}
      pushLog({ time: Date.now(), level: 'info', message: '  报表窗口已开(win=' + win.id + '),等待渲染就绪…' });
    });
    // 立即返回 ok:true(popup 显示「生成中」);真正的下载/失败由后续日志体现
    return { ok: true, pending: true };
  });
}

/** 接收 report 页的就绪/错误消息(无状态:从 sender.tab.id / msg.winId 取目标) */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (msg.type === 'VIEWER_READY') {
    var tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      pushLog({ time: Date.now(), level: 'err', message: 'PDF: VIEWER_READY 缺 sender.tab.id' });
      sendResponse({ ok: false, error: '无 tabId' }); return;
    }
    pushLog({ time: Date.now(), level: 'info', message: '  报表就绪(tab=' + tabId + '),开始打印…' });
    /** 关掉承载该 tab 的窗口(通过 tab 查 winId) */
    function closeTabWin() {
      chrome.tabs.get(tabId, function (t) {
        if (chrome.runtime.lastError || !t || t.windowId == null) {
          chrome.tabs.remove(tabId, function () { void chrome.runtime.lastError; });
          return;
        }
        chrome.windows.remove(t.windowId, function () { void chrome.runtime.lastError; });
      });
    }
    // 等一帧让表格/字体完整渲染再打印
    setTimeout(function () {
      printTabToPdfBase64(tabId).then(function (b64) {
        loadHistory().then(function (list) {
          var rec = list.filter(function (r) { return String(r.id) === String(msg.id); })[0];
          // 内嵌 JSON 附件(失败自动降级为原 PDF)
          return attachPayloadToPdfBase64(b64, rec && rec.payload).then(function (finalB64) {
            downloadBinary(buildPdfFilename(rec && rec.payload, rec && rec.realName, rec && rec.time), finalB64, 'application/pdf');
            pushLog({ time: Date.now(), level: 'ok', message: '✓ PDF 已生成并下载' });
            closeTabWin();
          });
        }).catch(function () { closeTabWin(); });
      }).catch(function (e) {
        pushLog({ time: Date.now(), level: 'err', message: 'PDF 打印失败: ' + (e && e.message || e) });
        closeTabWin();
      });
    }, 800);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'VIEWER_ERROR') {
    pushLog({ time: Date.now(), level: 'err', message: '报表渲染失败: ' + (msg.error || '未知') });
    // 尝试关掉残留报表窗口:靠 sender.tab
    if (sender.tab && sender.tab.id != null) {
      chrome.tabs.get(sender.tab.id, function (t) {
        if (!chrome.runtime.lastError && t && t.windowId != null) {
          chrome.windows.remove(t.windowId, function () { void chrome.runtime.lastError; });
        } else {
          chrome.tabs.remove(sender.tab.id, function () { void chrome.runtime.lastError; });
        }
      });
    }
    sendResponse({ ok: true });
    return;
  }
});

/* ------------------------- CDP 可信点击(保留:datepickers 导航仍需)-------------------------
 * 瑞数加固页面下,合成 JS 事件(isTrusted=false)无法打开日期/年份面板。
 * 用 chrome.debugger + Input.dispatchMouseEvent 发 isTrusted=true 的真鼠标点击。
 * 代价:attach 时浏览器顶栏显示「xx 扩展已开始调试此浏览器」黄条(无法隐藏)。
 */

function cdpClick(tabId, x, y) {
  var attached = false;
  var ts = Date.now();
  var common = { x: x, y: y, button: 'left', clickCount: 1 };
  return Promise.resolve()
    .then(function () {
      return new Promise(function (resolve, reject) {
        chrome.debugger.attach({ tabId: tabId }, '1.3', function () {
          var err = chrome.runtime.lastError;
          attached = !err || !/already attached/i.test(err.message);
          if (err && !attached) reject(new Error(err.message));
          else resolve();
        });
      });
    })
    .then(function () {
      return sendCDP(tabId, 'Input.dispatchMouseEvent',
        Object.assign({ type: 'mousePressed', buttons: 1, timestamp: ts }, common));
    })
    .then(function () {
      return sendCDP(tabId, 'Input.dispatchMouseEvent',
        Object.assign({ type: 'mouseReleased', buttons: 0, timestamp: ts }, common));
    })
    .then(function () { return { ok: true }; })
    .catch(function (e) { return { ok: false, error: e && e.message || String(e) }; })
    .then(function (res) {
      if (attached) {
        return new Promise(function (resolve) {
          chrome.debugger.detach({ tabId: tabId }, function () { resolve(res); });
        });
      }
      return res;
    });
}

if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener(function (source, reason) {
    pushLog({ time: Date.now(), level: 'err',
      message: '调试已断开(tab=' + (source && source.tabId) + ',原因=' + reason + '),CDP 点击将回退 JS' });
  });
}

/* ------------------------- 消息路由 ------------------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'LOG':
      pushLog({ time: Date.now(), level: msg.level || 'info', message: msg.message, line: msg.line });
      sendResponse({ ok: true });
      break;
    case 'STATUS':
      setStatus(msg.status);
      sendResponse({ ok: true });
      break;
    case 'PROGRESS':
      setProgress(msg.done || 0, msg.total || 0);
      sendResponse({ ok: true });
      break;
    case 'SAVE_JOB':
      persistJob(msg.job).then(function () { sendResponse({ ok: true }); });
      return true; // 异步响应
    case 'CLEAR_JOB':
      currentJob = null;
      chrome.storage.local.remove('tax_export_job', function () { sendResponse({ ok: true }); });
      return true;
    case 'GET_JOB':
      // 优先返回内存缓存,否则读 storage
      if (currentJob) { sendResponse({ job: currentJob }); }
      else { loadJobFromStorage().then(function (j) { sendResponse({ job: j }); }); }
      return true;
    case 'GET_STATE':
      // popup 打开时拉取完整状态
      sendResponse({
        status: status,
        progress: progress,
        logs: logs.slice(-200),
        hasJob: !!(currentJob && currentJob.stage && currentJob.stage !== 'done')
      });
      return true;
    case 'EXPORT':
      // content 采集完成发来完整 JSON payload
      exportResults(msg);
      sendResponse({ ok: true });
      break;
    case 'CDP_CLICK':
      // content script 请求 CDP 可信点击。tabId 从 sender 取
      if (!sender.tab || !sender.tab.id) { sendResponse({ ok: false, error: '无 sender.tab.id' }); return; }
      cdpClick(sender.tab.id, msg.x, msg.y).then(function (res) { sendResponse(res); });
      return true;
    case 'RESET':
      currentJob = null;
      status = 'idle';
      progress = { done: 0, total: 0 };
      pushLog({ time: Date.now(), level: 'ok', message: '⏹ 任务已结束(点「开始采集」可启动新任务)' });
      chrome.storage.local.remove('tax_export_job', function () { sendResponse({ ok: true }); });
      return true;
    case 'GET_HISTORY':
      loadHistory().then(function (list) { sendResponse({ history: list }); });
      return true;
    case 'DELETE_HISTORY':
      deleteHistory(msg.id).then(function (list) {
        sendResponse({ ok: true, history: list });
        broadcast({ type: 'HISTORY_UPDATED', history: list });
      });
      return true;
    case 'CLEAR_HISTORY':
      clearHistory().then(function () {
        sendResponse({ ok: true });
        broadcast({ type: 'HISTORY_UPDATED', history: [] });
      });
      return true;
    case 'EXPORT_PDF_HISTORY':
      // 把某条历史记录导出为 PDF(report 渲染 → printToPDF → 下载)
      exportHistoryPdf(msg.id).then(function (r) { sendResponse(r); });
      return true;
    default:
      sendResponse({ ok: false, error: 'unknown type' });
  }
});

// 启动时从 storage 恢复 currentJob(应对 service worker 被回收后重启)
loadJobFromStorage().then(function (j) {
  if (j) {
    currentJob = j;
    status = j.stage === 'done' ? '已完成' : ('续采中(' + j.stage + ')');
  }
});

console.log('[tax-export] background service worker 已启动');
