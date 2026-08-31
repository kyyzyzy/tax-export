/**
 * content/detail.js —— 申报详情采集:基础信息 / 计税详情 / 工资薪金明细
 */
(function () {
  'use strict';
  var T = window.__taxExport;

  /**
   * 可信点击:datepickers.js 暴露的 CDP 点击(isTrusted=true),瑞数加固页面必需。
   * CDP 失败(用户关了调试黄条等)→ 回退 JS 合成事件序列,但**不调用 el.click()**:
   *   瑞数 tab 的 <a href="javascript:void(0)"> 一旦走 el.click()/默认行为会被 CSP 拦截,
   *   连带瑞数事件委托失效。故 JS 兜底只派发 pointer/mouse 序列(模拟真实点击,不触发导航)。
   * 返回 Promise<boolean>:是否通过 CDP 派发(用于诊断)。
   */
  function realClick(el) {
    var rc = (T.datepickers && T.datepickers.realClick) ||
      (window.__taxExport && window.__taxExport.datepickers && window.__taxExport.datepickers.realClick);
    if (rc) {
      // datepickers.realClick 在 CDP 失败时会 jsClick(el)——对 <a> 调 el.click() 触发 href。
      // 这里改用「CDP 优先 + 无导航 JS 兜底」,避免 CSP 拦截。
      var cdp = (T.datepickers && T.datepickers.cdpClick) ||
        (window.__taxExport && window.__taxExport.datepickers && window.__taxExport.datepickers.cdpClick);
      if (cdp) {
        return cdp(el).then(function (ok) {
          if (ok) return true;
          jsClickNoNav(el);  // CDP 失败:无导航 JS 兜底
          return false;
        });
      }
      return rc(el).then(function () { return true; });
    }
    // 兜底:datepickers 未就绪
    try { T.clickEl(el); } catch (e) {}
    return Promise.resolve(false);
  }

  /** 无导航 JS 点击:派发 pointer+mouse 完整序列(坐标在元素中心),不调 el.click()(避免 href 触发 CSP) */
  function jsClickNoNav(el) {
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
  }

  /** 当前激活的 tab 名称(读 li.its-tab.active 的文字) */
  function activeTabName() {
    var li = T.qsa('li.its-tab.active, .its-tab-title li.active')[0];
    return li ? (li.textContent || '').trim() : '';
  }

  /**
   * 点击自定义 tab:li.its-tab 文字匹配。
   * 瑞数加固页面下,tab 的 <a href="javascript:void(0)" onclick="null" datas-ts="...">
   *   - 合成 JS 点击(isTrusted=false)被全局监听忽略
   *   - 直接触发 href(默认行为/el.click())会被 CSP 拦截,连带瑞数事件委托失效
   * 故 CDP 可信点击优先,JS 兜底只派发事件不触发导航。
   * 点击后等待该 tab 进入 active(瑞数异步切换,最多 ~5s)确认生效。
   * 返回 Promise<boolean>。
   */
  function clickItsTab(name) {
    var li = T.qsa('li.its-tab, .its-tab-title li').filter(function (el) {
      return (el.textContent || '').indexOf(name) !== -1;
    })[0];
    if (!li) return Promise.resolve(false);
    // 已是 active:无需点击(避免重复点击触发瑞数异常分支)
    if (li.classList.contains('active')) return Promise.resolve(true);
    var a = T.qs('a', li) || li;
    var before = activeTabName();
    return realClick(a)
      .then(function (viaCdp) {
        // 等待 active 切到目标 tab,最多 ~5s
        return T.waitFor(function () { return li.classList.contains('active'); }, 5000)
          .then(function () { return true; })
          .catch(function () {
            // CDP 没生效:再点 li 本身(有些瑞数版事件委托在 li 上)
            return realClick(li).then(function () {
              return T.waitFor(function () { return li.classList.contains('active'); }, 3000)
                .then(function () { return true; })
                .catch(function () {
                  T.report('    [tab] 点击「' + name + '」未生效(active=' + activeTabName() + ',CDP=' + viaCdp + ')', 'err');
                  return false;
                });
            });
          });
      });
  }

  /** 点面包屑(.its-breadcrumb a 文字含 kw)。瑞数加固页需可信点击。返回 Promise<boolean> */
  function clickBreadcrumb(kw) {
    var hit = T.qsa('.its-breadcrumb a, .breadcrumb a').filter(function (a) {
      return (a.textContent || '').indexOf(kw) !== -1;
    })[0];
    if (!hit) return Promise.resolve(false);
    return realClick(hit).then(function () { return true; });
  }

  /**
   * 基础信息 tab:按 .panel-title 分段,.bisection-* 行内 .title + 同级 span 配对。
   * skipPersonal=true 时,只抓「汇算地信息」段(机关/单位),跳过重复的纳税人基本信息
   *   (姓名/身份证/手机等——第一条详情已抓全,后续年度无需重复)。
   */
  function captureBasicInfo(skipPersonal) {
    var root = T.qs('.J_BaseInfoContent') || T.qs('.details-panel') || document.body;
    var out = { kv: {}, sections: {} };
    // 跳过纳税人基本信息段(首条已抓全;后续年度这些字段不变)
    var skipSections = skipPersonal ? ['纳税人基本信息'] : [];
    var titles = T.qsa('.panel-title', root);
    for (var i = 0; i < titles.length; i++) {
      var tEl = titles[i];
      var title = (tEl.textContent || '').trim();
      if (skipSections.indexOf(title) !== -1) continue;
      var pc = null, sib = tEl.nextElementSibling, guard = 0;
      while (sib && guard < 6) {
        if (sib.classList && sib.classList.contains('panel-content')) { pc = sib; break; }
        sib = sib.nextElementSibling; guard++;
      }
      if (!pc) continue;
      var seg = {};
      var rows = T.qsa('[class*="bisection"]', pc);
      for (var k = 0; k < rows.length; k++) {
        var row = rows[k];
        var t = T.qs('.title, [class*="title"]', row);
        if (!t) continue;
        var key = (t.textContent || '').trim();
        if (!key) continue;
        var vSpan = t.nextElementSibling;
        var val = '';
        if (vSpan && vSpan.tagName === 'SPAN') val = (vSpan.textContent || '').trim();
        else {
          // 值未包 span(直接是文本节点):取整行文本,删 key,再去掉冒号与首尾空白
          val = (row.textContent || '').replace(key, '').replace(/^[：:\s]+/, '').trim();
        }
        if (val) { seg[key] = val; out.kv[key] = val; }
      }
      if (Object.keys(seg).length) out.sections[title] = seg;
    }
    if (Object.keys(out.kv).length === 0) {
      T.qsa('[class*="bisection"]').forEach(function (row) {
        var t = T.qs('.title, [class*="title"]', row);
        if (!t) return;
        var key = (t.textContent || '').trim();
        if (!key) return;
        var vSpan = t.nextElementSibling;
        var val = vSpan && vSpan.tagName === 'SPAN' ? (vSpan.textContent || '').trim()
          : (row.textContent || '').replace(key, '').replace(/^[：:\s]+/, '').trim();
        if (val) out.kv[key] = val;
      });
    }
    if (Object.keys(out.kv).length === 0) {
      (T.qs('body').innerText || '').split('\n').forEach(function (line) {
        var m = line.match(/^(.{2,20})[：:]\s*(.+)$/);
        if (m) out.kv[m[1].trim()] = m[2].trim();
      });
    }
    // 日志:基础信息采集结果(字段数 + 关键字段预览)
    var keys = Object.keys(out.kv);
    if (keys.length) {
      var preview = keys.slice(0, 6).map(function (k) { return k + '=' + out.kv[k]; }).join(' / ');
      T.report('    基础信息 ✓ ' + keys.length + ' 字段' + (skipPersonal ? '(仅汇算地)' : '(' + preview + (keys.length > 6 ? '…' : '') + ')'), 'ok');
    } else {
      T.report('    基础信息 ✗ 未抓到任何字段(.details-panel 内无 .bisection-2)', 'err');
    }
    return out;
  }

  /**
   * 计税详情 tab:收入表(its-table 归一化)+ 汇总(tax-explain-list 6 项)
   *   + 逐项金额(从收入表行按分类归组,生成 _flat 扁平视图)。
   *
   * 逐项金额(基本养老保险/住房公积金/子女教育/年金/个人养老金 等)就在 its-table 行里,
   * 每张表 thead 首列即分类(收入/费用/专项扣除/专项附加扣除/其他扣除/准予扣除的捐赠)。
   */
  function captureTaxDetail() {
    var cleanNode = function (el) {
      var clone = el.cloneNode(true);
      T.qsa('.table-tag, .field-desc-icon', clone).forEach(function (e) { e.remove(); });
      return (clone.textContent || '').replace(/\s+/g, '').trim();
    };
    var incomeRows = [];
    T.qsa('.its-table').forEach(function (tbl) {
      if (!T.isVisible(tbl)) return;
      var thEls = T.qsa('thead th', tbl);
      if (thEls.length === 0) return;
      var category = cleanNode(thEls[0]);
      T.qsa('tbody tr', tbl).forEach(function (tr) {
        var txt = (tr.textContent || '').replace(/\s+/g, '');
        if (!txt) return;
        var tds = T.qsa('td', tr);
        if (tds.length === 0) return;
        var row = { '分类': category };
        row['项目'] = cleanNode(tds[0]);
        if (tds.length >= 2) row['金额(元)'] = cleanNode(tds[1]);
        if (tds.length >= 3) {
          var op = cleanNode(tds[tds.length - 1]);
          if (op) row['操作'] = op;
        }
        incomeRows.push(row);
      });
    });
    var summary = {};
    T.qsa('.tax-explain-list').forEach(function (list) {
      var titleEl = T.qs('.list-title', list);
      var moneyEl = T.qs('.list-content-money .value', list);
      var unitEl = T.qs('.list-content-money .unit', list);
      if (!titleEl || !moneyEl) return;
      // 清掉标题里的 error-tag/提示文字(如「存在待确认项,请先进行操作确认」)
      var title = cleanNode(titleEl);
      var money = (moneyEl.textContent || '').trim();
      var unit = unitEl ? (unitEl.textContent || '').trim() : '';
      if (title && money) summary[title] = money + unit;
    });
    var detailItems = groupDetailItems(incomeRows);
    // 日志:计税详情采集结果(收入表行数 / 汇总项 / 关键汇总值)
    var sumKeys = Object.keys(summary);
    if (incomeRows.length || sumKeys.length) {
      var sumPreview = ['收入', '应纳税额', '应补退税', '已缴税额'].map(function (k) {
        return summary[k] ? k + '=' + summary[k] : null;
      }).filter(Boolean).join(' / ');
      T.report('    计税详情 ✓ 收入表 ' + incomeRows.length + ' 行 / 汇总 ' + sumKeys.length + ' 项' +
        (sumPreview ? '(' + sumPreview + ')' : ''), 'ok');
    } else {
      T.report('    计税详情 ✗ 未抓到收入表/汇总(its-table 无数据行或 tax-explain-list 为空)', 'err');
    }
    return {
      incomeRows: incomeRows,
      summary: summary,
      detailItems: detailItems
    };
  }

  /**
   * 把已抓的收入表行(incomeRows)按「分类」归组,生成收入明细视图。
   *
   * incomeRows 每行:{ 分类, 项目, 金额(元), 操作? }。
   *   分类来自 thead 首列(收入/费用/免税收入/减除费用/专项扣除/专项附加扣除/其他扣除/准予扣除的捐赠)。
   * 返回 { 按分类: { 项目名: 金额 } }。
   * 跳过「项目」与「分类」同名的大类汇总行(如「费用」行项目也叫「费用」)。
   * v2:去掉 _flat 扁平视图(冗余,transformPayload 已按分类归组使用)。
   */
  function groupDetailItems(incomeRows) {
    var result = {};
    (incomeRows || []).forEach(function (r) {
      var cat = r['分类'] || '(未分组)';
      var name = r['项目'] || '';
      var val = r['金额(元)'] || '0.00';
      if (!name) return;
      // 跳过大类汇总行(项目名与分类名相同,如「费用」「减除费用」)
      if (name === cat) return;
      if (!result[cat]) result[cat] = {};
      result[cat][name] = val;
    });
    // 日志:收入明细采集结果(项数)
    var allNames = [];
    Object.keys(result).forEach(function (cat) { allNames = allNames.concat(Object.keys(result[cat])); });
    if (allNames.length) {
      T.report('    收入明细 ✓ ' + allNames.length + ' 项', 'ok');
    } else {
      T.report('    收入明细 ✗ 未抓到(收入表为空)', 'err');
    }
    return result;
  }

  /**
   * 抓工资薪金收入明细(逐月)当前页 + 翻页直到尾页。
   *
   * 该页是 SPA 内 tab 切换(.income-gzxj-tab),表格在 .J_declaration_table_0 里。
   * 关键容错:
   *   - 每页都重新查询 table/pager(Vue 翻页可能重渲染 DOM,旧引用失效)
   *   - 翻页点击优先点数字页码 <a>(有文字、瑞数监听在这);再试 next 箭头
   *   - 翻页生效判断:active 页码变化 OR 首行内容变化(Vue 重渲染后 active class 可能滞后)
   *   - 点击用 realClick(CDP 可信点击 + JS 兜底)
   */
  function collectPages() {
    var all = [];

    /** 每次调用都重新查询:可见且有数据行的 its-table(优先 .J_declaration_table_0 内的) */
    function findTable() {
      var tbls = T.qsa('table.its-table, .its-table table').filter(function (t) {
        if (!T.isVisible(t)) return false;
        var p = t.parentElement, ok = true;
        for (var i = 0; i < 6 && p; i++) {
          if (getComputedStyle(p).display === 'none') { ok = false; break; }
          p = p.parentElement;
        }
        return ok && T.qsa('tbody tr td', t).length > 0;
      });
      if (!tbls.length) return null;
      // 优先在 .J_declaration_table_0 / .income-gzxj-tab 内
      var inDecl = tbls.filter(function (t) { return t.closest('.J_declaration_table_0, .income-gzxj-tab, .declaration-tab-table'); });
      return (inDecl[0] || tbls[0]);
    }

    /** 尝试翻到下一页(对齐 tax-tool 方案:页面上下文内原生 el.click(),不用 CDP)。
     *  tax-tool 实测:翻页 <a class="pagination-item-link"> 的 click() 不校验 isTrusted,
     *  瑞数事件委托会捕获并 preventDefault,不触发 href 导航 → 无 CSP 拦截。
     *  点 next 箭头的 <a>(瑞数翻页监听在此),再点 <li> 兜底。
     *  返回 Promise<boolean>:表格首行内容是否变化。 */
    function gotoNextPage(firstKey) {
      function contentChanged() {
        var t2 = findTable();
        if (!t2) return false;
        var tr0 = T.qsa('tbody tr', t2)[0];
        if (!tr0) return false;
        var c0 = (T.qsa('td', tr0)[0] || {}).textContent || '';
        return c0.replace(/\s+/g, '') !== firstKey;
      }

      /** 在页面上下文点击 next(原生 el.click(),对齐 tax-tool) */
      function clickNextNative() {
        var pagers = T.qsa('.its-table-pagination').filter(function (pg) {
          if (!T.isVisible(pg)) return false;
          return T.qsa('li.pagination-item.pagination-next', pg)
            .some(function (li) { return !li.classList.contains('pagination-disabled'); });
        });
        if (!pagers.length) return null;
        var pager = pagers[0];
        var nextLi = T.qsa('li.pagination-item.pagination-next', pager)
          .filter(function (li) { return !li.classList.contains('pagination-disabled'); })[0];
        if (!nextLi) return null;
        // 对齐 tax-tool:优先点 a.pagination-item-link,再点 li
        var link = T.qs('a.pagination-item-link', nextLi) || T.qs('a', nextLi);
        try {
          if (link) link.click(); else nextLi.click();
        } catch (e) { return null; }
        return link ? 'a' : 'li';
      }

      // 策略1:原生 click next 箭头(对齐 tax-tool,实测有效)
      var hit = clickNextNative();
      if (!hit) return Promise.resolve(false);
      return T.waitFor(function () { return contentChanged(); }, 4000)
        .then(function () {
          T.report('    翻页成功(next ' + hit + '.click)', 'ok');
          return true;
        })
        .catch(function () {
          // 策略2:原生 click 数字页码(部分版本瑞数监听在数字页码上)
          var numHit = (function () {
            var pagers = T.qsa('.its-table-pagination').filter(T.isVisible);
            for (var i = 0; i < pagers.length; i++) {
              var pg = pagers[i];
              var nextLi2 = T.qsa('li.pagination-item.pagination-next', pg)
                .filter(function (li) { return !li.classList.contains('pagination-disabled'); })[0];
              if (!nextLi2) continue;
              var ndp = nextLi2.getAttribute('data-page') || '';
              var numLi = T.qsa('li.pagination-item', pg).filter(function (li) {
                return li.getAttribute('data-page') === ndp &&
                  !li.classList.contains('pagination-item-active') &&
                  !li.classList.contains('pagination-next') && !li.classList.contains('pagination-prev');
              })[0];
              if (numLi) {
                var a = T.qs('a', numLi);
                try { if (a) a.click(); else numLi.click(); } catch (e) { continue; }
                return a ? 'numA' : 'numLi';
              }
            }
            return null;
          })();
          if (!numHit) return false;
          return T.waitFor(function () { return contentChanged(); }, 3500)
            .then(function () { T.report('    翻页成功(数字页码 ' + numHit + '.click)', 'ok'); return true; })
            .catch(function () { return false; });
        });
    }

    function grabPage(page) {
      if (page > T.MAX_PAGES) { T.report('  ⚠ 翻页超过 ' + T.MAX_PAGES + ' 页,停止', 'err'); return Promise.resolve(false); }
      var tbl = findTable();
      var grabbed = 0;
      var firstKey = '';  // 首行特征(用于判断翻页后内容是否变化)
      if (tbl) {
        var ths = T.qsa('thead th', tbl).map(function (th) { return (th.textContent || '').trim(); });
        T.qsa('tbody tr', tbl).forEach(function (tr, ri) {
          var tds = T.qsa('td', tr);
          var txt = (tr.textContent || '').replace(/\s+/g, '');
          if (!txt || txt.indexOf('暂无数据') !== -1 || txt.indexOf('无数据') !== -1) return;
          var row = {};
          tds.forEach(function (td, i) { row[ths[i] || ('col' + i)] = (td.textContent || '').trim(); });
          if (ri === 0) firstKey = row[ths[0]] || txt.slice(0, 20);  // 首行第一列作为特征
          all.push(row);
          grabbed++;
        });
      }
      if (page === 1) {
        T.report('    工资薪金明细 · 第 1 页 ' + (tbl ? grabbed + ' 行' : '未找到表格') + (grabbed ? '(累计 ' + all.length + ')' : ''), grabbed ? 'ok' : 'err');
      } else {
        T.report('    工资薪金明细 · 第 ' + page + ' 页 ' + grabbed + ' 行(累计 ' + all.length + ')', 'ok');
      }
      if (!tbl || !grabbed) return Promise.resolve(false);

      // 找下一页候选;无候选 → 已到尾页
      var cands = T.qsa('.its-table-pagination').filter(T.isVisible);
      var hasNext = cands.some(function (pg) {
        return T.qsa('li.pagination-item.pagination-next', pg)
          .some(function (li) { return !li.classList.contains('pagination-disabled'); });
      });
      if (!hasNext) { if (page === 1) T.report('    无下一页(仅 ' + page + ' 页)'); return Promise.resolve(false); }

      return gotoNextPage(firstKey)
        .then(function (ok) {
          if (!ok) {
            T.report('    翻页未生效(已尝试所有点击目标),停止翻页', 'err');
            return false;
          }
          return T.sleep(1200).then(function () { return true; });
        })
        .then(function (cont) { return cont ? grabPage(page + 1) : false; });
    }
    return Promise.resolve(grabPage(1)).then(function () {
      if (all.length) T.report('    工资薪金明细 ✓ 共 ' + all.length + ' 行', 'ok');
      else T.report('    工资薪金明细 ✗ 未抓到数据', 'err');
      return all;
    });
  }

  /** 点工资薪金「详情」(J_TaxView[data-table=income])→ 翻页抓收入明细 → 返回计税详情。
   *  详情按钮/翻页/面包屑均用可信点击(realClick),绕过瑞数 isTrusted 校验与 CSP 拦截。
   *  整体容错:任一步失败都不 reject,返回已抓到的行(可能为空数组),不阻塞详情返回。 */
  function captureIncomeDetailPaged() {
    // 入口判定:按钮须有文字(如「详情」)。真机无明细的年份会渲染空的 div.J_TaxView(无文字),
    // 点它是死按钮 → 识别为"无详情入口",该年总收入明细直接跳过(不等待超时)。
    function hasText(el) { return !!el && ((el.textContent || '').replace(/\s+/g, '') !== ''); }
    var btn = T.qs(".J_TaxView[data-table='income']") ||
      (function () {
        var hit = null;
        T.qsa('.its-table tr').forEach(function (tr) {
          if ((tr.textContent || '').indexOf('工资薪金') !== -1) {
            var b = T.qs('.J_TaxView', tr);
            if (hasText(b)) hit = b;
          }
        });
        return hit;
      })();
    if (btn && !hasText(btn)) btn = null;  // 主选择器命中的也可能是空按钮
    if (!btn) { T.report('    该年份无总收入明细「详情」入口(跳过)'); return Promise.resolve({ 工资薪金: [], 单独计税奖金金额: '', 收入总额: '' }); }
    var result = { 工资薪金: [], 单独计税奖金金额: '', 收入总额: '' };
    return realClick(btn)
      .then(function () {
        // 等收入明细 tab 面板渲染(.income-gzxj-tab 或 .J_declaration_table_0 出现数据行)
        return T.waitFor(function () {
          var panel = T.qs('.income-gzxj-tab, .J_declaration_table_0');
          if (!panel) return false;
          return T.qsa('table.its-table tbody tr td', panel).length > 0;
        }, 12000).catch(function () { return null; });
      })
      .then(function () { return T.sleep(1500); })
      // 读「总收入明细」页头两金额:先等页头元素渲染(最多 4s),收入总额 + 单独计税奖金
      .then(function () {
        return T.waitFor(function () {
          return T.qsa('.ndhsqj-tab-money-content-left .money-number, .qnycxjj-money .money-number')
            .some(function (el) { return T.isVisible(el); });
        }, 4000).catch(function () { return null; });
      })
      .then(function () {
        var ov = readIncomeOverview();
        result.收入总额 = ov['收入总额'];
        result.单独计税奖金金额 = ov['单独计税奖金'];
        if (ov['收入总额'] || ov['单独计税奖金']) {
          T.report('    总收入明细页头:收入总额 ' + (ov['收入总额'] || '未读到') +
            ' + 单独计税奖金 ' + (ov['单独计税奖金'] || '0') + ' 元', 'ok');
        } else {
          T.report('    总收入明细页头未读到(渲染慢,抓完明细再补读)', 'err');
        }
      })
      // 抓工资薪金明细(②并入综合时,其中的「全年一次性奖金」行即奖金明细,由导出端派生)
      .then(function () { return collectPages(); })
      .then(function (allRows) { result.工资薪金 = allRows || []; })
      // 页头首读为空时补读一次(渲染时序兜底)
      .then(function () {
        if (!result.收入总额 && !result.单独计税奖金金额) {
          var ov2 = readIncomeOverview();
          result.收入总额 = ov2['收入总额'];
          result.单独计税奖金金额 = ov2['单独计税奖金'];
          if (ov2['收入总额'] || ov2['单独计税奖金']) {
            T.report('    总收入明细页头(补读):收入总额 ' + (ov2['收入总额'] || '未读到') +
              ' + 单独计税奖金 ' + (ov2['单独计税奖金'] || '0') + ' 元', 'ok');
          }
        }
      })
      .catch(function (e) { T.report('    工资薪金明细采集异常:' + (e && e.message || e), 'err'); })
      // 返回:无论翻页是否成功,都尝试回到计税详情 tab(失败不阻塞)
      .then(function () {
        // 优先:点内部「返回」/关闭收入明细 tab 的按钮(若有)
        var backBtn = T.qsa('.J_IdPrev, .J_ReturnToComprehensiveIncome, .btn-back, .J_CloseIncomeDetail').filter(T.isVisible)[0];
        if (backBtn) return realClick(backBtn).then(function () { return T.sleep(2000); });
        // 兜底:面包屑
        return clickBreadcrumb('综合所得年度汇算')
          .then(function (ok) {
            if (ok) return T.sleep(2500);
            try { history.back(); } catch (e) {}
            return T.sleep(2500);
          })
          .catch(function () {});
      })
      .then(function () { return result; });
  }

  /**
   * 抓「退税记录」tab:切 tab → 读列表 → 按状态规则求两项合计(见 extractRefundSum)。
   * 该 tab 只在综合所得年度汇算详情页存在;找不到 tab 时返回 null(不阻塞)。
   * 返回 Promise<{汇算已退税额1, 已预缴税额, 退税记录行数, 计入行数, 已预缴计入行数}|null>。
   */
  function captureRefundRecords() {
    return waitTab('退税记录')
      .then(function (hasTab) {
        if (!hasTab) { T.report('    无「退税记录」tab(跳过)'); return null; }
        return clickItsTab('退税记录')
          .then(function (ok) {
            if (!ok) { T.report('    「退税记录」tab 切换失败', 'err'); return null; }
            return T.waitFor(function () {
              return T.qsa('.its-table').some(function (t) {
                return T.isVisible(t) && T.qsa('tbody tr', t).length > 0;
              });
            }, 8000).catch(function () { return null; })  // 无数据/渲染慢也继续,按 0 行处理
              .then(function () { return T.sleep(1500); })
              .then(function () { return extractRefundSum(); });
          });
      });
  }

  /** 读「总收入明细」页头(declaration-tab-overview)的两个金额:
   *  收入总额(.ndhsqj-tab-money-content-left .money-number,如 298254.85)
   *  与 单独计税奖金(.qnycxjj-money .money-number,如 1330.94)。
   *  返回 {收入总额:'', 单独计税奖金:''}(去元/逗号/空白,非数字为空)。 */
  function readIncomeOverview() {
    function num(sel) {
      var el = T.qsa(sel).filter(T.isVisible)[0];
      if (!el) return '';
      var v = (el.textContent || '').trim().replace(/[,\s元]/g, '');
      return /^\d+(\.\d+)?$/.test(v) ? v : '';
    }
    return {
      '收入总额': num('.ndhsqj-tab-money-content-left .money-number'),
      '单独计税奖金': num('.qnycxjj-money .money-number')
    };
  }

  /** 读「单独计税奖金」页头金额(如 11278.41;与「收入总额」并排展示)。 */
  function readSeparateBonusAmount() {
    return readIncomeOverview()['单独计税奖金'];
  }

  /** 读可见 its-table 的退税记录,按状态规则求两个合计:
   *  汇算已退税额1:仅统计 当前状态∈{国库处理完成, 国库处理中} 的行,取「退税金额」列
   *    (税务审核不通过/税务审核中/已撤销退税申请等一律不计)。
   *  已预缴税额:仅统计 当前状态∈{国库处理完成, 税务审核中};
   *    优先取「已预缴税额」列,页面无该列时用「退税金额」列。 */
  function extractRefundSum() {
    var rows = [];
    T.qsa('.its-table').forEach(function (tbl) {
      if (!T.isVisible(tbl)) return;
      var thEls = T.qsa('thead th', tbl);
      if (!thEls.length) return;
      var ths = thEls.map(function (th) { return (th.textContent || '').replace(/\s+/g, '').trim(); });
      T.qsa('tbody tr', tbl).forEach(function (tr) {
        var txt = (tr.textContent || '').replace(/\s+/g, '');
        if (!txt || txt.indexOf('暂无数据') !== -1 || txt.indexOf('无数据') !== -1) return;
        var row = {};
        T.qsa('td', tr).forEach(function (td, i) { row[ths[i] || ('col' + i)] = (td.textContent || '').trim(); });
        rows.push(row);
      });
    });
    /** 按关键词模糊取列值(列名可能是全角「退税金额（元）」等变体) */
    function col(row, kw) {
      var keys = Object.keys(row);
      for (var i = 0; i < keys.length; i++) { if (keys[i].indexOf(kw) !== -1) return row[keys[i]]; }
      return '';
    }
    function status(r) { return String(col(r, '当前状态') || col(r, '状态') || ''); }
    function num(v) { return parseFloat(String(v).replace(/[,\s元]/g, '')); }

    // 汇算已退税额1:仅统计 国库处理完成 / 国库处理中(其余状态一律不计)
    var sum1 = 0, used1 = 0;
    rows.forEach(function (r) {
      var s1 = status(r);
      if (s1.indexOf('国库处理完成') === -1 && s1.indexOf('国库处理中') === -1) return;
      var v = num(col(r, '退税金额'));
      if (!isNaN(v)) { sum1 += v; used1++; }
    });
    // 已预缴税额:仅 国库处理完成 / 税务审核中(已撤销退税申请、国库处理中等不计)
    var hasPreCol = rows.some(function (r) { return !!col(r, '已预缴税额'); });
    var preKw = hasPreCol ? '已预缴税额' : '退税金额';
    var sum2 = 0, used2 = 0;
    rows.forEach(function (r) {
      var s = status(r);
      if (s.indexOf('国库处理完成') === -1 && s.indexOf('税务审核中') === -1) return;
      var v = num(col(r, preKw));
      if (!isNaN(v)) { sum2 += v; used2++; }
    });
    var out = {
      '汇算已退税额1': (Math.round(sum1 * 100) / 100).toFixed(2),
      '已预缴税额': (Math.round(sum2 * 100) / 100).toFixed(2),
      '退税记录行数': rows.length,
      '计入行数': used1,
      '已预缴计入行数': used2
    };
    T.report('    退税记录 ✓ ' + rows.length + ' 行:已退税额1=' + out['汇算已退税额1'] +
      '(计入' + used1 + ')/已预缴税额=' + out['已预缴税额'] + '(计入' + used2 + ')', 'ok');
    return out;
  }

  /**
   * 从「总收入明细」子页返回年度汇算详情页。
   * 注意:captureSalaryDetail(工资薪金详情)收尾通常已点面包屑回到年度汇算页 —— 先确认,
   * 已在则不再点(年度汇算页上可能存在同名链接,误点会退出当前年度/丢专项附加扣除)。
   * 仍留在总收入明细子页时,点面包屑「综合所得年度汇算（标准申报）」
   * (真机 DOM:.its-breadcrumb 内 a.J_ExitAdditionalTable.step2)。
   * 返回 Promise<boolean>(false=无法返回,不阻塞)。
   */
  function onSalarySubPage() {
    var g = T.qs('.income-gzxj-tab');
    if (g && T.isVisible(g)) return true;
    return T.qsa('.its-breadcrumb li, .el-breadcrumb__item').some(function (li) {
      return (li.textContent || '').indexOf('总收入明细') !== -1 && T.isVisible(li);
    });
  }

  /** 是否在「专项附加扣除明细」标签视图内(点表单「详情」会整页刷新并停在此视图,赡养老人默认激活):
   *  特征 = 可见明细表(表头含 被赡养人姓名/子女姓名) 或 激活的扣除标签(子女教育/赡养老人等) */
  function inDeductDetailView() {
    var detailTable = T.qsa('.its-table thead').some(function (hd) {
      var t = (hd.textContent || '').replace(/\s+/g, '');
      return (t.indexOf('被赡养人姓名') !== -1 || t.indexOf('子女姓名') !== -1) && T.isVisible(hd);
    });
    if (detailTable) return true;
    return T.qsa('li.its-tab').some(function (li) {
      var t = (li.textContent || '').replace(/\s+/g, '');
      return li.classList && li.classList.contains('active') && T.isVisible(li) &&
        (t.indexOf('赡养老人') !== -1 || t.indexOf('子女教育') !== -1 || t.indexOf('继续教育') !== -1 ||
          t.indexOf('大病医疗') !== -1 || t.indexOf('3岁以下婴幼儿照护') !== -1 || t.indexOf('住房') !== -1);
    });
  }

  function onAnnualSettlePage() {
    if (onSalarySubPage()) return false;
    // 专项附加扣除明细视图属于年度汇算详情页的一部分:在其中也算"在年度汇算页"
    if (inDeductDetailView()) return true;
    return T.qsa('li.its-tab').some(function (li) {
      var t = (li.textContent || '').replace(/\s+/g, '');
      return (t.indexOf('计税详情') !== -1 || t.indexOf('基础信息') !== -1) && T.isVisible(li);
    });
  }

  function returnToAnnualSettle() {
    // 已在年度汇算页(工资薪金详情收尾已点过面包屑):直接成功,不再点击
    return T.waitFor(onAnnualSettlePage, 3000)
      .then(function () { return true; })
      .catch(function () {
        var link = T.qsa('.its-breadcrumb a, .breadcrumb a, .declare-breadcrumb-wrap a').filter(function (a) {
          return (a.textContent || '').replace(/\s+/g, '').indexOf('综合所得年度汇算') !== -1 && T.isVisible(a);
        })[0];
        if (!link) { T.report('    面包屑「综合所得年度汇算」未找到(专项附加扣除明细跳过)', 'err'); return false; }
        try { if (link.scrollIntoView) link.scrollIntoView({ block: 'center' }); } catch (e) {}
        return T.sleep(300)
          .then(function () { return realClick(link); })
          .then(function () { return T.waitFor(onAnnualSettlePage, 12000); })
          .then(function () { return T.sleep(1000).then(function () { return true; }); })
          .catch(function () {
            T.report('    返回年度汇算页超时(专项附加扣除明细跳过)', 'err');
            return false;
          });
      });
  }

  /**
   * 阶段:专项附加扣除明细 —— 年度汇算详情页「计税详情」tab 的「专项附加扣除」表单
   * → 点目标项目行(金额>0)的「详情」(div.its-btn.J_TaxView)进入标签页视图
   * (ul.its-tab-title.tab-border-card:子女教育/继续教育/大病医疗/住房贷款利息或租金/赡养老人/3岁以下婴幼儿照护,
   * 真机 DOM 2026-08),逐个切换采集 赡养老人/子女教育/继续教育/3岁以下婴幼儿照护 四个标签的表格。
   * 调用时机(真机校准):工资薪金详情(总收入明细页)采集完成后,经 returnToAnnualSettle 回到本页。
   * 表单行金额全 0 或无目标行 → 返回 null(不阻塞)。
   * 返回 Promise<{赡养老人:[行], 子女教育:[行], 继续教育:[行], 3岁以下婴幼儿照护:[行]}|null>。
   */
  var DEDUCT_TABS = ['赡养老人', '子女教育', '继续教育', '3岁以下婴幼儿照护'];

  function captureDeductionTabs() {
    function findFormRow(name) {
      return T.qsa('.its-table tbody tr').filter(function (tr) {
        if (!T.isVisible(tr)) return false;
        var first = T.qsa('td', tr)[0];
        return ((first && first.textContent) || '').replace(/\s+/g, '') === name;
      })[0] || null;
    }
    function rowAmount(tr) {
      var v = parseFloat((((T.qsa('td', tr)[1] || {}).textContent) || '').replace(/[,\s元]/g, ''));
      return isNaN(v) ? 0 : v;
    }
    function detailBtn(tr) {
      return T.qsa('.its-btn', tr).filter(function (b) {
        return (b.textContent || '').indexOf('详情') !== -1;
      })[0] || T.qsa('div, a', tr).filter(function (b) {
        return ((b.textContent || '').replace(/\s+/g, '')) === '详情';
      })[0] || null;
    }
    /** 读当前标签页的表格(可见 its-table;跳过「专项附加扣除」表单自身——其表头含 专项附加扣除/操作) */
    function readTabTable() {
      var rows = [];
      T.qsa('.its-table').forEach(function (tbl) {
        if (!T.isVisible(tbl)) return;
        var thEls = T.qsa('thead th', tbl);
        if (!thEls.length) return;
        var ths = thEls.map(function (th) { return (th.textContent || '').replace(/\s+/g, '').trim(); });
        if (ths.join('|').indexOf('专项附加扣除') !== -1) return;  // 表单列表,非明细
        T.qsa('tbody tr', tbl).forEach(function (tr2) {
          var txt = (tr2.textContent || '').replace(/\s+/g, '');
          if (!txt || txt.indexOf('暂无数据') !== -1 || txt.indexOf('无数据') !== -1) return;
          var row = {};
          T.qsa('td', tr2).forEach(function (td, i) { row[ths[i] || ('col' + i)] = (td.textContent || '').trim(); });
          rows.push(row);
        });
      });
      return rows;
    }

    /** 逐个切换标签读表(公共:入口与刷新续采共用) */
    function readAllTabs() {
      var out = {};
      function seq(i) {
        if (i >= DEDUCT_TABS.length) return Promise.resolve(null);
        var name = DEDUCT_TABS[i];
        return clickItsTab(name).then(function (ok) {
          if (!ok) { T.report('    「' + name + '」tab 未找到(跳过)', 'err'); return null; }
          return T.sleep(1000).then(function () { return readTabTable(); });
        }).then(function (rows) {
          if (rows && rows.length) out[name] = rows;
          return seq(i + 1);
        }).catch(function () { return seq(i + 1); });
      }
      return seq(0).then(function () {
        var total = Object.keys(out).reduce(function (a, k) { return a + out[k].length; }, 0);
        if (total) {
          T.report('    专项附加扣除明细 ✓ ' + total + ' 行(' +
            Object.keys(out).map(function (k) { return k + ' ' + out[k].length; }).join('/') + ')', 'ok');
        } else {
          T.report('    专项附加扣除明细无数据', 'err');
        }
        return Object.keys(out).length ? out : null;
      });
    }

    // 已在明细视图(点表单「详情」会整页刷新并停在此视图):刷新续采直接读各标签,不退出重进
    if (inDeductDetailView()) {
      T.report('    已在专项附加扣除明细视图(刷新续采),直接读各标签');
      return T.sleep(800).then(function () { return readAllTabs(); })
        .catch(function (e) {
          T.report('    专项附加扣除明细采集失败:' + (e && e.message || e), 'err');
          return null;
        });
    }

    // 入口:专项附加扣除表单在「计税详情」tab → 点目标行「详情」进入标签视图。
    // 注意:该点击可能整页刷新(链路中断,续采由上方 inDeductDetailView 分支接管);未刷新则原地读各标签
    return clickItsTab('计税详情')
      .then(function () { return T.sleep(800); })
      .then(function () {
        return T.waitFor(function () {
          return DEDUCT_TABS.map(findFormRow).filter(Boolean)[0] || null;
        }, 8000).catch(function () { return null; });
      })
      .then(function (firstRow) {
        if (!firstRow) { T.report('    专项附加扣除表单无目标项目行(跳过)'); return null; }
        // 打开明细视图:任一「详情」都进入同一标签视图,优先选 金额>0 的目标行
        var opener = null;
        DEDUCT_TABS.forEach(function (n) {
          if (opener) return;
          var r = findFormRow(n);
          if (r && rowAmount(r) > 0) opener = r;
        });
        if (!opener) { T.report('    专项附加扣除目标项目金额均为 0(跳过)'); return null; }
        var btn = detailBtn(opener);
        if (!btn) { T.report('    「详情」按钮未找到(跳过)', 'err'); return null; }
        try { if (btn.scrollIntoView) btn.scrollIntoView({ block: 'center' }); } catch (e) {}
        return T.sleep(300)
          .then(function () { return realClick(btn); })
          .then(function () {
            // 等标签视图出现(its-tab 标签栏,含 赡养老人/子女教育);若点击触发整页刷新,此等待静默失败,由续采接管
            return T.waitFor(function () {
              return T.qsa('li.its-tab').some(function (li) {
                var t = (li.textContent || '').replace(/\s+/g, '');
                return (t.indexOf('赡养老人') !== -1 || t.indexOf('子女教育') !== -1) && T.isVisible(li);
              });
            }, 12000);
          })
          .then(function () { return true; })
          .catch(function () { return false; });
      })
      .then(function (entered) {
        if (!entered) return null;
        return T.sleep(1000).then(function () { return readAllTabs(); });
      })
      .catch(function (e) {
        T.report('    专项附加扣除明细采集失败:' + (e && e.message || e), 'err');
        return null;
      });
  }

  /** 等 tab 标题渲染出现(含 kw 文字的 li)。超时返回 false(不 reject) */
  function waitTab(kw) {
    return T.waitFor(function () {
      return T.qsa('li.its-tab, .its-tab-title li').some(function (el) {
        return (el.textContent || '').indexOf(kw) !== -1;
      });
    }, 15000).then(function () { return true; }).catch(function () { return false; });
  }
  /** 等基础信息面板有内容(.details-panel 内出现 .panel-title) */
  function waitBasicPanel() {
    return T.waitFor(function () {
      var root = T.qs('.J_BaseInfoContent') || T.qs('.details-panel');
      return root && T.qsa('.panel-title', root).length > 0 && T.qsa('.bisection-2', root).length > 0;
    }, 8000).catch(function () { return null; }).then(function () { return T.sleep(2500); });
  }
  /** 等计税详情面板有内容(出现可见 its-table 或 tax-explain-list) */
  function waitTaxPanel() {
    return T.waitFor(function () {
      var tbls = T.qsa('.its-table').filter(function (t) {
        return T.isVisible(t) && T.qsa('tbody tr', t).length > 0;
      });
      return tbls.length > 0 || T.qsa('.tax-explain-list').length > 0;
    }, 8000).catch(function () { return null; }).then(function () { return T.sleep(2500); });
  }

  /**
   * 阶段A:抓基础信息 + 计税详情 + 退税记录(不含工资薪金明细)。
   * 这三个都在 SPA tab 内切换,不点跨页按钮不触发页面刷新,可安全在单次注入内完成。
   * 结果写入传入的 sec 对象(增量),返回 Promise<void>(不 reject)。
   * 调用方抓完应立即存盘,再单独跑 captureSalaryDetail()。
   * skipPersonal=true 时,基础信息只抓汇算地(机关/单位),跳过重复的纳税人基本信息。
   */
  function captureBasicAndTax(sec, skipPersonal) {
    // 阶段1:基础信息
    return waitTab('基础信息')
      .then(function () { return clickItsTab('基础信息'); })
      .then(function (ok) {
        if (!ok) { sec['基础信息'] = { error: 'tab 未找到' }; return; }
        return waitBasicPanel().then(function () {
          try { sec['基础信息'] = captureBasicInfo(skipPersonal); }
          catch (e) { sec['基础信息'] = { error: String(e && e.message || e) }; }
        });
      })
      // 阶段2:计税详情
      .then(function () { return waitTab('计税详情'); })
      .then(function () { return clickItsTab('计税详情'); })
      .then(function (ok2) {
        if (!ok2) { sec['计税详情'] = { error: 'tab 未找到' }; return; }
        return waitTaxPanel().then(function () {
          try {
            var td = captureTaxDetail();
            // 计税详情:收入表(完整表格行)+ 汇总 + 逐项金额(归组)
            sec['计税详情'] = {
              '收入表': td.incomeRows,
              '汇总': td.summary,
              '逐项金额': td.detailItems
            };
            // 页头两金额(若在该 tab 可见;收入明细页读到会再覆盖)
            var ovA = readIncomeOverview();
            if (ovA['单独计税奖金']) sec['计税详情']['单独计税奖金'] = ovA['单独计税奖金'];
            if (ovA['收入总额']) sec['计税详情']['收入总额'] = ovA['收入总额'];
          } catch (e) { sec['计税详情'] = { error: '采集异常:' + (e && e.message || e) }; }
        });
      })
      // 阶段3:退税记录(综合所得年度汇算才有;求和存 汇算已退税额1)
      .then(function () { return captureRefundRecords(); })
      .then(function (refund) { if (refund) sec['退税记录'] = refund; })
      .catch(function (e) {
        T.report('    申报详情(基础信息+计税详情+退税记录)采集异常:' + (e && e.message || e), 'err');
      });
  }

  /**
   * 阶段B:抓工资薪金明细(逐月收入) + 单独计税奖金明细。点详情按钮可能触发页面刷新,
   * 故独立成阶段--刷新后可从断点续采(detail-salary stage)。
   * 先确保在计税详情 tab,找到入口按钮,点进去翻页导出,再返回计税详情。
   * 返回 Promise<{工资薪金:[...], 单独计税奖金:[...]}|null>(不 reject)。
   */
  function captureSalaryDetail() {
    // 续采场景:刷新后可能已经在工资薪金明细页(.income-gzxj-tab 有数据行)
    // -> 无需再点入口按钮,直接 collectPages 导出
    var alreadyOnSalary = T.qs('.income-gzxj-tab') &&
      T.qsa('.income-gzxj-tab table.its-table tbody tr td').length > 0;
    if (alreadyOnSalary) {
      T.report('    续采:已在工资薪金明细页,直接导出');
      var result = { 工资薪金: [], 单独计税奖金金额: '', 收入总额: '' };
      return T.sleep(800)
        .then(function () {
          var ov = readIncomeOverview();
          result.收入总额 = ov['收入总额'];
          result.单独计税奖金金额 = ov['单独计税奖金'];
        })
        .then(function () { return collectPages(); })
        .then(function (rows) { result.工资薪金 = rows || []; return result; })
        .catch(function (e) {
          T.report('    工资薪金明细导出失败:' + (e && e.message || e), 'err');
          return result;
        });
    }
    // 常规场景:在计税详情 tab,点入口按钮进入明细页
    return clickItsTab('计税详情').catch(function () {})
      .then(function () { return T.sleep(1200); })
      .then(function () { return captureIncomeDetailPaged(); })
      .catch(function (e) {
        T.report('    工资薪金明细导出失败:' + (e && e.message || e), 'err');
        return null;
      });
  }

  /**
   * 抓单条申报详情:基础信息 + 计税详情 + 工资薪金明细(整体)。
   * 兼容封装:依次调 captureBasicAndTax + captureSalaryDetail。
   * 返回 Promise<{_detail_sections}>。任一阶段失败都不丢弃已抓数据。
   */
  function captureDetail() {
    var sec = {};
    return captureBasicAndTax(sec)
      .then(function () { return captureSalaryDetail(); })
      .then(function (result) {
        if (result && sec['计税详情'] && !sec['计税详情'].error) {
          // v4:result = {工资薪金:[...], 单独计税奖金金额:'...'};奖金明细由导出端派生
          if (result.工资薪金 && result.工资薪金.length) sec['计税详情']['工资薪金明细'] = result.工资薪金;
          if (result.单独计税奖金金额) sec['计税详情']['单独计税奖金'] = result.单独计税奖金金额;
        }
        return { _detail_sections: sec };
      })
      .catch(function (e) {
        T.report('    申报详情采集兜底异常:' + (e && e.message || e), 'err');
        return { _detail_sections: sec, _error: String(e && e.message || e) };
      });
  }

  T.detail = {
    realClick: realClick,
    clickItsTab: clickItsTab,
    clickBreadcrumb: clickBreadcrumb,
    captureDetail: captureDetail,
    captureBasicAndTax: captureBasicAndTax,
    captureSalaryDetail: captureSalaryDetail,
    captureTaxDetail: captureTaxDetail,
    captureRefundRecords: captureRefundRecords,
    captureDeductionTabs: captureDeductionTabs,
    returnToAnnualSettle: returnToAnnualSettle,
    extractRefundSum: extractRefundSum,
    readIncomeOverview: readIncomeOverview,
    readSeparateBonusAmount: readSeparateBonusAmount,
    groupDetailItems: groupDetailItems
  };
})();
