/**
 * content/payload.js —— 采集原始 job → 导出 payload 重组(transformPayload)
 *
 * v2 数据重构:去重 + 按年度组织。transformPayload 把采集原始结构
 *   {申报:{列表,详情}, 专项附加扣除:{记录,明细}}
 * 重组为
 *   {纳税人, 税款所属期起始, 年度汇算:{year:{...}}, 专项附加扣除:{year:[...]}}。
 * 去重:纳税人基本信息提到顶层一份;收入表与逐项金额合一;明细 sections 与 kv 合一;
 *      扣除明细剔除"我的手机/邮箱/地址"(已在顶层纳税人)。
 *
 * 挂在 T.payload 下,依赖 T.mask(脱敏);主编排(main.js)复用 yearOf/deductionYears/
 * salaryBonusOf 做采集判定,导出时调用 transform/realName。
 */
(function () {
  'use strict';
  var T = window.__taxExport;
  var maskBy = T.mask.by;

  /** 扣除年度列表:从 startYear 到上一年(如 2022..2025)。今年(当前年)数据不采。
   *  startYear = 当前年 + job.yearOffset(采集年份选择器;缺省回退 utils 默认偏移)。 */
  function deductionYears(job) {
    if (job.deductionYears && job.deductionYears.length) return job.deductionYears;
    var now = new Date();
    var cur = now.getFullYear();
    var offset = (job.yearOffset != null) ? job.yearOffset : T.DEDUCT_YEARS_OFFSET;
    var start = cur + offset;
    var ys = [];
    for (var y = start; y <= cur - 1; y++) ys.push(y);  // 止于上一年
    job.deductionYears = ys;
    return ys;
  }


  /* ------------------------- 全部完成:导出(申报 + 专项附加扣除)-------------------------
   * v2 数据重构:去重 + 按年度组织。transformPayload 把采集原始结构
   *   {申报:{列表,详情}, 专项附加扣除:{记录,明细}}
   * 重组为
   *   {纳税人, 税款所属期起始, 年度汇算:{year:{...}}, 专项附加扣除:{year:[...]}}。
   * 去重:纳税人基本信息提到顶层一份;收入表与逐项金额合一;明细 sections 与 kv 合一;
   *      扣除明细剔除"我的手机/邮箱/地址"(已在顶层纳税人)。
   */

  /** 从"申报项目"(如"2024年度综合所得年度汇算")提取年份数字 */
  function yearOf(label) {
    var m = String(label || '').match(/(20\d{2})/);
    return m ? m[1] : '';
  }

  /* ------------------------- 申报月数(子女教育/3岁以下婴幼儿照护/赡养老人)-------------------------
   * 子女教育:按「当前受教育阶段开始时间/结束时间」时间段与当年相交的月份数求和。
   *   - 单值可能同时含两端("2021-09-01/2025-07-31" → 2025 年报 7 个月),也可能只有开始或结束一端
   *     (只有一端时,当年从该月起/止于该月计满当年剩余/已有月份)。
   *   - 多阶段(如小学+初中)在明细页一行一条,各条按自己的时间段逐条计月后相加。
   * 3岁以下婴幼儿照护:出生月起至满 3 周岁当月(含),与当年相交的月份数。
   *   例:2022-05 生 → 2022 年 8 个月(5~12 月)、2025 年 5 个月(1~5 月,5 月满 3 周岁仍可报)。
   * 赡养老人:满 60 周岁的当月起算(生日落在该月某一天即计该月),当年(满 60 之年)为 13-出生月,
   *   其后年份为 12。例:1964-05 生 → 2024 年 5 月满 60 → 2024 年报 8 个月(5~12 月)、2025 年起每年 12 个月。
   * 统一用零填充月粒度 "YYYY-MM" 字符串比较(字典序即时间序)。
   */

  /** 解析 "2021-09-01"/"2021-09"/"2021年9月" → "2021-09";不可解析返回 null */
  function ymOf(v) {
    var m = String(v == null ? '' : v).trim().match(/^(\d{4})[-/年.](\d{1,2})/);
    if (!m) return null;
    return m[1] + '-' + (m[2].length === 1 ? '0' + m[2] : m[2]);
  }

  /** 从一条子女教育记录提取受教育时间段列表:每段 [开始月|null, 结束月|null](单侧可为空) */
  function eduPeriodsOf(row) {
    var starts = [], ends = [];
    Object.keys(row || {}).forEach(function (k) {
      if (!/受教育|教育.*(开始|结束|终止)/.test(k)) return;
      var v = String(row[k] == null ? '' : row[k]).trim().replace(/至|到|~/g, '/');
      if (!v) return;
      // 单值内含 start/end(如 "2021-09-01/2025-07-31";含 4 段=两段区间)
      if (v.indexOf('/') !== -1 && /-/.test(v)) {
        var yms = [];
        v.split('/').forEach(function (p) { var t = ymOf(p); if (t) yms.push(t); });
        for (var i = 0; i + 1 < yms.length; i += 2) { starts.push(yms[i]); ends.push(yms[i + 1]); }
        if (yms.length % 2 === 1) starts.push(yms[yms.length - 1]);
        return;
      }
      if (/开始/.test(k)) { var s = ymOf(v); if (s) starts.push(s); }
      else if (/结束|终止/.test(k)) { var e = ymOf(v); if (e) ends.push(e); }
    });
    // 开始/结束按序配对(缺一端则该侧视为开区间)
    var periods = [];
    for (var j = 0; j < Math.max(starts.length, ends.length); j++) {
      if (starts[j] || ends[j]) periods.push([starts[j] || null, ends[j] || null]);
    }
    return periods;
  }

  /** 时间段 [start, end](月粒度,单侧可为 null)与 y 年相交的月份数 */
  function overlapMonths(y, start, end) {
    var yLo = y + '-01', yHi = y + '-12';
    var lo = start || yLo, hi = end || yHi;
    if (lo > yHi || hi < yLo) return 0;
    var from = lo < yLo ? yLo : lo;
    var to = hi > yHi ? yHi : hi;
    return (parseInt(to.slice(0, 4), 10) - parseInt(from.slice(0, 4), 10)) * 12 +
      (parseInt(to.slice(5), 10) - parseInt(from.slice(5), 10)) + 1;
  }

  /** 子女教育某年申报月数:全部受教育时间段与该年相交月数之和;无时间段返回 0 */
  function educationMonths(y, row) {
    var total = 0;
    eduPeriodsOf(row).forEach(function (p) { total += overlapMonths(y, p[0], p[1]); });
    return total;
  }

  /** 3岁以下婴幼儿照护某年申报月数:出生月 ~ 满 3 周岁当月(含);缺出生日期返回 null */
  function infantCareMonths(y, birth) {
    var b = ymOf(birth);
    if (!b) return null;
    var by = parseInt(b.slice(0, 4), 10), bm = parseInt(b.slice(5), 10);
    var end = (by + 3) + '-' + (bm < 10 ? '0' + bm : '' + bm);
    return overlapMonths(y, b, end);
  }

  /** 赡养老人某年申报月数:满 60 周岁的当月起算(生日在该月任意一天即计该月)。
   *  满 60 之年:13-出生月(5 月满 60 → 5~12 月 = 8);其后年份恒为 12;之前年份为 0。
   *  缺出生日期返回 null。 */
  function elderlySupportMonths(y, birth) {
    var b = ymOf(birth);
    if (!b) return null;
    var yy = parseInt(y, 10);
    var by = parseInt(b.slice(0, 4), 10), bm = parseInt(b.slice(5), 10);
    var turnY = by + 60;
    if (yy < turnY) return 0;
    if (yy === turnY) return 13 - bm;
    return 12;
  }


  /** 把采集原始 job 重组为去重+按年度的紧凑 payload */
  function transformPayload(job) {
    var rows = job.rows || [];
    var details = job.details || [];
    var deduct = job.deduction;

    // 1. 纳税人基本信息:扫描所有详情,取首个含完整个人信息的(瘦身模式下可能不在 details[0])
    var taxpayer = {};
    var nameMap = {
      '个人基础信息': '姓名', '国籍': '国籍', '身份证号': '身份证号',
      '手机号码': '手机号码', '电子邮箱': '电子邮箱', '联系地址': '联系地址'
    };
    for (var di = 0; di < details.length; di++) {
      try {
        var kv = (details[di] && details[di]._detail_sections &&
          details[di]._detail_sections['基础信息'] &&
          details[di]._detail_sections['基础信息'].kv) || {};
        if (kv['个人基础信息'] || kv['姓名']) {
          Object.keys(nameMap).forEach(function (k) {
            if (kv[k] != null) taxpayer[nameMap[k]] = maskBy(nameMap[k], kv[k]);  // 脱敏
          });
          break;
        }
      } catch (e) {}
    }

    // 2. 年度汇算:列表行 + 详情融合,按年份索引
    var annualSettle = {};
    // 列表列名可能因页面版本不同(应缴税款(元)/应补退税额/应纳税额 等),用模糊匹配取值
    function rowField(row, keywords) {
      var keys = Object.keys(row || {});
      for (var i = 0; i < keywords.length; i++) {
        var kw = keywords[i];
        // 精确匹配优先
        for (var j = 0; j < keys.length; j++) { if (keys[j] === kw) return row[keys[j]]; }
        // 包含匹配(去掉(元)/元后缀比对)
        for (var k = 0; k < keys.length; k++) {
          var nk = keys[k].replace(/[（(]元[)）]?$/, '').replace(/元$/, '');
          if (nk === kw || nk.indexOf(kw) !== -1) return row[keys[k]];
        }
      }
      return '';
    }
    // 2a. 先用列表行建年度骨架
    rows.slice(0, job.total).forEach(function (r) {
      var y = yearOf(r['申报项目'] || rowField(r, ['申报项目']));
      if (!y || annualSettle[y]) return;
      annualSettle[y] = {
        年度: y,
        状态: r['申报状态'] || rowField(r, ['状态']) || '',
        税款所属期: rowField(r, ['税款所属期']),
        缴款期限: rowField(r, ['缴款期限']),
        应缴税款: cleanMoney(rowField(r, ['应缴税款', '应补退税额', '应纳税额', '应补(退)税'])),
        本次申报已缴税款: cleanMoney(rowField(r, ['本次申报已缴税款', '已缴税款'])),
        汇算地: {}, 计税汇总: {}, 收入明细: {}, 工资薪金明细: [], 单独计税奖金明细: [], 专项附加扣除: []
      };
    });
    // 2b. 详情兜底:列表行提取失败时,用详情的 _申报项目 补建年度骨架(修 PDF 只显示扣除的 bug)
    details.forEach(function (d) {
      var y = yearOf(d['_申报项目']);
      if (!y || annualSettle[y]) return;
      annualSettle[y] = {
        年度: y, 状态: d['_申报状态'] || '', 税款所属期: '', 缴款期限: '', 应缴税款: '', 本次申报已缴税款: '',
        汇算地: {}, 计税汇总: {}, 收入明细: {}, 工资薪金明细: [], 单独计税奖金明细: [], 专项附加扣除: []
      };
    });
    // 2c. 再用详情填充每个年度的汇算地/计税汇总/收入明细/工资薪金明细
    details.forEach(function (d) {
      var y = yearOf(d['_申报项目']);
      if (!y || !annualSettle[y]) return;
      var sec = (d._detail_sections) || {};
      var base = (sec['基础信息'] && sec['基础信息'].kv) || {};
      // 汇算地(跨年可能变化,留在年度内;机关/单位脱敏,只留省级行政区)
      annualSettle[y].汇算地 = {
        主管税务机关: maskBy('主管税务机关', base['汇算地主管税务机关'] || ''),
        任职受雇单位: maskBy('任职受雇单位', base['任职受雇单位'] || '')
      };
      var tax = sec['计税详情'] || {};
      // 资薪奖金收入三情况判定(①无奖金=0 ②并入综合=工资明细全年一次性奖金行合计 ③单独计税=单独计税奖金合计)
      var bonusInfo = salaryBonusOf(tax);
      // 计税详情表:完整收入表行(去噪音"操作"列,保留 分类/项目/金额)
      var rawRows = tax['收入表'] || tax['incomeRows'] || [];
      annualSettle[y].计税详情表 = rawRows.map(function (r) {
        return { 分类: r['分类'] || '', 项目: r['项目'] || '', 金额: cleanMoney(r['金额(元)']) };
      });
      // 「工资薪金」行金额 = 总收入明细页头「收入总额」 − 工资明细中「全年一次性奖金」行合计(收入总额含并入奖金,须剔除)
      if (tax['收入总额']) {
        var gzAmount = parseFloat(cleanMoney(tax['收入总额'])) - sumAnnualBonusRows(tax);
        annualSettle[y].计税详情表.forEach(function (rw) {
          if ((rw['项目'] || '').trim() === '工资薪金') rw['金额'] = (Math.round(gzAmount * 100) / 100).toFixed(2);
        });
      }
      // 「工资薪金」行下方补「资薪奖金收入」(金额=bonusInfo.amount);类型一并入库(JSON&PDF 导出)
      insertSalaryBonusRow(annualSettle[y].计税详情表, bonusInfo.amount);
      if (bonusInfo.type) annualSettle[y]['资薪奖金类型'] = bonusInfo.type;
      // 总收入 = 工资薪金收入 + 资薪奖金收入(计税详情表两行之和)
      var gzV = null, bonusRowV = null;
      annualSettle[y].计税详情表.forEach(function (rw) {
        var p = (rw['项目'] || '').trim();
        if (p === '工资薪金') gzV = parseFloat(rw['金额']);
        else if (p === '资薪奖金收入') bonusRowV = parseFloat(rw['金额']);
      });
      if (gzV != null && !isNaN(gzV)) {
        var totV = gzV + (!isNaN(bonusRowV) ? bonusRowV : 0);
        annualSettle[y]['总收入'] = (Math.round(totV * 100) / 100).toFixed(2);
      }
      // 计税汇总(原"汇总",去"元"后缀归一)
      annualSettle[y].计税汇总 = cleanSummary(tax['汇总'] || {});
      // 计税汇总.收入:改用「总收入明细」页头口径 = 收入总额 + 单独计税奖金(如 298254.85+1330.94);
      // 页头未读到(未进明细页)时保持计税详情汇总原值
      var incTotal = parseFloat(cleanMoney(tax['收入总额']));
      if (!isNaN(incTotal)) {
        var incBonus = parseFloat(cleanMoney(tax['单独计税奖金']));
        if (isNaN(incBonus)) incBonus = 0;
        annualSettle[y].计税汇总['收入'] = (Math.round((incTotal + incBonus) * 100) / 100).toFixed(2);
      }
      // 单独计税奖金(页头金额)单独入库,JSON/PDF 导出
      if (tax['单独计税奖金']) annualSettle[y]['单独计税奖金'] = cleanMoney(tax['单独计税奖金']);
      // 退税记录:汇算已退税额1(仅 国库处理完成/国库处理中)+ 已预缴税额(仅 国库处理完成/税务审核中)
      var refund = sec['退税记录'] || {};
      if (refund['汇算已退税额1']) annualSettle[y]['汇算已退税额1'] = refund['汇算已退税额1'];
      if (refund['已预缴税额']) annualSettle[y]['已预缴税额'] = refund['已预缴税额'];
      // 收入明细:用"逐项金额"的按分类归组(去 _flat);失败回退用收入表归组
      var items = tax['逐项金额'] || tax['detailItems'] || {};
      annualSettle[y].收入明细 = pickIncomeDetail(items, tax['收入表'] || tax['incomeRows'] || []);
      // 工资薪金明细(去噪音"操作"列;扣缴义务人脱敏只留省份)。
      // 单独计税时剔除「全年一次性奖金」行:该部分奖金不作为工资采集(扣除不采集)
      var salary = filterSalaryRows(tax['工资薪金明细'], bonusInfo.separate);
      annualSettle[y].工资薪金明细 = salary.map(function (s) {
        return { 税款所属期: s['税款所属期'] || '', 所得项目小类: s['所得项目小类'] || '',
          扣缴义务人: maskBy('扣缴义务人', s['扣缴义务人'] || ''), 收入: cleanMoney(s['收入(元)']), 状态: s['状态'] || '' };
      });
      // 单独计税奖金明细(派生,不再从页面单独抓;见 buildBonusDetailRows)
      annualSettle[y].单独计税奖金明细 = buildBonusDetailRows(tax, bonusInfo);
      // 专项附加扣除明细:由本页「专项附加扣除→详情」标签页采集(专项附加扣除信息查询阶段已移除)
      //  → 下沉为该年专项附加扣除条目(值逐字段 maskBy 脱敏;兼容旧字段 赡养老人明细)
      var tabMap = sec['专项附加扣除明细'] || {};
      var elderlyRows = tabMap['赡养老人'] || sec['赡养老人明细'] || [];
      var tabRows = {
        '赡养老人': { rows: elderlyRows, section: '被赡养人信息', ident: '被赡养人姓名' },
        '子女教育': { rows: tabMap['子女教育'] || [], section: '子女教育信息', ident: '子女姓名' },
        '继续教育': { rows: tabMap['继续教育'] || [], section: '继续教育信息', ident: '' },
        '3岁以下婴幼儿照护': { rows: tabMap['3岁以下婴幼儿照护'] || [], section: '婴幼儿照护信息', ident: '子女姓名' }
      };
      Object.keys(tabRows).forEach(function (proj) {
        var cfg = tabRows[proj];
        cfg.rows.forEach(function (r) {
          var kv = {};
          Object.keys(r).forEach(function (k) { kv[k] = maskBy(k, r[k]); });
          var item = { '项目': proj, '扣除年度': y + '年', '明细': {} };
          if (Object.keys(kv).length) item['明细'][cfg.section] = kv;
          if (cfg.ident && r[cfg.ident]) item[cfg.ident] = maskBy(cfg.ident, r[cfg.ident]);
          // 申报月数:子女教育按受教育时间段、婴幼儿照护/赡养老人按出生日期,与当年相交月数;缺数据不设
          if (proj === '子女教育') {
            var eduM = educationMonths(y, r);
            if (eduM > 0) item['申报月数'] = eduM;
          } else if (proj === '3岁以下婴幼儿照护') {
            var careM = infantCareMonths(y, r['出生日期'] || (kv['出生日期'] || ''));
            if (careM != null && careM > 0) item['申报月数'] = careM;
          } else if (proj === '赡养老人') {
            var eldM = elderlySupportMonths(y, r['出生日期'] || (kv['出生日期'] || ''));
            if (eldM != null && eldM > 0) item['申报月数'] = eldM;
          }
          annualSettle[y].专项附加扣除.push(item);
        });
      });
    });

    // 3. 专项附加扣除:数据源已改为 年度汇算详情页「专项附加扣除->详情」标签页(第 2c 步内下沉),
    //    旧的「专项附加扣除信息查询」阶段已移除(job.deduction 不再产生)
    var years0 = deductionYears(job);
    var deductRange = years0.length ? (years0[0] + '~' + years0[years0.length - 1]) : '';
    if (job.deduction && (job.deduction.记录 || []).length) {
      // 兼容:旧版本中断任务的存量数据仍并入(按 扣除年度 下沉,无明细则只留记录)
      ((job.deduction.记录) || []).forEach(function (c) {
        var y = yearOf(c['扣除年度']);
        if (!y) return;
        if (!annualSettle[y]) annualSettle[y] = {
          年度: y, 状态: '', 税款所属期: '', 缴款期限: '', 应缴税款: '', 本次申报已缴税款: '',
          汇算地: {}, 计税汇总: {}, 收入明细: {}, 工资薪金明细: [], 单独计税奖金明细: [], 专项附加扣除: []
        };
        annualSettle[y].专项附加扣除.push({
          项目: c['项目'] || '', 扣除年度: c['扣除年度'] || '',
          被赡养人姓名: maskBy('被赡养人姓名', c['被赡养人姓名'] || ''),
          子女姓名: maskBy('子女姓名', c['子女姓名'] || '')
        });
      });
    }

    // 收入纳税明细补采的缺失年份:按月汇总生成年度骨架 —— 字段结构与申报查询采集年份保持一致
    var missingMap = job.incomeTaxMissing || {};
    Object.keys(missingMap).forEach(function (y) {
      if (!missingMap[y]) return;
      var prev = annualSettle[y];
      if (prev && prev['数据来源']) return;  // 已生成过(防御)
      var md = missingMap[y];
      var rows = md['月明细'] || [];
      var sm = md['汇总'] || {};
      function f2(n) { return (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2); }
      var bonusInfo = salaryBonusOf({ '工资薪金明细': rows });
      var incomeSum = parseFloat(sm['收入']) || 0;
      var bonusRowsSum = sumAnnualBonusRows({ '工资薪金明细': rows });
      // 按所得类型归集收入(工资薪金/劳务报酬/稿酬/特许权使用费),对齐申报口径收入表
      var catIncome = {};
      rows.forEach(function (s) {
        var c = (s['所得类型'] || '工资薪金').trim() || '工资薪金';
        var v = parseFloat(cleanMoney(s['收入(元)']));
        if (!isNaN(v)) catIncome[c] = (catIncome[c] || 0) + v;
      });
      // 计税详情表:与申报查询「收入表」同构(26 行)。细分行无月度对应=0;
      // 聚合同名行(页面惯例:费用|费用、减除费用|减除费用)放月度汇总额;减除费用默认 60000
      var tableRows = [
        { '分类': '收入', '项目': '工资薪金', '金额': f2((catIncome['工资薪金'] || 0) - bonusRowsSum) },
        { '分类': '收入', '项目': '资薪奖金收入', '金额': f2(bonusInfo.amount || 0) },
        { '分类': '收入', '项目': '劳务报酬', '金额': f2(catIncome['劳务报酬'] || 0) },
        { '分类': '收入', '项目': '稿酬', '金额': f2(catIncome['稿酬'] || 0) },
        { '分类': '收入', '项目': '特许权使用费', '金额': f2(catIncome['特许权使用费'] || 0) },
        { '分类': '费用', '项目': '费用', '金额': '0.00' },
        { '分类': '免税收入', '项目': '稿酬所得免税部分', '金额': '0.00' },
        { '分类': '免税收入', '项目': '其他免税收入', '金额': f2(sm['本期免税收入'] || 0) },
        { '分类': '减除费用', '项目': '减除费用', '金额': sm['本期减除费用'] != null ? f2(sm['本期减除费用']) : '60000.00' },
        { '分类': '专项扣除', '项目': '基本养老保险', '金额': '0.00' },
        { '分类': '专项扣除', '项目': '基本医疗保险', '金额': '0.00' },
        { '分类': '专项扣除', '项目': '失业保险', '金额': '0.00' },
        { '分类': '专项扣除', '项目': '住房公积金', '金额': '0.00' },
        { '分类': '专项扣除', '项目': '专项扣除', '金额': f2(sm['本期专项扣除'] || 0) },
        { '分类': '专项附加扣除', '项目': '子女教育', '金额': '0.00' },
        { '分类': '专项附加扣除', '项目': '继续教育', '金额': '0.00' },
        { '分类': '专项附加扣除', '项目': '大病医疗', '金额': '0.00' },
        { '分类': '专项附加扣除', '项目': '住房贷款利息', '金额': '0.00' },
        { '分类': '专项附加扣除', '项目': '住房租金', '金额': '0.00' },
        { '分类': '专项附加扣除', '项目': '赡养老人', '金额': '0.00' },
        { '分类': '专项附加扣除', '项目': '3岁以下婴幼儿照护', '金额': '0.00' },
        { '分类': '其他扣除', '项目': '年金', '金额': '0.00' },
        { '分类': '其他扣除', '项目': '商业健康险', '金额': '0.00' },
        { '分类': '其他扣除', '项目': '允许扣除的税费', '金额': '0.00' },
        { '分类': '其他扣除', '项目': '个人养老金', '金额': '0.00' },
        { '分类': '其他扣除', '项目': '其他', '金额': '0.00' },
        { '分类': '其他扣除', '项目': '其他扣除', '金额': f2(sm['本期其他扣除'] || 0) },
        { '分类': '准予扣除的捐赠', '项目': '准予扣除的捐赠额', '金额': f2(sm['本期准予扣除的捐赠项目'] || 0) }
      ];
      // 计税汇总.费用、免税收入和税前扣除 = 计税详情表扣除类各行合计(减除费用默认 60000 已含)
      var DEDUCT_CATS = ['免税收入', '减除费用', '专项扣除', '专项附加扣除', '其他扣除', '准予扣除的捐赠'];
      var deductTotal = tableRows.reduce(function (acc, rw) {
        return DEDUCT_CATS.indexOf(rw['分类']) !== -1 ? acc + (parseFloat(rw['金额']) || 0) : acc;
      }, 0);
      var 计税汇总 = { '收入': f2(incomeSum) };
      计税汇总['费用、免税收入和税前扣除'] = f2(deductTotal);
      计税汇总['已缴税额'] = f2(sm['已申报税额']);
      // 收入明细:计税详情表按分类归组(同 groupDetailItems 规则:跳过 项目==分类 的大类汇总行)
      var 收入明细 = {};
      tableRows.forEach(function (rw) {
        if (!rw['项目'] || rw['项目'] === rw['分类']) return;
        if (!收入明细[rw['分类']]) 收入明细[rw['分类']] = {};
        收入明细[rw['分类']][rw['项目']] = rw['金额'];
      });
      annualSettle[y] = {
        年度: y, 状态: '未申报', 数据来源: '收入纳税明细按月汇算',
        税款所属期: y + '-01至' + y + '-12', 缴款期限: '', 应缴税款: '', 本次申报已缴税款: '',
        汇算地: { 主管税务机关: '', 任职受雇单位: '' },
        计税汇总: 计税汇总,
        收入明细: 收入明细,
        工资薪金明细: filterSalaryRows(rows, bonusInfo.separate).map(function (s) {
          return { 税款所属期: s['税款所属期'] || '', 所得项目小类: s['所得项目小类'] || '',
            扣缴义务人: maskBy('扣缴义务人', s['扣缴义务人'] || ''), 收入: cleanMoney(s['收入(元)']), 状态: '' };
        }),
        单独计税奖金明细: buildBonusDetailRows({ '工资薪金明细': rows }, bonusInfo),
        专项附加扣除: [],
        计税详情表: tableRows
      };
      // 该年若已被专项附加扣除阶段补建骨架(扣除年度在缺失年内),保留其扣除条目
      if (prev && (prev['专项附加扣除'] || []).length) {
        annualSettle[y]['专项附加扣除'] = prev['专项附加扣除'];
      }
      if (bonusInfo.type) annualSettle[y]['资薪奖金类型'] = bonusInfo.type;
      // 总收入 = 计税详情表「收入」类各行合计(与申报口径一致)
      annualSettle[y]['总收入'] = f2(tableRows.reduce(function (acc, rw) {
        return rw['分类'] === '收入' ? acc + (parseFloat(rw['金额']) || 0) : acc;
      }, 0));
      annualSettle[y]['已预缴税额'] = f2(sm['已申报税额']);
      // 资薪奖金税额 = 奖金行(全年一次性奖金)已申报税额合计(对齐非缺失年的 collectBonusDeclaredTax 口径)
      var bonusTaxSum = rows.reduce(function (acc, s) {
        return String(s['所得项目小类'] || '').indexOf('全年一次性奖金') !== -1
          ? acc + (parseFloat(cleanMoney(s['已申报税额(元)'])) || 0) : acc;
      }, 0);
      if (bonusTaxSum > 0) annualSettle[y]['资薪奖金税额'] = f2(bonusTaxSum);
    });

    // 收入纳税明细查询「已申报税额合计」覆盖 已预缴税额(未采到年份沿用退税记录口径)
    var incomeTaxMap = job.incomeTax || {};
    Object.keys(incomeTaxMap).forEach(function (y) {
      if (annualSettle[y]) annualSettle[y]['已预缴税额'] = incomeTaxMap[y];
    });
    // 收入纳税明细「全年一次性奖金」行已申报税额合并 → 资薪奖金税额
    var incomeTaxBonus = job.incomeTaxBonus || {};
    Object.keys(incomeTaxBonus).forEach(function (y) {
      if (annualSettle[y]) annualSettle[y]['资薪奖金税额'] = incomeTaxBonus[y];
    });

    // 家庭成员(最终阶段采集;姓名脱敏)
    var family = (job.familyMembers || []).map(function (m) {
      return {
        '姓名': maskBy('姓名', m['姓名'] || ''),
        '关系': m['关系'] || '',
        '出生日期': m['出生日期'] || ''
      };
    });

    return {
      抓取时间: job.startedAt,
      税款所属期起始: job.targetYM,
      扣除年度范围: deductRange,
      纳税人: taxpayer,
      家庭成员: family,
      年度汇算: annualSettle
    };
  }

  /** 金额清洗:"298254.85" / "298254.85元" / "-3216.41" → 纯数字字符串;空/"--"→"0.00" */
  function cleanMoney(v) {
    var s = String(v == null ? '' : v).trim().replace(/,/g, '').replace(/元$/, '');
    if (!s || s === '--' || s === '—' || s === '-') return '0.00';
    return s;
  }

  /** 工资薪金明细中「全年一次性奖金」行的收入合计(用于:资薪奖金②判定、工资薪金=收入总额−该合计) */
  function sumAnnualBonusRows(tax) {
    var s = 0;
    (tax['工资薪金明细'] || []).forEach(function (r) {
      if (String(r['所得项目小类'] || '').indexOf('全年一次性奖金') === -1) return;
      var v = parseFloat(cleanMoney(r['收入(元)']));
      if (!isNaN(v)) s += v;
    });
    return s;
  }

  /** 资薪奖金收入判定(三种情况),返回 { amount, separate, type }:
   *  ① 无奖金(单独计税=0 且 工资薪金明细无「全年一次性奖金」行) → 0,type=无奖金
   *  ② 奖金并入综合所得(单独计税=0,工资明细有 全年一次性奖金 行) → 该类行收入合计,type=奖金并入综合所得
   *  ③ 单独计税(页头单独计税奖金金额>0) → 页头金额,type=奖金单独计税;
   *    此时工资薪金明细须剔除全年一次性奖金行(见 filterSalaryRows)
   *  无任何明细数据佐证时 type=''(不标类型,避免误导)。 */
  function salaryBonusOf(tax) {
    var headerV = parseFloat(cleanMoney(tax['单独计税奖金']));      // ③ 页头金额(.qnycxjj-money)
    if (!isNaN(headerV) && headerV > 0) return { amount: headerV, separate: true, type: '奖金单独计税' };
    var mb = sumAnnualBonusRows(tax);                                // ② 并入综合的奖金行
    if (mb > 0) return { amount: mb, separate: false, type: '奖金并入综合所得' };
    // ① 无奖金:仅在确有明细数据佐证时才标类型(否则不标,避免采集失败被当成无奖金)
    var hasData = !!(tax['单独计税奖金'] ||
      (tax['工资薪金明细'] || []).length);
    return { amount: 0, separate: false, type: hasData ? '无奖金' : '' };
  }

  /** 单独计税奖金明细(派生,不从页面单独抓——页面切换抓取曾把工资行误当奖金行):
   *  ③ 单独计税 → 合成一行,收入=单独计税奖金合计(页头金额);
   *  ② 并入综合 → 工资薪金明细中的「全年一次性奖金」行即奖金明细(原样整形脱敏);
   *  ① 无奖金 → 空。 */
  function buildBonusDetailRows(tax, bonusInfo) {
    if (bonusInfo.separate) {
      return [{
        税款所属期: '', 所得项目小类: '单独计税奖金', 扣缴义务人: '',
        收入: (Math.round(bonusInfo.amount * 100) / 100).toFixed(2), 状态: ''
      }];
    }
    return (tax['工资薪金明细'] || []).filter(function (s) {
      return String(s['所得项目小类'] || '').indexOf('全年一次性奖金') !== -1;
    }).map(function (s) {
      return { 税款所属期: s['税款所属期'] || '', 所得项目小类: s['所得项目小类'] || '',
        扣缴义务人: maskBy('扣缴义务人', s['扣缴义务人'] || ''), 收入: cleanMoney(s['收入(元)']), 状态: s['状态'] || '' };
    });
  }

  /** 工资薪金明细输出过滤:单独计税时剔除「全年一次性奖金」行(扣除不采集) */
  function filterSalaryRows(rows, excludeBonus) {
    if (!excludeBonus) return rows || [];
    return (rows || []).filter(function (s) {
      return String(s['所得项目小类'] || '').indexOf('全年一次性奖金') === -1;
    });
  }

  /** 计税详情表「工资薪金」行下方插入「资薪奖金收入」(金额由 salaryBonusOf 判定)。找不到行不插。 */
  function insertSalaryBonusRow(table, amount) {
    var idx = -1;
    for (var i = 0; i < table.length; i++) {
      if ((table[i]['项目'] || '').trim() === '工资薪金') { idx = i; break; }
    }
    if (idx === -1) return false;
    table.splice(idx + 1, 0, {
      '分类': table[idx]['分类'] || '收入',
      '项目': '资薪奖金收入',
      '金额': (Math.round(amount * 100) / 100).toFixed(2)
    });
    return true;
  }

  /** 计税汇总:去掉每个值的"元"后缀,归一为纯数字 */
  function cleanSummary(summary) {
    var out = {};
    Object.keys(summary || {}).forEach(function (k) {
      out[k] = cleanMoney(summary[k]);
    });
    return out;
  }
  /** 收入明细:优先用逐项金额的分类归组(去 _flat);回退用收入表归组 */
  function pickIncomeDetail(items, incomeRows) {
    var out = {};
    Object.keys(items).forEach(function (cat) {
      if (cat === '_flat') return;
      var obj = items[cat] || {};
      if (Object.keys(obj).length) out[cat] = obj;
    });
    if (Object.keys(out).length) return out;
    // 回退:从收入表归组
    (incomeRows || []).forEach(function (r) {
      var cat = r['分类'] || r['category'] || '(未分组)';
      var name = r['项目'] || r['项目名'] || '';
      if (!name || name === cat) return;
      if (!out[cat]) out[cat] = {};
      out[cat][name] = cleanMoney(r['金额(元)'] || r['金额']);
    });
    return out;
  }

  /** 纳税人真实姓名(明文)。仅用于 PDF 文件名,随 EXPORT 消息单独传给 background;
   *  不进 payload(内容/JSON 附件/历史缓存仍脱敏)。 */
  function realTaxpayerName(job) {
    var details = job.details || [];
    for (var i = 0; i < details.length; i++) {
      try {
        var kv = (details[i] && details[i]._detail_sections &&
          details[i]._detail_sections['基础信息'] &&
          details[i]._detail_sections['基础信息'].kv) || {};
        if (kv['个人基础信息']) return String(kv['个人基础信息']).trim();
        if (kv['姓名']) return String(kv['姓名']).trim();
      } catch (e) {}
    }
    return '';
  }



  T.payload = {
    transform: transformPayload,
    realName: realTaxpayerName,
    deductionYears: deductionYears,
    yearOf: yearOf,
    salaryBonusOf: salaryBonusOf
  };
})();
