/**
 * content/list.js —— 申报查询:列表准备 + 提取 + 点查看
 */
(function () {
  'use strict';
  var T = window.__taxExport;
  var DP = T.datepickers;

  function clickQueryButton() {
    var btns = T.findByText('button', '查询', false);
    if (!btns.length) throw new Error('未找到「查询」按钮');
    T.clickEl(btns[0]);
    return T.sleep(3000);
  }

  /** 点击状态 tab(.el-radio-button,如「已完成」「已作废」)。找不到时不报错(兼容无该 tab 的页面) */
  function clickStatusTab(tabText) {
    var hits = T.qsa('.el-radio-button').filter(function (r) {
      return (r.textContent || '').indexOf(tabText) !== -1 && T.isVisible(r);
    });
    if (!hits.length) hits = T.findByText('label', tabText, false).filter(T.isVisible);
    if (!hits.length) { return T.sleep(0); }
    T.clickEl(hits[0]);
    return T.sleep(3000);
  }

  /** 诊断:dump 当前页面日期框/面板的真实情况(失败时调用,帮助定位) */
  function dumpDateContext(step) {
    try {
      var editors = T.qsa('.el-date-editor');
      var editorInfo = editors.map(function (e, i) {
        var inp = T.qs('input', e);
        return '[' + i + '] class="' + e.className + '" value="' + (inp && inp.value || '') + '"';
      });
      var panels = T.qsa('.el-picker-panel');
      var panelInfo = panels.map(function (p, i) {
        return '[' + i + '] class="' + p.className + '" display="' + p.style.display + '" visible=' + T.isVisible(p);
      });
      T.report('  [' + step + '] 现状: .el-date-editor×' + editors.length + ' (' + editorInfo.join('; ') + ')', 'err');
      T.report('  [' + step + '] 面板: .el-picker-panel×' + panels.length + ' (' + panelInfo.join('; ') + ')', 'err');
    } catch (e) {}
  }

  /** 默认视图准备:不设日期条件,仅点状态 tab(进页面默认自带约 2 年数据) */
  function prepareDefaultList(tabText) {
    tabText = tabText || '已完成';
    T.report('  → 默认视图:不设日期条件,点「' + tabText + '」');
    return clickStatusTab(tabText).then(function () { return T.sleep(1500); });
  }

  /** 恢复列表查询条件(每次从详情返回后必须重跑)。tabText 缺省「已完成」。每步带诊断日志。 */
  function prepareList(targetYM, tabText) {
    tabText = tabText || '已完成';
    T.report('  → 设税款所属期 ' + targetYM);
    return Promise.resolve()
      .then(function () { return DP.setStartMonth(targetYM); })
      .catch(function (e) { dumpDateContext('setStartMonth'); throw new Error('税款所属期设置失败: ' + e.message); })
      // 月份面板可能残留,务必先关闭再点申报日期框,否则点 input 时多面板共存
      .then(function () { return DP.closeOverlays(); })
      .then(function () { return T.sleep(200); })
      .then(function () { T.report('  → 设申报日期 ' + targetYM); return DP.setDeclareDateStart(targetYM); })
      .catch(function (e) { dumpDateContext('setDeclareDateStart'); throw new Error('申报日期设置失败: ' + e.message); })
      .then(function () { return DP.closeOverlays(); })
      .then(function () { T.report('  → 点「查询」'); return clickQueryButton(); })
      .then(function () { T.report('  → 点「' + tabText + '」'); return clickStatusTab(tabText); })
      .then(function () { return T.sleep(1500); });
  }

  /** 从 el-table 提取申报列表(读 thead th 作列名,tbody tr 作行,去重) */
  function extractList() {
    var raw = (function () {
      var tables = T.qsa('.el-table');
      var result = [];
      for (var ti = 0; ti < tables.length; ti++) {
        var tbl = tables[ti];
        if (!T.isVisible(tbl)) continue;
        var thEls = T.qsa('thead th', tbl);
        var ths = thEls.map(function (th) { return (th.textContent || '').trim(); }).filter(Boolean);
        if (ths.length === 0) continue;
        var trs = T.qsa('tbody tr', tbl);
        for (var ri = 0; ri < trs.length; ri++) {
          var tr = trs[ri];
          var txt = (tr.textContent || '').replace(/\s+/g, '');
          if (!txt || txt.indexOf('暂无数据') !== -1) continue;
          var tds = T.qsa('td', tr);
          var row = {};
          tds.forEach(function (td, i) { row[ths[i] || ('col' + i)] = (td.textContent || '').trim(); });
          result.push(row);
        }
      }
      return result;
    })();
    var seen = {}, clean = [];
    raw.forEach(function (r) {
      var key = (r['申报项目'] || '') + '|' + (r['税款所属期'] || '');
      if (key in seen) return;
      seen[key] = 1;
      clean.push(r);
    });
    return clean;
  }

  /** 点击某行的「查看」(精确匹配链接文字,避开「作废」)。
   *  expectRow:期望行(job.rows 里的行对象,取 申报项目/税款所属期 作文字特征)。
   *  列表顺序可能乱(如 2024/2023/2022 无序),提供时优先按文字匹配目标行;失败回退按行号。 */
  function clickView(rowIdx, expectRow) {
    var ok = (function () {
      var tables = T.qsa('.el-table');
      var dataRows = [];
      for (var i = 0; i < tables.length; i++) {
        var tbl = tables[i];
        var ths = T.qsa('thead th', tbl);
        if (ths.length === 0) continue;
        var trs = T.qsa('tbody tr', tbl);
        for (var j = 0; j < trs.length; j++) {
          var txt = (trs[j].textContent || '').replace(/\s+/g, '');
          if (!txt || txt.indexOf('暂无数据') !== -1) continue;
          dataRows.push(trs[j]);
        }
      }
      // 文字特征匹配(去空白子串):申报项目 + 税款所属期 双重命中,避免同名行错配
      var tr = null;
      var kw1 = String((expectRow && expectRow['申报项目']) || '').replace(/\s+/g, '');
      var kw2 = String((expectRow && expectRow['税款所属期']) || '').replace(/\s+/g, '');
      if (kw1) {
        tr = dataRows.filter(function (rowEl) {
          var t = (rowEl.textContent || '').replace(/\s+/g, '');
          return t.indexOf(kw1) !== -1 && (!kw2 || t.indexOf(kw2) !== -1);
        })[0] || null;
        if (!tr) T.report('  ⚠ 按文字「' + kw1 + '」未匹配到行,回退第 ' + (rowIdx + 1) + ' 行', 'err');
      }
      if (!tr) tr = dataRows[rowIdx];
      if (!tr) return { ok: false, reason: '无数据行 #' + rowIdx };
      var links = T.qsa('a', tr);
      var a = links.filter(function (x) { return (x.textContent || '').trim() === '查看'; })[0] || links[0];
      if (!a) return { ok: false, reason: '操作列无 a' };
      T.clickEl(a);
      return { ok: true };
    })();
    if (!ok.ok) throw new Error('点击「查看」失败:' + ok.reason);
    return T.sleep(4000);
  }

  T.list = {
    prepareList: prepareList,
    prepareDefaultList: prepareDefaultList,
    extractList: extractList,
    clickView: clickView
  };
})();
