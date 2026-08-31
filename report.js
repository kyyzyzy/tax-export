/**
 * report.js —— JSON payload → HTML 报表渲染（report.html 加载）
 *
 * 由 report.html 加载。职责:
 *   1. 读 ?id= 从 chrome.storage.local 历史（tax_export_history）取 payload
 *   2. buildHtmlReport(payload, realName) 生成自包含、打印友好的中文 HTML 报表字符串
 *      (realName 为明文姓名,仅用于标题/纳税人信息展示;payload 本身仍脱敏)
 *   3. 写入 #report 容器,就绪后通知 background（VIEWER_READY）
 *   4. 等 background 打印完（PRINT_DONE）后关闭
 *
 * 报表结构:
 *   - 标题 + 元信息（导出时间 / 税款所属期起始 / 年度范围）
 *   - 申报列表（表格）
 *   - 逐条申报详情:基础信息 kv + 计税汇总 + 逐项金额 + 工资薪金明细
 *   - 专项附加扣除:记录表 + 逐条明细（分段）
 */
(function () {
  'use strict';

  var HISTORY_KEY = 'tax_export_history';
  var params = new URLSearchParams(location.search);
  var id = params.get('id');
  var statusEl = document.getElementById('status');
  var reportEl = document.getElementById('report');

  function send(msg) {
    chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
  }

  /* ------------------------- HTML 工具 ------------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 对象数组 → HTML 表格（首行表头为 keys 并集） */
  function aoaTable(rows) {
    if (!rows || !rows.length) return '<div class="empty">（无数据）</div>';
    var keys = [];
    rows.forEach(function (r) {
      Object.keys(r || {}).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); });
    });
    var head = '<tr>' + keys.map(function (k) { return '<th>' + esc(k) + '</th>'; }).join('') + '</tr>';
    var body = rows.map(function (r) {
      return '<tr>' + keys.map(function (k) { return '<td>' + esc(r[k] != null ? r[k] : '') + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  /** kv 对象 → 两列表格（键 / 值），每 N 个键一行多列省纸 */
  function kvTable(kv, perRow) {
    perRow = perRow || 3;
    var keys = kv ? Object.keys(kv) : [];
    if (!keys.length) return '<div class="empty">（无数据）</div>';
    var rows = '';
    for (var i = 0; i < keys.length; i += perRow) {
      var cells = '';
      for (var j = 0; j < perRow; j++) {
        var k = keys[i + j];
        if (k == null) { cells += '<td></td><td></td>'; continue; }
        cells += '<td>' + esc(k) + '</td><td>' + esc(kv[k]) + '</td>';
      }
      rows += '<tr>' + cells + '</tr>';
    }
    return '<table class="kv"><tbody>' + rows + '</tbody></table>';
  }

  /** 收入明细:按分类分小标题 + 每类 kv 表(v2:已无 _flat,直接遍历分类) */
  function incomeDetailHtml(items) {
    if (!items) return '';
    var out = '';
    Object.keys(items).forEach(function (cat) {
      var obj = items[cat] || {};
      if (!Object.keys(obj).length) return;
      out += '<div class="seg-title">' + esc(cat) + '</div>';
      out += kvTable(obj, 4);
    });
    return out;
  }

  /* ------------------------- 报表主体(v2:按新结构) ------------------------- */

  function buildHtmlReport(payload, realName) {
    var p = payload || {};
    var settle = p['年度汇算'] || {};

    // 标题 + 元信息。姓名优先明文 realName(仅页面展示;payload/内嵌 JSON 附件仍为脱敏名)
    var meta = [];
    if (p['导出时间']) meta.push('导出时间：' + esc(p['导出时间']));
    if (p['税款所属期起始']) meta.push('税款所属期起始：' + esc(p['税款所属期起始']));
    if (p['扣除年度范围']) meta.push('扣除年度范围：' + esc(p['扣除年度范围']));
    var displayName = realName || (p['纳税人'] && p['纳税人']['姓名']) || '';
    var html = '<h1>税务数据报表' +
      (displayName ? ' — ' + esc(displayName) : '') + '</h1>';
    html += '<div class="meta">' + meta.join('　·　') + '</div>';

    // 1. 纳税人信息(顶层一份;姓名同样用明文 realName 覆盖脱敏值)
    var tp = p['纳税人'] || {};
    if (realName && tp['姓名'] != null) tp = Object.assign({}, tp, { 姓名: realName });
    if (Object.keys(tp).length) {
      html += '<h2>纳税人信息</h2>';
      html += kvTable(tp, 3);
    }

    // 1.5 家庭成员(专项附加扣除已知成员 + 家庭成员信息页采集,同名去重合并)
    var fam = p['家庭成员'] || [];
    if (fam.length) {
      html += '<h2>家庭成员 <span class="pill">' + fam.length + ' 位</span></h2>';
      html += aoaTable(fam.map(function (m) {
        return { '姓名': m['姓名'] || '', '关系': m['关系'] || '', '出生日期': m['出生日期'] || '' };
      }));
    }

    // 2. 年度汇算(按年度,降序;每个年度整块 year-block 底色区分,依次浅红/浅黄/浅蓝循环)
    var ykeys = Object.keys(settle).sort(function (a, b) { return b - a; });
    ykeys.forEach(function (y, yi) {
      var yr = settle[y] || {};
      html += '<div class="year-block yb-' + (yi % 3) + '">';
      html += '<h2>' + esc(y) + ' 年度汇算' + (yr['状态'] === '已作废' ? ' <span class="pill">已作废</span>' : '') + '</h2>';
      // 汇总行:税款所属期/缴款期限/应缴税款/本次申报已缴税款
      var head = {};
      if (yr['税款所属期']) head['税款所属期'] = yr['税款所属期'];
      if (yr['数据来源']) head['数据来源'] = yr['数据来源'];
      if (yr['缴款期限']) head['缴款期限'] = yr['缴款期限'];
      if (yr['总收入'] != null) head['总收入(元)'] = yr['总收入'];
      if (yr['应缴税款'] != null) head['应缴税款(元)'] = yr['应缴税款'];
      if (yr['本次申报已缴税款'] != null) head['本次申报已缴税款(元)'] = yr['本次申报已缴税款'];
      if (yr['汇算已退税额1'] != null) head['汇算已退税额1(元)'] = yr['汇算已退税额1'];
      if (yr['已预缴税额'] != null) head['已预缴税额(元)'] = yr['已预缴税额'];
      if (yr['资薪奖金税额'] != null) head['资薪奖金税额(元)'] = yr['资薪奖金税额'];
      if (yr['单独计税奖金'] != null) head['单独计税奖金(元)'] = yr['单独计税奖金'];
      if (yr['资薪奖金类型']) head['资薪奖金类型'] = yr['资薪奖金类型'];
      if (Object.keys(head).length) {
        html += '<div class="seg-title">申报概况</div>';
        html += kvTable(head, 2);
      }
      // 汇算地
      var hl = yr['汇算地'] || {};
      if (Object.keys(hl).length) {
        html += '<div class="seg-title">汇算地</div>';
        html += kvTable(hl, 2);
      }
      // 计税汇总
      var sum = yr['计税汇总'] || {};
      if (Object.keys(sum).length) {
        html += '<div class="seg-title">计税汇总</div>';
        html += kvTable(sum, 3);
      }
      // 计税详情表(完整收入表行:分类/项目/金额)
      var taxTable = yr['计税详情表'] || [];
      if (taxTable.length) {
        html += '<div class="seg-title">计税详情表 <span class="pill">' + taxTable.length + ' 行</span></div>';
        html += aoaTable(taxTable);
      }
      // 收入明细(按分类)
      var inc = yr['收入明细'] || {};
      if (Object.keys(inc).length) {
        html += '<div class="seg-title">收入与扣除明细</div>';
        html += incomeDetailHtml(inc);
      }
      // 工资薪金明细(逐月表)
      var salary = yr['工资薪金明细'] || [];
      if (salary.length) {
        html += '<div class="seg-title">工资薪金明细 <span class="pill">' + salary.length + ' 行</span></div>';
        html += aoaTable(salary);
      }
      // 单独计税奖金明细(若有)
      var bonus = yr['单独计税奖金明细'] || [];
      if (bonus.length) {
        html += '<div class="seg-title">单独计税奖金明细 <span class="pill">' + bonus.length + ' 行</span></div>';
        html += aoaTable(bonus);
      }
      // 专项附加扣除(下沉到年度内)
      var deductItems = yr['专项附加扣除'] || [];
      if (deductItems.length) {
        html += '<div class="seg-title">专项附加扣除 <span class="pill">' + deductItems.length + ' 条</span></div>';
        deductItems.forEach(function (m, mi) {
          var segTitle = (mi + 1) + '. ' + (m['项目'] || '');
          if (m['扣除年度']) segTitle += ' · ' + m['扣除年度'];
          html += '<div class="seg-title" style="margin-top:10px">' + esc(segTitle) + '</div>';
          // 卡片描述字段(子女姓名/住房地址等)
          var desc = {};
          ['子女姓名', '申报月数', '被赡养人姓名', '住房地址', '房屋坐落地址', '出租方姓名',
           '当前受教育阶段', '学历教育阶段', '疾病名称', '租赁时间段',
           '申报扣缴义务人', '最后修改时间'].forEach(function (k) {
            if (m[k]) desc[k] = m[k];
          });
          if (Object.keys(desc).length) html += kvTable(desc, 2);
          // 明细 sections
          var sections = m['明细'] || {};
          Object.keys(sections).forEach(function (seg) {
            var segKv = sections[seg] || {};
            if (!Object.keys(segKv).length) return;
            html += '<div class="seg-title" style="color:#555;font-weight:600">— ' + esc(seg) + ' —</div>';
            html += kvTable(segKv, 3);
          });
        });
      }
      html += '</div>';  // /year-block
    });

    return html;
  }

  /* ------------------------- 主流程 ------------------------- */

  function setStatus(s, isErr) {
    statusEl.textContent = s;
    statusEl.style.color = isErr ? '#cf1322' : '#7a6312';
  }

  // 供测试调用(报表页自身不依赖)
  try { window.__taxReport = { buildHtmlReport: buildHtmlReport }; } catch (e) {}

  // 从历史取 payload
  chrome.storage.local.get(HISTORY_KEY, function (res) {    var list = (res && Array.isArray(res[HISTORY_KEY])) ? res[HISTORY_KEY] : [];
    var rec = list.filter(function (r) { return String(r.id) === String(id); })[0];
    if (!rec || !rec.payload) {
      setStatus('找不到历史记录(id=' + id + ')', true);
      send({ type: 'VIEWER_ERROR', id: id, error: '历史记录不存在或无 payload' });
      return;
    }
    try {
      reportEl.innerHTML = buildHtmlReport(rec.payload, rec.realName);
      statusEl.style.display = 'none';
      // 等一帧让表格/字体渲染,再通知就绪
      setTimeout(function () {
        send({ type: 'VIEWER_READY', id: id });
      }, 600);
    } catch (e) {
      setStatus('报表生成失败: ' + (e && e.message || e), true);
      send({ type: 'VIEWER_ERROR', id: id, error: String(e && e.message || e) });
    }
  });

  // 兜底:若 60s 内 background 没打印(如 SW 异常),主动报错关窗,避免残留
  setTimeout(function () {
    send({ type: 'VIEWER_ERROR', id: id, error: '报表等待打印超时(60s)' });
    try { window.close(); } catch (e) {}
  }, 60000);
})();
