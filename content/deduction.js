/**
 * content/deduction.js —— 专项附加扣除信息查询:年份选择 + 卡片提取 + 明细导出
 *
 * 选择器迁移自同级 tax-tool 真机校准结果(output/debug/deduction_*.html),
 * 并适配 Chrome 扩展的 Promise 工具链(复用 utils.js 的 waitFor/qsa/clickEl/sleep)。
 *
 * 与申报查询的差异:
 *   - 入口:「我要查询」→ 文字菜单「专项附加扣除信息查询」(非卡片)
 *   - 筛选:单个 year picker(.el-date-editor--year),选年即自动刷新,无「查询」按钮
 *   - 列表:.list-group-wrapper 卡片(标题/键值对/时间/查看按钮),非表格
 *   - 详情:.special-table-wrapper 分段 + td 内 .content-label/.content-value
 *   - 返回:.el-breadcrumb__inner.is-link(含「专项附加扣除信息查询」)
 *
 * 真机 DOM(2026-08 校准):
 *   .el-date-editor--year input → 弹面板 .el-picker-panel.el-date-picker(含 .el-year-table)
 *     10 年一屏(td.available a.cell,文字为年份);翻屏 button[aria-label="前一年"/"后一年"]
 *   .list-group-wrapper > .item-left(.item-title 项目名, .item-text 内 span 键值对,跳过 .item-ylz)
 *                        .item-right(.item-time 最后修改时间, .item-btn 查看)
 *   .detail-table-wrapper > .special-table-wrapper:
 *     .content-wrapper > span.panel-title(段标题)
 *     .content-body table tbody tr td:<span class="content-label">键：</span> + <span class="content-value">值</span>
 */
(function () {
  'use strict';
  var T = window.__taxExport;

  /** 专项附加扣除菜单文字(导航目标) */
  var DEDUCTION_MENU_TEXT = '专项附加扣除信息查询';

  /* ------------------------- 导航:我要查询 → 专项附加扣除 ------------------------- */

  /** 导航到专项附加扣除信息查询页。返回 Promise<boolean>(是否已进入)。 */
  function navigateToDeduction() {
    T.report('① 点击「我要查询」');
    return T.waitFor(function () { return T.findByText('a.navbar-first-menu', '我要查询', false)[0]; })
      .then(function (menu) { T.clickEl(menu); return T.sleep(2500); })
      .then(function () {
        // 「专项附加扣除信息查询」是三级菜单文字链接(非 .card-item),文字匹配
        T.report('② 点击「专项附加扣除信息查询」');
        return T.waitFor(function () {
          // 优先在菜单内精确匹配;失败再放宽到全文档文字匹配
          var hits = T.findByText('a, span, div', DEDUCTION_MENU_TEXT, false).filter(function (el) {
            return T.isVisible(el);
          });
          return hits[hits.length - 1] || null;  // 多个同名时取最后一个(三级菜单项)
        }, 12000);
      })
      .then(function (item) { T.clickEl(item); return T.sleep(4000); })
      .then(function () {
        // 等页面出现:年份控件 或 卡片 或 路由关键词
        return T.waitFor(function () { return T.isOnDeductionListPage() || T.isOnDeductionDetailPage(); }, 15000);
      })
      .then(function () { T.report('已进入专项附加扣除信息查询'); return true; })
      .catch(function (e) {
        T.report('导航专项附加扣除失败:' + (e && e.message || e), 'err');
        return false;
      });
  }

  /* ------------------------- 年份选择器(.el-date-editor--year)-------------------------
   * 与 datepickers.js 的 month/date picker 同源策略:锁定一个含 .el-year-table 的
   * 可见面板,后续操作全部限定在其子树内。10 年一屏,翻屏到含目标年再点。
   */

  /** 取所有「可见且含 .el-year-table」的日期面板 */
  function visibleYearPanels() {
    return T.qsa('.el-picker-panel.el-date-picker').filter(function (p) {
      if (p.style.display === 'none') return false;
      if (!T.isVisible(p)) return false;
      return !!T.qs('.el-year-table', p);
    });
  }

  /** 锁定含 .el-year-table 的可见面板 */
  function lockYearPanel() {
    return T.waitFor(function () { return visibleYearPanels().length > 0; }, 8000)
      .catch(function () { throw new Error('年份面板未出现(可见面板数=0)'); })
      .then(function () { return T.sleep(400); })
      .then(function () {
        var ps = visibleYearPanels();
        if (!ps.length) throw new Error('年份面板未出现(可见面板数=0)');
        return ps[0];
      });
  }

  /** 读已锁定面板内所有年份格的文字(10 年一屏),返回数字数组 */
  function readYears(panel) {
    var ys = [];
    T.qsa('.el-year-table td', panel).forEach(function (td) {
      var a = T.qs('a.cell, .cell', td) || td;
      var n = parseInt(((a.textContent || '').trim()), 10);
      if (!isNaN(n)) ys.push(n);
    });
    return ys;
  }

  /** 在已锁定面板内点年份切换按钮(10 年一屏)。earlier=true 翻到更早十年。返回是否点到。 */
  function clickDecadeBtn(panel, earlier) {
    var btn = earlier
      ? panel.querySelector('button[aria-label="前一年"], .el-icon-d-arrow-left')
      : panel.querySelector('button[aria-label="后一年"], .el-icon-d-arrow-right');
    if (!btn) return false;
    try { T.clickEl(btn); return true; } catch (e) { return false; }
  }

  /** 点目标年份格(限定在已锁定面板内,文字精确匹配,跳过 disabled) */
  function clickYearCell(panel, yearStr) {
    var ok = false;
    T.qsa('.el-year-table td', panel).forEach(function (td) {
      if (ok) return;
      if (td.classList.contains('disabled')) return;
      var a = T.qs('a.cell, .cell', td) || td;
      if (((a.textContent || '').trim()) === yearStr) { T.clickEl(a); ok = true; }
    });
    return ok;
  }

  /**
   * 把「扣除年度」设为 year(如 2022)。
   * 策略(对齐 datepickers.js 的 month/date picker,三级兜底):
   *   1) tryOpenPicker(input):带 pointer/detail 的增强点击 + 点日历图标兜底 → 弹面板
   *   2) 面板弹出 → 锁定含 .el-year-table 的面板 → 翻 10 年屏到含目标 → 点年份格
   *   3) 打不开 → injectInputValue 直接写年(只读 input 多半不收,但仍尝试)
   *   4) 仍不行 → setViaVue Vue 实例兜底
   *   5) 全失败 → 抛错,错误信息带 diagPicker 输出(便于下一步定位)
   * 返回 Promise<boolean>。
   */
  function setStartYear(year) {
    var yearStr = String(year);
    var input = T.qs('.el-date-editor--year input') ||
      (function () {
        // 兜底:placeholder=请选择 的第一个 input
        var all = T.qsa("input[placeholder='请选择']");
        return all[0] || null;
      })();
    if (!input) throw new Error('未找到扣除年度输入框(.el-date-editor--year input)');
    var DP = T.datepickers;
    var editorEl = null;
    try { editorEl = input.closest ? input.closest('.el-date-editor') : null; } catch (e) {}

    return DP.tryOpenPicker(input)
      .then(function (opened) {
        if (opened) {
          // 面板已弹出:锁定 year 面板 → 翻 10 年屏到含目标 → 点年份格
          return lockYearPanel().then(function (panel) {
            var tries = 0;
            function navLoop() {
              tries++;
              if (tries > 12) throw new Error('翻页超过最大次数,仍未定位到 ' + yearStr);
              var ys = readYears(panel);
              if (!ys.length) throw new Error('读不到面板年份');
              var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
              if (year >= lo && year <= hi) return panel;  // 当前屏含目标年
              if (!clickDecadeBtn(panel, year < lo)) throw new Error('找不到年份切换按钮');
              return T.sleep(200).then(navLoop);
            }
            return navLoop();
          }).then(function (panel) {
            if (!clickYearCell(panel, yearStr)) {
              var ys = readYears(panel);
              throw new Error('未找到年份格「' + yearStr + '」(面板内年份范围:' +
                (ys.length ? Math.min.apply(null, ys) + '~' + Math.max.apply(null, ys) : '空') + ')');
            }
            return true;
          });
        }
        // 面板打不开:直接写入 → Vue 兜底
        T.report('    [setStartYear] 面板未弹出(' + DP.diagPicker(input) + '),改用直接写入 ' + yearStr);
        return DP.injectInputValue(input, yearStr)
          .then(function (ok) { return ok || (editorEl && DP.setViaVue(editorEl, new Date(year, 0, 1), yearStr)) || false; })
          .then(function (ok) {
            if (!ok) throw new Error('扣除年度写入失败:点击无面板,直接写入与 Vue 实例兜底均未生效(' + DP.diagPicker(input) + ',value=' + input.value + ')');
            return true;
          });
      })
      .then(function () { return T.sleep(1200); });  // 选年份后页面自动刷新数据
  }

  /* ------------------------- 卡片提取(.list-group-wrapper)------------------------- */

  /**
   * 从 .list-group-wrapper 卡片提取每条专项附加扣除记录。
   * 卡片结构:.item-title(项目名) + .item-text(内 span 键值对,跳过 .item-ylz) + .item-time(最后修改时间)。
   * 注意:.item-text 内可能有隐藏的 .item-ylz(已离职),必须按「每个 .item-text 单独配对」并跳过它。
   * 返回数组:[{项目, 键:值, ..., 最后修改时间}]。
   */
  function extractCards() {
    var cards = [];
    T.qsa('.list-group-wrapper').forEach(function (g) {
      if (!T.isVisible(g)) return;
      var obj = {};
      var title = T.qs('.item-title', g);
      if (title) obj['项目'] = (title.textContent || '').trim();
      // 按 .item-text 逐组配对,跳过 .item-ylz
      T.qsa('.item-text', g).forEach(function (t) {
        var sps = T.qsa('span', t).filter(function (s) {
          return !s.classList.contains('item-ylz');
        });
        // 形如 <span>标签：</span><span>值</span>,成对解析
        for (var i = 0; i + 1 < sps.length; i += 2) {
          var k = (sps[i].textContent || '').trim().replace(/[：:]$/, '');
          var v = (sps[i + 1].textContent || '').trim();
          if (k) obj[k] = v;
        }
      });
      var tm = T.qs('.item-time', g);
      if (tm) obj['最后修改时间'] = (tm.textContent || '').trim();
      cards.push(obj);
    });
    return cards;
  }

  /* ------------------------- 点「查看」进明细页 ------------------------- */

  /** 点击第 cardIndex 个卡片的「查看」按钮(.item-btn button.item-sear-btn)。 */
  function clickCardView(cardIndex) {
    var ok = (function () {
      var groups = T.qsa('.list-group-wrapper').filter(T.isVisible);
      var g = groups[cardIndex];
      if (!g) return { ok: false, reason: '无卡片 #' + cardIndex };
      var btn = T.qs('.item-btn button.item-sear-btn', g) ||
        T.qs('.item-btn button', g);
      if (!btn) return { ok: false, reason: '无查看按钮' };
      T.clickEl(btn);
      return { ok: true };
    })();
    if (!ok.ok) throw new Error('点击专项附加扣除「查看」失败:' + ok.reason);
    return T.sleep(3000);
  }

  /* ------------------------- 明细页导出(.special-table-wrapper)-------------------------
   * 每个 special-table-wrapper 一段:.panel-title 段标题 + td 内 content-label/content-value。
   * 个别字段(如「扣缴义务人」)值是裸 span(无 content-value),用 content-label 后同级 span 兜底。
   * v3:多主体保留(不覆盖)——
   *   a) 同段名出现多份(同页多个孩子各有「教育信息」wrapper):教育信息、教育信息2…
   *   b) 段内表格多行键重复(同 wrapper 内多个主体行):行内键与当前主体重复即开新主体
   *   c) 完全相同的主体(跨 wrapper 重复展示)只留一份
   * transformPayload 会把 教育信息2 等多主体段拆成逐主体多条 item(PDF 多行)。
   */

  function captureDeductionDetail() {
    var out = { sections: {} };
    var root = T.qs('.detail-table-wrapper') || document.body;
    var blocks = T.qsa('.special-table-wrapper', root);
    var used = {};      // 段名 → 已用次数(同名第 2 份起加序号)
    var seenSubj = {};  // 段名|主体JSON → 去重(同主体跨 wrapper 重复)
    blocks.forEach(function (blk) {
      var tEl = T.qs('.content-wrapper .panel-title, .panel-title', blk);
      var segName = tEl ? (tEl.textContent || '').trim() : '(未命名)';
      if (!segName) segName = '(未命名)';
      /** 取一个 td 的键值(content-value 优先,裸 span 兜底);无 content-label 返回 null */
      function cellKv(td) {
        var lbl = T.qs('.content-label', td);
        if (!lbl) return null;
        var key = (lbl.textContent || '').trim().replace(/[：:]\s*$/, '').trim();
        if (!key) return null;
        var val = '';
        var valEl = T.qs('.content-value', td);
        if (valEl) {
          val = (valEl.textContent || '').trim();
        } else {
          var sib = lbl.nextElementSibling, guard = 0;
          while (sib && guard < 4) {
            if (sib.tagName === 'SPAN' && sib.className !== 'content-label') {
              var t = (sib.textContent || '').trim();
              if (t) { val = t; break; }
            }
            sib = sib.nextElementSibling;
            guard++;
          }
        }
        return val ? { key: key, val: val } : null;
      }
      // 段内按 tr 分行;键与当前主体重复 → 新主体(同段多行=多主体,如多个子女)
      var subjects = [{}];
      T.qsa('table tbody tr', blk).forEach(function (tr) {
        var rowKv = [];
        T.qsa('td', tr).forEach(function (td) {
          var kv = cellKv(td);
          if (kv) rowKv.push(kv);
        });
        rowKv.forEach(function (kv) {
          var cur = subjects[subjects.length - 1];
          if (Object.prototype.hasOwnProperty.call(cur, kv.key)) subjects.push({});
          subjects[subjects.length - 1][kv.key] = kv.val;
        });
      });
      // 兼容无 tr 结构的退化页面:平铺 td(单主体)
      if (subjects.length === 1 && !Object.keys(subjects[0]).length) {
        T.qsa('table tbody tr td', blk).forEach(function (td) {
          var kv = cellKv(td);
          if (kv) subjects[0][kv.key] = kv.val;
        });
      }
      subjects.forEach(function (kv) {
        var keys = Object.keys(kv);
        if (!keys.length) return;
        var dedupKey = segName + '|' + keys.map(function (k) { return k + '=' + kv[k]; }).join('&');
        if (seenSubj[dedupKey]) return;  // 同主体已收(跨 wrapper 重复展示)
        seenSubj[dedupKey] = true;
        used[segName] = (used[segName] || 0) + 1;
        var name = used[segName] > 1 ? segName + used[segName] : segName;
        out.sections[name] = kv;
      });
    });
    return out;
  }

  /* ------------------------- 返回列表(.el-breadcrumb__inner.is-link)------------------------- */

  /** 点面包屑返回专项附加扣除列表。返回是否点到。 */
  function clickDeductionBreadcrumb() {
    var hit = T.qsa('.el-breadcrumb__inner').filter(function (e) {
      return ((e.textContent || '').trim().indexOf(DEDUCTION_MENU_TEXT) !== -1);
    })[0];
    if (hit) { T.clickEl(hit); return true; }
    return false;
  }

  T.deduction = {
    DEDUCTION_MENU_TEXT: DEDUCTION_MENU_TEXT,
    navigateToDeduction: navigateToDeduction,
    setStartYear: setStartYear,
    extractCards: extractCards,
    clickCardView: clickCardView,
    captureDeductionDetail: captureDeductionDetail,
    clickDeductionBreadcrumb: clickDeductionBreadcrumb
  };
})();
