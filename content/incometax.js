/**
 * content/incometax.js —— 收入纳税明细查询:逐年读取「已申报税额合计」
 *
 * 申报查询全部阶段(默认视图/条件查询/已作废)采完后执行:
 *   我要查询 → 「收入纳税明细查询」卡片 → 逐年设年度 → 读右侧汇总卡「已申报税额合计」。
 * 读到的值作为年度汇算[y].已预缴税额 的数据源(退税记录口径仅作未采到年份的兜底)。
 *
 * 真机 DOM(2026-08 用户提供):
 *   入口卡片:a.card-item > h5.card-title 文字「收入纳税明细查询」
 *   汇总卡:.card-right > .card-content > p.content-title「已申报税额合计」
 *          + p.content-money > span.money(如 692.46)+ span「元」
 *   年度控件(2026-08 真机校准):策略1 遍历 el-select 下拉(优先值/placeholder 像年份的);
 *     策略2 复用专项附加的 year picker(.el-date-editor--year)。
 *   缺失年补采:列表每行即当月明细(税款所属期 2021-12=2021 年 12 月),翻页遍历汇总,不点「查看」。
 * 任一步失败只跳过该年/整阶段,不阻塞后续(专项附加扣除/导出)。
 */
(function () {
  'use strict';
  var T = window.__taxExport;
  var DEDUCT = T.deduction;

  var CARD_TITLE = '收入纳税明细查询';

  /** 是否在收入纳税明细查询页(右侧汇总卡 .card-right .content-title 为页面签名) */
  function isOnIncomeTaxPage() {
    return T.qsa('.card-right .content-title').some(function (t) { return T.isVisible(t); });
  }

  /* ------------------------- 导航:我要查询 → 收入纳税明细查询 ------------------------- */

  function navigateToIncomeTax() {
    T.report('① 点击「我要查询」');
    return T.waitFor(function () { return T.findByText('a.navbar-first-menu', '我要查询', false)[0]; })
      .then(function (menu) { T.clickEl(menu); return T.sleep(2500); })
      .then(function () {
        T.report('② 点击「收入纳税明细查询」');
        return T.waitFor(function () {
          return T.qsa('.card-item').filter(function (c) {
            return (c.textContent || '').indexOf(CARD_TITLE) !== -1 && T.isVisible(c);
          })[0] || null;
        }, 12000);
      })
      .then(function (card) { T.clickEl(card); return T.sleep(4000); })
      .then(function () { return T.waitFor(isOnIncomeTaxPage, 15000); })
      .then(function () { T.report('已进入收入纳税明细查询'); return true; })
      .catch(function (e) {
        T.report('导航收入纳税明细查询失败:' + (e && e.message || e), 'err');
        return false;
      });
  }

  /* ------------------------- 年度设置 + 汇总读取 ------------------------- */

  /** 点「查询」按钮(若有;部分版本改年度即自动刷新)。「查 询」等带空格文案也兼容。 */
  function clickQueryIfAny() {
    var btn = T.findByText('button', '查询', false).filter(function (b) { return T.isVisible(b); })[0] ||
      T.qsa('button').filter(function (b) {
        return T.isVisible(b) && (b.textContent || '').replace(/\s+/g, '') === '查询';
      })[0];
    if (!btn) return T.sleep(0);
    T.clickEl(btn);
    return T.sleep(2500);
  }

  /**
   * 设所得年度为 year。返回 Promise<boolean>。
   * 策略1:el-select 下拉 —— 页面常有多个下拉(所得项目等),第一个未必是年度:
   *        优先「当前值像年份 / placeholder 含年」的候选,再兜底其余可见下拉,
   *        逐个点开等可见选项,找到文字含目标年的选项即点(都不含才换下一个下拉);
   * 策略2:复用专项附加扣除的 year picker(.el-date-editor--year,翻 10 年屏点年份);
   * 设完点「查询」(若有)。两者都失败返回 false(该年跳过)。
   */
  function setQueryYear(year) {
    var ystr = String(year);
    function selectCandidates() {
      var scored = [], rest = [];
      T.qsa('.el-select').filter(function (s) { return T.isVisible(s); }).forEach(function (s) {
        var inp = T.qs('.el-input__inner, input', s);
        var v = inp ? String(inp.value || '').trim() : '';
        var ph = inp ? String(inp.placeholder || '') : '';
        var looksYear = /^\d{4}/.test(v) || /年/.test(v) || /年/.test(ph);
        (looksYear ? scored : rest).push(s);
      });
      return scored.concat(rest);
    }
    function trySelect(sel) {
      var inp = T.qs('.el-input__inner, input', sel) || sel;
      T.clickEl(inp);
      return T.waitFor(function () {
        return T.qsa('.el-select-dropdown__item').some(function (it) { return T.isVisible(it); });
      }, 6000)
        .then(function () { return T.sleep(300); })  // 等下拉内容稳定(防读到上一个下拉的残留项)
        .then(function () {
          var item = T.qsa('.el-select-dropdown__item').filter(function (it) {
            if (!T.isVisible(it)) return false;
            var t = (it.textContent || '').replace(/\s+/g, '');
            return t === ystr || t === ystr + '年' || t.indexOf(ystr) === 0;
          })[0];
          if (!item) { try { T.clickEl(inp); } catch (e) {} /* 收起,换下一个候选 */ throw new Error('下拉无「' + ystr + '」选项'); }
          T.clickEl(item);
          return T.sleep(1200);
        });
    }
    var list = selectCandidates();
    function attempt(i) {
      if (i >= list.length) return Promise.reject(new Error(list.length + ' 个下拉均无「' + ystr + '」选项'));
      return trySelect(list[i]).catch(function () { return attempt(i + 1); });
    }
    var viaSelect = list.length ? attempt(0) : Promise.reject(new Error('无 el-select'));
    // select 成功即结束;失败(或无下拉)才落到 year picker,设完点「查询」(若有)
    var p = list.length
      ? viaSelect.then(function () { return true; })
          .catch(function (e1) {
            T.report('    年度下拉设置失败(' + (e1 && e1.message || e1) + '),改试 year picker', 'err');
            return false;
          })
      : Promise.resolve(false);
    return p
      .then(function (selectOk) { return selectOk ? null : DEDUCT.setStartYear(year); })
      .then(function () { return clickQueryIfAny(); })
      .then(function () { return true; })
      .catch(function (e2) {
        T.report('    ' + ystr + ' 年度设置失败(' + (e2 && e2.message || e2) + ')', 'err');
        return false;
      });
  }

  /** 读「已申报税额合计」:匹配 .card-content 内 .content-title 含关键字 → 同卡 .money。返回数字字符串或 ''。 */
  function readDeclaredTaxTotal() {
    var hit = T.qsa('.card-content').filter(function (c) {
      var t = T.qs('.content-title', c);
      return t && (t.textContent || '').indexOf('已申报税额合计') !== -1 && T.isVisible(c);
    })[0];
    if (!hit) return '';
    var m = T.qs('.money', hit);
    if (!m) return '';
    var v = (m.textContent || '').trim().replace(/[,\s元]/g, '');
    return /^\d+(\.\d+)?$/.test(v) ? v : '';
  }

  /** 等汇总值出现(非空数字)再读。返回 Promise<string>('' 超时) */
  function waitDeclaredTaxTotal() {
    return T.waitFor(function () { return readDeclaredTaxTotal() !== ''; }, 8000)
      .then(function () { return readDeclaredTaxTotal(); })
      .catch(function () { return ''; });
  }

  /* ------------------------- 明细列表翻页:合并全年一次性奖金行的已申报税额 -------------------------
   * 真机 DOM(2026-08 用户提供):.el-pagination > ul.el-pager > li.number(.active 当前页)
   *   + button.btn-next(尾页 disabled)。明细行:所得项目/所得项目小类/扣缴义务人/收入(元)/已申报税额(元)/税款所属期。
   * 所得项目小类=「全年一次性奖金收入」的行,其 已申报税额(元) 跨页合计 → 资薪奖金税额。
   */

  /** 读当前页 el-table 行(thead th 作列名,去空白;跳过暂无数据) */
  function readIncomeRows() {
    var rows = [];
    T.qsa('.el-table').forEach(function (tbl) {
      if (!T.isVisible(tbl)) return;
      var thEls = T.qsa('thead th', tbl);
      if (!thEls.length) return;
      var ths = thEls.map(function (th) { return (th.textContent || '').replace(/\s+/g, '').trim(); });
      T.qsa('tbody tr', tbl).forEach(function (tr) {
        var txt = (tr.textContent || '').replace(/\s+/g, '');
        if (!txt || txt.indexOf('暂无数据') !== -1) return;
        var row = {};
        T.qsa('td', tr).forEach(function (td, i) { row[ths[i] || ('col' + i)] = (td.textContent || '').trim(); });
        rows.push(row);
      });
    });
    return rows;
  }

  /** pagination 当前页码(li.number.active 的文字) */
  function activePageNo(pager) {
    var li = T.qsa('li.number.active', pager)[0];
    var n = li ? parseInt((li.textContent || '').trim(), 10) : 0;
    return isNaN(n) ? 0 : n;
  }

  /** 行签名:期间|小类|收入 —— 翻页内容变化检测(首列「所得类型」跨页恒为 工资薪金,不可作信号) */
  function rowSignature(row) {
    return pickPeriod(row) + '|' + String(colOf(row, '所得项目小类') || '').replace(/\s+/g, '') + '|' +
      String(colOf(row, '收入') || '').replace(/[,\s]/g, '');
  }

  /** 翻下一页:优先点下一数字页码,再点 btn-next(尾页 disabled 停)。
   *  逐行「查看→返回」后列表会重渲染,分页控件可能晚于表格挂载 → 先等 pager 再判定;
   *  生效判定 = 页码增大 且 首行签名变化(数据真正刷新);未生效重试 3 次,停止原因写日志。
   *  返回 Promise<boolean>。 */
  function gotoNextIncomePage(prevKey) {
    function pagersInDom() { return T.qsa('.el-pagination'); }
    function pagerNow() {
      var vis = pagersInDom().filter(function (p) { return T.isVisible(p); });
      if (vis.length) return vis[0];
      // 可见性误判兜底:DOM 里存在且带数字页码的也认(rect/样式在重渲染期可能暂态异常)
      return pagersInDom().filter(function (p) { return T.qsa('li.number', p).length > 0; })[0] || null;
    }
    function waitPager() {
      return T.waitFor(pagerNow, 12000).catch(function () { return null; });
    }
    var attempts = 0;
    function tryFlip() {
      var pager = pagerNow();
      if (!pager) return { ok: false, why: '无分页控件' };
      var cur = activePageNo(pager);
      var target = T.qsa('li.number', pager).filter(function (li) {
        var n = parseInt((li.textContent || '').trim(), 10);
        return !isNaN(n) && n === cur + 1;
      })[0];
      var nextBtn = T.qs('button.btn-next', pager);
      var nextDisabled = !nextBtn || nextBtn.disabled ||
        (nextBtn.getAttribute && nextBtn.getAttribute('disabled') != null);
      if (!target && nextDisabled) return { ok: false, why: '已到尾页(第 ' + cur + ' 页)' };
      // 点击策略(对齐 detail.js collectPages 已验证方案:页面上下文原生 el.click(),瑞数兼容):
      // ① 目标数字页码 li 原生 click → ② btn-next 原生 click → ③ clickEl 事件派发兜底
      function nativeClick(el) { try { el.click(); return true; } catch (e) { return false; } }
      var how = null;
      if (target && nativeClick(target)) how = '页码 li.click';
      else if (nextBtn && !nextDisabled && nativeClick(nextBtn)) how = 'btn-next.click';
      else { try { T.clickEl(target || nextBtn); how = 'clickEl'; } catch (e) {} }
      if (!how) return { ok: false, why: '翻页元素点击失败' };
      return T.waitFor(function () {
        var p2 = pagerNow();
        if (!p2 || !(activePageNo(p2) > cur)) return false;
        var rows = readIncomeRows();
        return rows.length > 0 && rowSignature(rows[0]) !== prevKey;
      }, 8000).then(function () {
        T.report('    翻页成功(' + how + ')', 'ok');
        return { ok: true };
      }).catch(function () {
        attempts++;
        if (attempts < 3) {
          T.report('    翻页第 ' + attempts + ' 次点击未生效(' + how + '),重试', 'err');
          return T.sleep(1000).then(tryFlip);
        }
        return { ok: false, why: '页码点击未生效(停在第 ' + cur + ' 页)' };
      });
    }
    return waitPager().then(function (p) {
      if (!p) {
        // 诊断:DOM 里到底有没有分页、几个可见 —— 区分 挂载慢/误判/根本不在列表页
        var all = pagersInDom();
        return { ok: false, why: '无分页控件(等待 12s;DOM 中 ' + all.length + ' 个,可见 ' +
          all.filter(function (q) { return T.isVisible(q); }).length + ' 个)' };
      }
      return tryFlip();
    }).then(function (r) {
      if (!r.ok) T.report('    翻页停止:' + r.why, 'err');
      return r.ok;
    });
  }

  /** 翻页扫描全部明细:合并 所得项目小类含「全年一次性奖金」行的 已申报税额(元)。
   *  返回 Promise<string>(两位小数合计;无奖金行 '0.00')。 */
  function collectBonusDeclaredTax() {
    var sum = 0, hits = 0, pages = 0;
    function col(row, kw) {
      var keys = Object.keys(row);
      for (var i = 0; i < keys.length; i++) { if (keys[i].indexOf(kw) !== -1) return row[keys[i]]; }
      return '';
    }
    function grab() {
      if (pages > T.MAX_PAGES) { T.report('    ⚠ 翻页超过 ' + T.MAX_PAGES + ' 页,停止', 'err'); return Promise.resolve(); }
      var rows = readIncomeRows();
      var prevKey = rows.length ? rowSignature(rows[0]) : '';
      rows.forEach(function (r) {
        var cat = String(col(r, '所得项目小类') || '');
        if (cat.indexOf('全年一次性奖金') === -1) return;
        var v = parseFloat(String(col(r, '已申报税额')).replace(/[,\s元]/g, ''));
        if (!isNaN(v)) { sum += v; hits++; }
      });
      pages++;
      if (!rows.length) return Promise.resolve();
      return gotoNextIncomePage(prevKey).then(function (ok) {
        if (!ok) return;
        return T.sleep(1000).then(grab);
      });
    }
    return T.sleep(800).then(grab).then(function () {
      var out = (Math.round(sum * 100) / 100).toFixed(2);
      T.report('    资薪奖金税额 ' + hits + ' 行/' + pages + ' 页,合计 ' + out + ' 元', hits ? 'ok' : 'err');
      return out;
    });
  }

  /* ------------------------- 缺失年份补采:遍历列表行,逐行「查看」读月度明细 -------------------------
   * 真机校准(2026-08):列表每行=当月一条(期间列 = 年-月,如 2021-12);点行内「查看」进入该月明细页。
   * 列表表头:所得类型/所得项目小类/扣缴义务人/收入(元)/已申报税额(元)/税款属期/操作
   *   —— 期间列表头叫「税款属期」,按表头猜不可靠,期间列按「值形态 YYYY-MM(-DD)」识别。
   * 明细页(用户提供 DOM):tab 面板 #pane-srykc 内 .income-tax-payment-detail-item
   *   (.label「本期收入」等 + .value span.money);进详情后该 tab 可能未激活 → pane 隐藏,需点 tab。
   * 流程:逐页 → 逐行(目标年、未处理)→ 点查看 → (激活 tab)读月度项目 → 返回列表 → 下一行。
   * 列表行的 收入/已申报税额 始终作为汇总兜底;月度明细读到则并入 汇总(本期xxx)。
   */

  /** 按列名关键字取值(表头可能带「(元)」等后缀) */
  function colOf(row, kw) {
    var keys = Object.keys(row);
    for (var i = 0; i < keys.length; i++) { if (keys[i].indexOf(kw) !== -1) return row[keys[i]]; }
    return '';
  }

  /** 识别行的期间值(如 2021-12):优先表头含 属期/月份 等字样的列,兜底扫描值形态 YYYY-MM(-DD)。 */
  function pickPeriod(row) {
    var keys = Object.keys(row);
    function norm(v) { return String(v == null ? '' : v).replace(/\s+/g, ''); }
    function asYm(v) {
      var m = norm(v).match(/^(\d{4}-\d{1,2})(?:-\d{1,2})?$/);
      return m ? m[1] : '';
    }
    for (var i = 0; i < keys.length; i++) {
      if (/所属期|属期|所属时间|月份|期间/.test(keys[i])) {
        var v1 = asYm(row[keys[i]]);
        if (v1) return v1;
      }
    }
    for (var j = 0; j < keys.length; j++) {
      var v2 = asYm(row[keys[j]]);
      if (v2) return v2;
    }
    return '';
  }

  /** 月度明细项目键(明细页 .label 文字;专项附加扣除等可能不显示,读到什么算什么) */
  var MONTH_ITEMS = ['本期收入', '本期免税收入', '本期减除费用', '本期专项扣除', '本期其他扣除', '本期准予扣除的捐赠项目'];

  /** 可见的月度明细项 */
  function visibleDetailItems() {
    return T.qsa('.income-tax-payment-detail-item').filter(function (item) { return T.isVisible(item); });
  }

  /** 明细项在 DOM 里但 pane 隐藏(未激活 tab)时,点出对应 tab。返回是否尝试了点击。 */
  function ensureDetailPane() {
    var pane = T.qsa('.el-tab-pane, [role="tabpanel"]').filter(function (p) {
      return T.qsa('.income-tax-payment-detail-item', p).length > 0;
    })[0];
    if (!pane || T.isVisible(pane)) return false;
    var id = pane.id;
    if (!id) return false;
    var tab = T.qsa('.el-tabs__item, [role="tab"], .its-tab').filter(function (t) {
      if (!t.getAttribute) return false;
      return t.getAttribute('aria-controls') === id || t.getAttribute('href') === '#' + id;
    })[0];
    if (!tab) return false;
    try { T.clickEl(tab); } catch (e) { return false; }
    return true;
  }

  /** 读月度明细页项目(.label + .value .money)。返回 {本期xxx: number}(按 label 汇总) */
  function readMonthlyItems() {
    var out = {};
    visibleDetailItems().forEach(function (item) {
      var lbl = T.qs('.label', item);
      var money = T.qs('.value .money', item) || T.qs('.money', item);
      if (!lbl || !money) return;
      var k = (lbl.textContent || '').replace(/\s+/g, '');
      var v = parseFloat((money.textContent || '').replace(/[,\s元]/g, ''));
      if (k && !isNaN(v)) out[k] = (out[k] || 0) + v;
    });
    return out;
  }

  /** 等月度明细渲染(必要时点 tab 激活 pane)。返回 Promise<object|null>(null=超时未读到) */
  function waitMonthlyItems() {
    var triedTab = false;
    return T.waitFor(function () {
      if (!visibleDetailItems().length && !triedTab) triedTab = ensureDetailPane();
      return visibleDetailItems().length > 0;
    }, 16000)
      .then(function () { return T.sleep(600); })
      .then(function () { return readMonthlyItems(); })
      .catch(function () { return null; });
  }

  /** 从月度详情页返回列表:三种方式依次尝试,每步验证「带期间的列表行」回来了才认。
   *  1) 「返回」按钮(容错「返 回」空白) 2) 面包屑「收入纳税明细」 3) history.back */
  function backToList() {
    function listBack() {
      return readIncomeRows().some(function (r) { return !!pickPeriod(r); });
    }
    function tryStep(click) {
      return click().then(function (clicked) {
        if (!clicked) return false;
        return T.waitFor(listBack, 6000).then(function () { return true; }).catch(function () { return false; });
      });
    }
    function rc(el) {
      try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); } catch (e) {}
      return T.sleep(300).then(function () {
        return T.detail.realClick(el).then(function () { return true; }, function () { return false; });
      });
    }
    return tryStep(function () {
      var back = T.qsa('button, a, span').filter(function (b) {
        if (!T.isVisible(b)) return false;
        var t = (b.textContent || '').replace(/\s+/g, '');
        return t === '返回' || t === '返回列表';
      })[0];
      return back ? rc(back) : Promise.resolve(false);
    }).then(function (ok) {
      if (ok) return true;
      return tryStep(function () {
        var crumb = T.qsa('.el-breadcrumb a, .its-breadcrumb a, .el-breadcrumb__inner').filter(function (a) {
          return (a.textContent || '').indexOf('收入纳税明细') !== -1;
        })[0];
        return crumb ? rc(crumb) : Promise.resolve(false);
      });
    }).then(function (ok) {
      if (ok) return true;
      return tryStep(function () {
        try { history.back(); } catch (e) { return Promise.resolve(false); }
        return Promise.resolve(true);
      });
    }).then(function (ok) {
      if (!ok) T.report('    返回列表失败(返回按钮/面包屑/history 均未回到列表)', 'err');
      return ok;
    });
  }

  /** 按行文字特征(期间+小类+收入)定位当前可见行并点其「查看」。
   *  点前先 scrollIntoView 居中 —— cdpClick 按视口坐标派发,行在折叠线以下会点空(真机 2021-05 起连败的根因)。 */
  function clickRowView(row) {
    var kw = pickPeriod(row);
    var kw2 = String(colOf(row, '所得项目小类') || '').replace(/\s+/g, '');
    var kw3 = String(colOf(row, '收入') || '').replace(/[,\s]/g, '');
    var tr = T.qsa('.el-table tbody tr').filter(function (t) {
      if (!T.isVisible(t)) return false;
      var s = (t.textContent || '').replace(/\s+/g, '');
      return (!kw || s.indexOf(kw) !== -1) && (!kw2 || s.indexOf(kw2) !== -1) && (!kw3 || s.indexOf(kw3) !== -1);
    })[0];
    if (!tr) return Promise.resolve(false);
    var btn = T.qsa('button, a', tr).filter(function (b) {
      return (b.textContent || '').indexOf('查看') !== -1;
    })[0] || T.qsa('button', tr)[0];
    if (!btn) return Promise.resolve(false);
    try {
      if (btn.scrollIntoView) btn.scrollIntoView({ block: 'center' });
    } catch (e) { try { btn.scrollIntoView(); } catch (e2) {} }
    return T.sleep(300)
      .then(function () { return T.detail.realClick(btn).then(function () { return true; }).catch(function () { return false; }); });
  }

  /**
   * 补采缺失年份:逐页遍历列表行,每行点「查看」读月度明细后返回。
   * 返回 Promise<{月明细:[行], 汇总:{收入,已申报税额,本期xxx…}}|null>(null=目标年一行都没有)。
   * 「期间|小类」已处理标记保证:明细读取失败不重试(记日志继续),刷新续跑不重复点。
   */
  function collectMissingYear(year) {
    var ystr = String(year);
    var collected = {};   // key → 行(列表口径,兜底)
    var detailed = {};    // key → true(该行「查看」已处理,无论成败)
    var sums = { '收入': 0, '已申报税额': 0 };
    var pages = 0, totalRows = 0, samples = [], detailHits = 0, bonusCount = 0;
    function num(v) { var n = parseFloat(String(v || '0').replace(/[,\s元]/g, '')); return isNaN(n) ? 0 : n; }
    function key(r) { return pickPeriod(r) + '|' + String(colOf(r, '所得项目小类') || '').replace(/\s+/g, ''); }
    /** 奖金行:所得项目小类含「奖金」(如 全年一次性奖金收入)——按列表口径计入奖金,不进「查看」(详情页无月度项目) */
    function isBonusRow(r) { return String(colOf(r, '所得项目小类') || '').indexOf('奖金') !== -1; }

    function collectRow(r) {
      var ym = pickPeriod(r);
      if (ym.indexOf(ystr) !== 0) return;  // 只收目标年
      var k = ym + '|' + String(colOf(r, '所得项目小类') || '').replace(/\s+/g, '');
      if (collected[k]) return;
      var rec = {
        '税款所属期': ym,
        '所得类型': String(colOf(r, '所得类型') || '').trim() || '工资薪金',
        '所得项目小类': String(colOf(r, '所得项目小类') || '').replace(/\s+/g, ''),
        '扣缴义务人': String(colOf(r, '扣缴义务人') || '').trim(),
        '收入(元)': String(colOf(r, '收入') || '').trim(),
        '已申报税额(元)': String(colOf(r, '已申报税额') || '').trim()
      };
      collected[k] = rec;
      if (isBonusRow(r)) bonusCount++;
      sums['收入'] += num(rec['收入(元)']);
      sums['已申报税额'] += num(rec['已申报税额(元)']);
    }

    /** 位置诊断:详情项数 / 列表行数 / 面包屑 —— 排查「卡在哪一页」 */
    function diagWhere() {
      var crumbs = T.qsa('.el-breadcrumb__inner, .its-breadcrumb, .el-breadcrumb a').map(function (b) {
        return (b.textContent || '').trim();
      }).filter(Boolean).slice(0, 4).join('/');
      return '详情项 ' + T.qsa('.income-tax-payment-detail-item').length +
        ',列表行 ' + readIncomeRows().length + (crumbs ? ',面包屑:' + crumbs : '');
    }
    function onList() {
      return readIncomeRows().some(function (rr) { return !!pickPeriod(rr); });
    }
    /** 读月度明细并返回列表(k = 行键) */
    function readDetailAndBack(k2) {
      return waitMonthlyItems().then(function (items) {
        detailed[k2] = true;
        if (items) {
          detailHits++;
          MONTH_ITEMS.forEach(function (mk) {
            if (items[mk] != null) sums[mk] = (sums[mk] || 0) + items[mk];
          });
          if (collected[k2]) collected[k2]['月度明细'] = items;
          T.report('    ' + k2 + ' ✓', 'ok');
        } else {
          T.report('    ' + k2 + ' 月度明细未读到(' + diagWhere() + ')', 'err');
        }
      }).then(function () { return backToList(); });
    }

    /** 处理当前页第一个未处理的目标年行(奖金行跳过):点查看 → 读明细 → 返回 → 继续 */
    function processVisible() {
      var rows = readIncomeRows();
      rows.forEach(collectRow);
      var pending = rows.filter(function (r) {
        if (pickPeriod(r).indexOf(ystr) !== 0) return false;
        if (isBonusRow(r)) return false;  // 奖金行不进详情,列表口径已计入
        return !detailed[key(r)];
      });
      if (!pending.length) return gotoNextAndContinue();
      var r = pending[0];
      var k = key(r);
      return clickRowView(r).then(function (ok) {
        if (!ok) {
          T.report('    ' + k + ' 未匹配到行/查看按钮,跳过', 'err');
          detailed[k] = true;
          return null;
        }
        return T.sleep(3000).then(function () {
          var itemsInDom = T.qsa('.income-tax-payment-detail-item').length > 0;
          if (!itemsInDom && onList()) {
            // 点击没有离开列表:绝不能执行「返回」(会误点列表页元素导航走),重试一次点击
            T.report('    ' + k + ' 查看点击未跳转(' + diagWhere() + '),重试', 'err');
            return clickRowView(r).then(function (ok2) {
              detailed[k] = true;
              if (!ok2) return null;
              return T.sleep(3000).then(function () {
                if (T.qsa('.income-tax-payment-detail-item').length === 0 && onList()) {
                  T.report('    ' + k + ' 查看重试仍未跳转,跳过该行', 'err');
                  return null;
                }
                return readDetailAndBack(k);
              });
            });
          }
          return readDetailAndBack(k);
        });
      }).then(function () { return processVisible(); });
    }

    function gotoNextAndContinue() {
      if (pages > T.MAX_PAGES) { T.report('    ⚠ 翻页超过 ' + T.MAX_PAGES + ' 页,停止', 'err'); return Promise.resolve(null); }
      // 「查看→返回」后列表可能仍在重渲染:先等表格行回来,再尝试翻页
      return T.waitFor(function () { return readIncomeRows().length > 0; }, 12000).catch(function () {})
        .then(function () {
          var rowsNow = readIncomeRows();
          rowsNow.forEach(function (r) { totalRows++; var ym = pickPeriod(r); if (samples.length < 3 && ym && samples.indexOf(ym) === -1) samples.push(ym); });
          var prevKey = rowsNow.length ? rowSignature(rowsNow[0]) : '';
          return gotoNextIncomePage(prevKey).then(function (ok) {
            if (!ok) return null;
            pages++;
            return T.sleep(1000).then(processVisible);
          });
        });
    }

    return T.sleep(800).then(processVisible).then(function () {
      var 月明细 = Object.keys(collected).map(function (k) { return collected[k]; });
      if (!月明细.length) {
        // 诊断:列表里到底有什么(区分 年度没设置上 vs 列识别失败)
        T.report('    目标年 ' + ystr + ' 无匹配行(共 ' + totalRows + ' 行,期间样例:' +
          (samples.join('、') || '未识别到期间列') + ')', 'err');
        return null;
      }
      var out = { '月明细': 月明细, '汇总': {} };
      Object.keys(sums).forEach(function (k) {
        out['汇总'][k] = Math.round(sums[k] * 100) / 100;
      });
      T.report('    列表遍历 ' + 月明细.length + ' 行(奖金 ' + bonusCount + ' 行按列表计入,不进详情)' +
        '(月度明细 ' + detailHits + '/' + (月明细.length - bonusCount) + ')' +
        '(收入 ' + out['汇总']['收入'] + ' / 已申报税额 ' + out['汇总']['已申报税额'] + ')', 'ok');
      return out;
    });
  }

  T.incomeTax = {
    isOnIncomeTaxPage: isOnIncomeTaxPage,
    navigateToIncomeTax: navigateToIncomeTax,
    setQueryYear: setQueryYear,
    readDeclaredTaxTotal: readDeclaredTaxTotal,
    waitDeclaredTaxTotal: waitDeclaredTaxTotal,
    readIncomeRows: readIncomeRows,
    gotoNextIncomePage: gotoNextIncomePage,
    collectBonusDeclaredTax: collectBonusDeclaredTax,
    collectMissingYear: collectMissingYear
  };
})();
