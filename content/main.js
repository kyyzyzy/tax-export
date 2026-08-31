/**
 * content/main.js —— 跨刷新状态机主编排
 *
 * 核心:把原本一条 Promise 长链的采集流程,拆成「每步存盘、刷新可续」的状态机。
 * content script 每次页面加载自动注入,先读 background 里的任务进度,
 * 再根据「当前页面类型 + 进度 stage」判断该从哪一步继续。
 *
 * 模块分工(加载顺序见 manifest.json content_scripts):
 *   utils.js     底层工具/配置 → T
 *   datepickers  日期面板操作 → T.datepickers
 *   mask.js      脱敏(姓名/证件/手机/邮箱/地址打码) → T.mask
 *   list.js      申报列表页操作 → T.list
 *   detail.js    申报详情页操作 → T.detail
 *   deduction.js 专项附加扣除信息查询页操作 → T.deduction
 *   incometax.js 收入纳税明细查询页操作 → T.incomeTax
 *   family.js    家庭成员采集 + 扣除数据种子 → T.family
 *   payload.js   采集 job → 导出 payload 重组(transformPayload) → T.payload
 *   main.js      本文件:状态机编排
 *
 * 状态机:(今年/当前年的数据一律不采集:申报行按年份过滤,扣除年度止于上一年)
 *   【申报查询 · 默认视图】(进页面自带约 2 年数据,不设日期条件)
 *   (无任务) → START → 导航 → 默认视图提取列表 → stage='list'(phase='default',存 rows/total)
 *   stage='list' + 在列表页 → 点「查看」current → stage='detail'
 *   stage='detail' + 在详情页 → 抓详情 → 存入 details → 点面包屑返回 → stage='returning'
 *   stage='returning' + 在列表页 → current++ → 若还有: stage='list';默认视图遍历完 → 条件查询补采
 *   【条件查询补采】(默认视图采完后衔接,失败不阻塞)
 *   stage='cond' → 设「4 年前 1 月」条件+查询 → 提取列表 → 排除默认视图已采年份 → 并入 rows 继续逐条
 *   【已作废 tab 补采】(条件查询采完后衔接,失败不阻塞)
 *   stage='voided' → 重设条件+点「已作废」→ 提取列表 → 排除已采年份 → 并入 rows 继续逐条
 *   【收入纳税明细查询】(申报查询全部阶段采完后衔接,失败不阻塞)
 *   stage='incometax' → 逐年读「已申报税额合计」;缺失年份按月汇算补采
 *   【家庭成员】(全部采集的最后阶段,失败不阻塞)
 *   stage='family' → 扣除数据种子 + 家庭成员页逐卡片编辑读 关系/姓名/出生日期
 *   【导出】
 *   → doExport(transformPayload 重组 → EXPORT 消息)
 *
 * 用户交互:点扩展图标 → popup → 「开始采集」按钮发 START_TASK 消息到当前 tab。
 * 续采:页面刷新后 content 自动注入并 resume,无需用户操作(除非需手动登录)。
 */
(function () {
  'use strict';
  var T = window.__taxExport;
  var LIST = T.list;
  var DETAIL = T.detail;
  var INCOME = T.incomeTax;
  var FAMILY = T.family;
  var PAYLOAD = T.payload;

  var running = false;  // 防止重复启动
  var generation = 0;   // 任务代:RESET 时 ++,在途链检测到变化即停止

  /** 本次任务的年份偏移(负整数),由 popup「采集年份」传入。缺省用 utils 默认(=-4)。 */
  var pendingYearOffset = null;

  /** 当前任务是否已被取消(结束任务)。在途异步链在关键节点调用,取消则早退 */
  function cancelled(gen) { return gen !== generation; }

  /* ------------------------- 从 background 取/存进度 ------------------------- */

  function getJob() {
    return T.sendMessage({ type: 'GET_JOB' }).then(function (r) { return (r && r.job) || null; });
  }

  /* ------------------------- 状态机入口 ------------------------- */

  /** 主入口:由 popup「开始采集」或 content 启动时的续采检查触发 */
  function start() {
    if (running) { T.report('已有任务在运行', 'err'); return; }
    running = true;
    var gen = generation;
    T.setStatus('启动中');
    getJob()
      .then(function (job) {
        if (cancelled(gen)) return;  // 任务已被结束
        if (job && job.stage && job.stage !== 'done') {
          T.report('检测到未完成任务,从断点续采(stage=' + job.stage + ')');
          return resume(job, gen);
        }
        return runFresh(gen);
      })
      .then(function () { running = false; })
      .catch(function (e) {
        running = false;
        T.report('✗ 任务失败:' + (e && e.message || e), 'err');
        T.setStatus('失败');
      });
  }

  /* ------------------------- 全新任务:导航 → 列表 ------------------------- */

  function runFresh(gen) {
    // 年份偏移:优先用本次任务传入值,缺省回退 utils 默认(-4);写入 job 供跨刷新续采沿用
    var yearOffset = (pendingYearOffset != null) ? pendingYearOffset : T.DEDUCT_YEARS_OFFSET;
    var targetYM = T.targetStartMonthFor(yearOffset);
    var startedAt = new Date().toLocaleString();
    // 初始进度
    var job = { stage: 'navigating', phase: 'default', tab: '已完成', targetYM: targetYM, yearOffset: yearOffset, startedAt: startedAt, rows: [], total: 0, current: 0, details: [] };
    return T.saveJob(job)
      .then(function () {
        if (cancelled(gen)) return;
        T.report('开始采集 → 目标起始 ' + targetYM);
        // 1) 我要查询
        return T.waitFor(function () { return T.findByText('a.navbar-first-menu', '我要查询', false)[0]; })
          .then(function (menu) { if (cancelled(gen)) return; T.report('① 点击「我要查询」'); T.clickEl(menu); return T.sleep(2500); })
          // 2) 申报查询卡片
          .then(function () { if (cancelled(gen)) return; return T.waitFor(function () { return T.findCard('申报查询'); }); })
          .then(function (card) { if (cancelled(gen)) return; T.report('② 点击「申报查询」'); T.clickEl(card); return T.sleep(4000); })
          // 3) 等日期 input 出现
          .then(function () { if (cancelled(gen)) return; return T.waitFor(function () { return T.qsa('.el-date-editor input').length >= 2; }); })
          // 4) 默认视图先抓:不设日期条件,进页面自带约 2 年数据
          .then(function () { if (cancelled(gen)) return; T.report('③ 默认视图导出(不设日期条件)'); return LIST.prepareDefaultList('已完成'); })
          // 5) 提取列表(今年不采)
          .then(function () {
            if (cancelled(gen)) return;
            var curY = String(new Date().getFullYear());
            var rawRows = LIST.extractList();
            var rows = [], skipCur = 0;
            rawRows.forEach(function (r) {
              var y = PAYLOAD.yearOf(r['申报项目'] || '') || PAYLOAD.yearOf(r['税款所属期'] || '');
              if (y && y === curY) { skipCur++; return; }  // 今年(当前年)数据不采
              rows.push(r);
            });
            // 诊断:打印列表列名 + 首行,便于排查"应缴税款"取不到等列名不匹配问题
            if (rows.length) {
              T.report('④ 默认视图提取 ' + rows.length + ' 条(跳过今年 ' + skipCur + ' 条),列名:[' + Object.keys(rows[0]).join('/') + ']');
              T.report('  首行:' + Object.keys(rows[0]).map(function (k) { return k + '=' + rows[0][k]; }).join(' | '));
            } else {
              T.report('④ 默认视图提取 0 条(今年 ' + skipCur + ' 条已跳过)', 'err');
            }
            job.rows = rows;
            job.total = Math.min(rows.length, T.MAX_ROWS);
            job.phase = 'default';
            job.stage = 'list';
            return T.saveJob(job);
          })
          .then(function () { if (cancelled(gen)) return; return processList(job, gen); });
      });
  }

  /* ------------------------- 列表处理:逐条「查看」--------------------------
   * 这是会跨刷新的循环。每次:
   *   点查看(可能刷新) → 抓详情 → 存 detail → 返回列表(可能刷新)
   * 任何一步刷新后,content 重新注入,resume() 会根据 stage 接上。
   */

  function processList(job, gen) {
    // 已全部完成?
    if (cancelled(gen)) return;
    if (job.current >= job.total) {
      return exportAndFinish(job, gen);
    }
    var idx = job.current;
    var r = job.rows[idx] || {};
    T.report('  [' + (idx + 1) + '/' + job.total + '] ' + (r['申报项目'] || '').slice(0, 24) + ' | ' + (r['税款所属期'] || ''));
    T.setStatus('采集申报详情 ' + (idx + 1) + '/' + job.total);
    T.setProgress(idx, job.total);

    // 续采保险:idx>0 时,从详情返回后列表条件可能被重置,重新准备
    //   默认视图阶段:只点 tab 不设条件;条件/已作废阶段:完整重设日期+查询+tab
    var prep;
    if (job.phase === 'default') {
      prep = (idx === 0) ? Promise.resolve() : LIST.prepareDefaultList('已完成').catch(function () {});
    } else {
      prep = (idx === 0 && job.tab !== '已作废')
        ? Promise.resolve()
        : LIST.prepareList(job.targetYM, job.tab).catch(function () {});
    }
    return prep
      .then(function () {
        if (cancelled(gen)) return;
        // 点「查看」前,标记 stage=detail(若刷新,resume 应在详情页抓详情)
        job.stage = 'detail';
        return T.saveJob(job);
      })
      .then(function () {
        if (cancelled(gen)) return;
        // 传行对象:clickView 优先按 申报项目+税款所属期 文字匹配目标行(列表顺序可能乱)
        return LIST.clickView(idx, r);
      })
      .then(function () {
        if (cancelled(gen)) return;
        // 进入详情页,抓详情
        return captureAndStore(job, gen);
      });
  }

  /**
   * 在申报详情页抓详情,存入 job.details,然后返回列表。
   * 分两阶段以防页面刷新丢数据:
   *   阶段A(captureBasicAndTax):基础信息+计税详情,不点跨页按钮不刷新 → 抓完立即存 job.detailPartial
   *   阶段B(captureSalaryDetail):工资薪金明细,点详情按钮可能刷新 → 用 stage='detail-salary' 续采
   * 容错:任一阶段失败都保留已抓数据,不丢。
   */
  function captureAndStore(job, gen) {
    var idx = job.current;
    var r = job.rows[idx] || {};
    var tag = '[' + (idx + 1) + '/' + job.total + '] ' + (r['申报项目'] || '').slice(0, 16);
    var sec = {};  // 阶段A 累积结果
    return T.waitFor(function () { return T.isOnDetailPage(); }, 20000)
      .catch(function () { T.report('    ' + tag + ' 未进入申报详情页,仍尝试导出', 'err'); })
      .then(function () { if (cancelled(gen)) return; return T.sleep(2000); })
      // 阶段A:基础信息 + 计税详情(不刷新)
      // 瘦身:第一条(idx=0)抓全量基础信息;后续年度只抓汇算地(机关/单位),跳过重复的纳税人信息
      .then(function () { if (cancelled(gen)) return; return DETAIL.captureBasicAndTax(sec, idx > 0); })
      .then(function () {
        if (cancelled(gen)) return;
        // 立即存盘:即使阶段B刷新,阶段A数据已在 storage
        job.detailPartial = sec;
        return T.saveJob(job);
      })
      .then(function () {
        if (cancelled(gen)) return;
        var gotNames = Object.keys(sec).filter(function (k) { return sec[k] && !sec[k].error; });
        T.report('    ' + tag + ' 申报详情已采集(' + (gotNames.join('/') || '空') + ')', gotNames.length ? 'ok' : 'err');
      })
      // 标记 detail-salary,抓工资薪金明细(可能刷新 → resume 续采)
      .then(function () {
        if (cancelled(gen)) return;
        job.stage = 'detail-salary';
        return T.saveJob(job);
      })
      .then(function () { if (cancelled(gen)) return; return captureSalaryAndFinish(job, sec, tag, r, gen); });
  }

  /**
   * 申报详情收尾:面包屑「综合所得年度汇算（标准申报）」回年度汇算页 → 计税详情
   * → 专项附加扣除表单「详情」→ 标签页采集(赡养老人/子女教育/继续教育/婴幼儿照护)
   * → 组装完整 detail 存入 job.details。
   * 独立成函数:面包屑返回若整页刷新,续采(detail-deduct stage)从这里继续,不重采工资薪金。
   */
  function finishDetail(job, sec, tag, r, gen) {
    return DETAIL.returnToAnnualSettle()
      .then(function (back) {
        if (cancelled(gen)) return null;
        if (!back) return null;
        return DETAIL.captureDeductionTabs();
      })
      .then(function (tabs) {
        if (tabs) sec['专项附加扣除明细'] = tabs;
      })
      .catch(function (e) {
        T.report('    ' + tag + ' 专项附加扣除明细采集异常:' + (e && e.message || e), 'err');
      })
      .then(function () {
        // 组装完整 detail 存入 job.details
        var d = { _detail_sections: sec };
        d['_申报项目'] = r['申报项目'] || '';
        d['_税款所属期'] = r['税款所属期'] || '';
        d['_申报状态'] = r['申报状态'] || '';
        job.details.push(d);
        delete job.detailPartial;
        var gotNames = Object.keys(sec).filter(function (k) { return sec[k] && !sec[k].error; });
        T.report('    ' + tag + ' 申报详情完成(' + gotNames.join('/') + (sec['计税详情'] && sec['计税详情']['工资薪金明细'] ? '+工资薪金明细' : '') + ')', 'ok');
      });
  }

  /**
   * 抓工资薪金明细,合并到 sec,组装完整 detail 存入 job.details,返回列表。
   * 工资薪金采完先存盘并把 stage 推进到 'detail-deduct' —— 面包屑「综合所得年度汇算（标准申报）」
   * 返回年度汇算页可能整页刷新,续采从 finishDetail(专项附加扣除明细)继续,不会重采工资薪金。
   */
  function captureSalaryAndFinish(job, secIn, tag, r, gen) {
    var sec = secIn || job.detailPartial || {};
    return DETAIL.captureSalaryDetail()
      .then(function (result) {
        if (cancelled(gen)) return;
        // v4:result = {工资薪金:[...], 单独计税奖金金额:'...'};奖金明细由导出端派生(buildBonusDetailRows)
        if (result && sec['计税详情'] && !sec['计税详情'].error) {
          if (result.工资薪金 && result.工资薪金.length) sec['计税详情']['工资薪金明细'] = result.工资薪金;
          else T.report('    ' + tag + ' 工资薪金明细未抓到(跳过,该年无「详情」入口)');
        }
        // 总收入明细页头两金额:收入总额(计税汇总.收入=收入总额+单独计税奖金)与 单独计税奖金(③判定);阶段A失败也照存
        if (result && (result.收入总额 || result.单独计税奖金金额)) {
          if (!sec['计税详情'] || sec['计税详情'].error) sec['计税详情'] = {};
          if (result.收入总额) sec['计税详情']['收入总额'] = result.收入总额;
          if (result.单独计税奖金金额) sec['计税详情']['单独计税奖金'] = result.单独计税奖金金额;
        }
        // 存盘 + 推进 stage:刷新后续采走 detail-deduct(不重采工资薪金)
        job.detailPartial = sec;
        job.stage = 'detail-deduct';
        return T.saveJob(job).then(function () { return finishDetail(job, sec, tag, r, gen); });
      })
      .catch(function (e) {
        T.report('    ' + tag + ' 工资薪金明细导出异常:' + (e && e.message || e), 'err');
        // 仍保留阶段A 数据
        var d = { _detail_sections: sec };
        d['_申报项目'] = r['申报项目'] || '';
        d['_税款所属期'] = r['税款所属期'] || '';
        d['_申报状态'] = r['申报状态'] || '';
        job.details.push(d);
        delete job.detailPartial;
      })
      .then(function () { if (cancelled(gen)) return; return returnToListAndNext(job, gen); });
  }

  /** 申报详情收尾(公共):面包屑返回申报列表 → current++ → 继续下一条 */
  function returnToListAndNext(job, gen) {
    return Promise.resolve()
      .then(function () {
        if (cancelled(gen)) return;
        // 标记 returning,点面包屑返回列表
        job.stage = 'returning';
        return T.saveJob(job);
      })
      .then(function () {
        if (cancelled(gen)) return;
        return DETAIL.clickBreadcrumb('申报查询').then(function (ok) {
          if (!ok) { try { history.back(); } catch (e) {} }
          return T.sleep(2500);
        });
      })
      .then(function () {
        if (cancelled(gen)) return;
        // 已回到列表,current++,继续下一条
        job.current = job.current + 1;
        job.stage = 'list';
        return T.saveJob(job);
      })
      .then(function () { if (cancelled(gen)) return; return processList(job, gen); });
  }

  /* ------------------------- 申报完成:衔接专项附加扣除 -------------------------
   * 申报逐条详情抓完后不再直接导出,而是转入专项附加扣除阶段;两者都完成后统一导出。
   * 失败兜底:专项附加扣除任一步出错不阻塞,job.deduction=null,申报数据仍正常导出。
   */

  function exportAndFinish(job, gen) {
    if (cancelled(gen)) return;
    T.setProgress(job.total, job.total);
    // 默认视图采完 → 条件查询补采;条件查询采完 → 已作废补采;已作废采完 → 收入纳税明细(已预缴税额)
    if (job.phase === 'default') return startConditionalPhase(job, gen);
    if (job.tab !== '已作废') return startVoidedPhase(job, gen);
    T.report('申报采集完成:列表 ' + job.rows.length + ' 条(含条件查询与已作废补采) / 申报详情 ' + job.details.length + ' 条', 'ok');
    return startIncomeTaxPhase(job, gen);
  }

  /* ------------------------- 收入纳税明细查询:逐年读「已申报税额合计」→ 已预缴税额 -------------------------
   * 申报查询全部阶段(含已作废)采完后衔接。逐年设年度 → 读 .card-right「已申报税额合计」→
   * job.incomeTax[year];transformPayload 里覆盖 年度汇算[y].已预缴税额(退税记录口径仅作未采到年份兜底)。
   * 任一步失败只跳过该年/整阶段,不阻塞专项附加扣除与导出。
   */

  function startIncomeTaxPhase(job, gen) {
    if (cancelled(gen)) return;
    if (!job.incomeTax) job.incomeTax = {};
    if (!job.incomeTaxBonus) job.incomeTaxBonus = {};
    if (!job.incomeTaxMissing) job.incomeTaxMissing = {};
    if (!job.incomeTaxYear) job.incomeTaxYear = PAYLOAD.deductionYears(job)[0];
    T.setStatus('收入纳税明细查询:导航中');
    job.stage = 'incometax';
    return T.saveJob(job)
      .then(function () { if (cancelled(gen)) return; return INCOME.navigateToIncomeTax(); })
      .then(function (ok) {
        if (cancelled(gen)) return;
        if (!ok) {
          T.report('收入纳税明细查询跳过(已预缴税额沿用退税记录口径)', 'err');
          return startFamilyPhase(job, gen);
        }
        return processIncomeTaxYear(job, gen);
      });
  }

  function processIncomeTaxYear(job, gen) {
    if (cancelled(gen)) return;
    var years = PAYLOAD.deductionYears(job);
    if (job.incomeTaxYear > years[years.length - 1]) {
      return startFamilyPhase(job, gen);
    }
    var yi = years.indexOf(job.incomeTaxYear) + 1;
    // 申报查询缺失的年份 → 逐行「查看」按月汇算补采;
    // 已有申报数据的年份:当年无奖金 → 不执行该查询(用户规则)
    var missingYear = !yearInRows(job, job.incomeTaxYear);
    if (!missingYear && !yearHasBonus(job, job.incomeTaxYear)) {
      T.report('  [纳税明细 ' + yi + '/' + years.length + '] ' + job.incomeTaxYear + ' 无奖金,跳过');
      job.incomeTaxYear = job.incomeTaxYear + 1;
      return T.saveJob(job).then(function () { return processIncomeTaxYear(job, gen); });
    }
    T.setStatus('收入纳税明细 ' + yi + '/' + years.length + ' 年(' + job.incomeTaxYear + (missingYear ? ',缺失年补采' : '') + ')');
    return INCOME.setQueryYear(job.incomeTaxYear)
      .then(function (ok) {
        if (cancelled(gen)) return;
        if (!ok) return;  // 该年设置失败,跳过(已告警)
        if (missingYear) {
          // 缺失年:直接翻页遍历列表行(每行=当月明细)汇总
          return INCOME.collectMissingYear(job.incomeTaxYear).then(function (data) {
            if (cancelled(gen)) return;
            if (data) {
              job.incomeTaxMissing[String(job.incomeTaxYear)] = data;
              T.report('    缺失年 ' + job.incomeTaxYear + ' 按月汇算:' + data['月明细'].length + ' 行' +
                '(收入 ' + data['汇总']['收入'] + ' / 已申报税额 ' + data['汇总']['已申报税额'] + ')', 'ok');
            } else {
              T.report('    缺失年 ' + job.incomeTaxYear + ' 列表无该年数据', 'err');
            }
          });
        }
        return INCOME.waitDeclaredTaxTotal().then(function (v) {
          if (cancelled(gen)) return;
          if (v) {
            job.incomeTax[String(job.incomeTaxYear)] = v;
            T.report('    ' + job.incomeTaxYear + ' 已申报税额合计 ' + v + ' 元', 'ok');
          } else {
            T.report('    ' + job.incomeTaxYear + ' 已申报税额合计未读到', 'err');
          }
          // 翻页合并「全年一次性奖金」行的已申报税额 → 资薪奖金税额
          return INCOME.collectBonusDeclaredTax().then(function (bonusTax) {
            if (cancelled(gen)) return;
            if (bonusTax && bonusTax !== '0.00') job.incomeTaxBonus[String(job.incomeTaxYear)] = bonusTax;
          });
        });
      })
      .catch(function (e) { T.report('    ' + job.incomeTaxYear + ' 纳税明细采集失败:' + (e && e.message || e), 'err'); })
      .then(function () {
        if (cancelled(gen)) return;
        job.incomeTaxYear = job.incomeTaxYear + 1;
        return T.saveJob(job).then(function () { return processIncomeTaxYear(job, gen); });
      });
  }

  /** 申报查询列表里是否已有该年数据(默认视图+条件查询+已作废 全部 rows) */
  function yearInRows(job, year) {
    var y = String(year);
    return (job.rows || []).some(function (r) {
      return PAYLOAD.yearOf(r['申报项目'] || '') === y || PAYLOAD.yearOf(r['税款所属期'] || '') === y;
    });
  }

  /** 该年是否有奖金(单独计税奖金>0 或 工资薪金明细有「全年一次性奖金」行;复用 salaryBonusOf) */
  function yearHasBonus(job, year) {
    var y = String(year);
    var details = job.details || [];
    for (var i = 0; i < details.length; i++) {
      var d = details[i] || {};
      if (String(d['_申报项目'] || '').indexOf(y) === -1) continue;
      var tax = (d._detail_sections && d._detail_sections['计税详情']) || {};
      return PAYLOAD.salaryBonusOf(tax).amount > 0;
    }
    return false;
  }

  /** 条件查询补采:设「4 年前 1 月」日期条件 → 查询 → 提取列表 → 排除默认视图已采年份 → 并入 rows 继续逐条 */
  function startConditionalPhase(job, gen) {
    if (cancelled(gen)) return;
    T.setStatus('申报查询:条件查询补采');
    T.report('⑤ 条件查询补采(起始 ' + job.targetYM + ',跳过已采年份)');
    job.phase = 'cond';
    job.stage = 'cond';
    return T.saveJob(job)
      .then(function () { if (cancelled(gen)) return; return LIST.prepareList(job.targetYM, '已完成'); })
      .then(function () {
        if (cancelled(gen)) return;
        var rows = LIST.extractList();
        // 默认视图阶段已采年份集合 + 今年(今年数据一律不采);条件查询结果里同年份的行视为重复,跳过
        var doneYears = {};
        doneYears[new Date().getFullYear()] = 1;
        job.rows.forEach(function (r) {
          var y = PAYLOAD.yearOf(r['申报项目'] || '') || PAYLOAD.yearOf(r['税款所属期'] || '');
          if (y) doneYears[y] = 1;
        });
        var skip = 0;
        rows.forEach(function (r) {
          var y = PAYLOAD.yearOf(r['申报项目'] || '') || PAYLOAD.yearOf(r['税款所属期'] || '');
          if (y && doneYears[y]) { skip++; return; }
          job.rows.push(r);
        });
        job.total = Math.min(job.rows.length, T.MAX_ROWS);
        job.stage = 'list';
        T.report('    条件查询 ' + rows.length + ' 条:跳过已采年份 ' + skip + ' 条,补采 ' + (rows.length - skip) + ' 条');
        return T.saveJob(job).then(function () { return processList(job, gen); });
      })
      .catch(function (e) {
        T.report('条件查询补采失败,跳过(继续已作废补采):' + (e && e.message || e), 'err');
        return startVoidedPhase(job, gen);
      });
  }

  /** 已作废 tab 补采:提取列表 → 排除已完成阶段已采到的年份 → 并入 rows 继续逐条采集 */
  function startVoidedPhase(job, gen) {
    if (cancelled(gen)) return;
    T.setStatus('申报查询:已作废 tab');
    T.report('⑥ 补采「已作废」tab(跳过已采年份)');
    job.tab = '已作废';
    job.stage = 'voided';
    return T.saveJob(job)
      .then(function () { if (cancelled(gen)) return; return LIST.prepareList(job.targetYM, '已作废'); })
      .then(function () {
        if (cancelled(gen)) return;
        var rows = LIST.extractList();
        // 已采年份集合 + 今年(今年数据一律不采);已作废里同年份的行视为重复,跳过
        var doneYears = {};
        doneYears[new Date().getFullYear()] = 1;
        job.rows.forEach(function (r) {
          var y = PAYLOAD.yearOf(r['申报项目'] || '') || PAYLOAD.yearOf(r['税款所属期'] || '');
          if (y) doneYears[y] = 1;
        });
        var skip = 0;
        rows.forEach(function (r) {
          var y = PAYLOAD.yearOf(r['申报项目'] || '') || PAYLOAD.yearOf(r['税款所属期'] || '');
          r['申报状态'] = '已作废';
          if (y && doneYears[y]) { skip++; return; }
          job.rows.push(r);
        });
        job.total = Math.min(job.rows.length, T.MAX_ROWS);
        job.stage = 'list';
        T.report('    已作废 tab ' + rows.length + ' 条:跳过重复年份 ' + skip + ' 条,补采 ' + (rows.length - skip) + ' 条');
        return T.saveJob(job).then(function () { return processList(job, gen); });
      })
      .catch(function (e) {
        T.report('已作废 tab 补采失败,跳过(继续家庭成员采集):' + (e && e.message || e), 'err');
        return startFamilyPhase(job, gen);
      });
  }

  /* ------------------------- 家庭成员(最终阶段)→ 导出 ------------------------- */

  /** 全部采集完成后:先抓家庭成员(最终阶段),再统一导出 */
  function exportAllAndFinish(job, gen) {
    if (cancelled(gen)) return;
    return startFamilyPhase(job, gen);
  }

  /** 家庭成员:头像 → 个人信息管理 → 家庭成员信息 → 逐卡片编辑读 关系/姓名/出生日期 */
  function startFamilyPhase(job, gen) {
    if (cancelled(gen)) return;
    // 种子:专项附加扣除已查到的家庭成员(同名卡片将跳过;与页面采集合并输出)
    if (!job.familySeeded) {
      job.familyMembers = FAMILY.seedMembers(job);
      job.familySeeded = 1;
      job.familyIdx = 0;
    }
    if (!job.familyMembers) job.familyMembers = [];
    if (job.familyIdx == null) job.familyIdx = 0;
    if (job.familyMembers.length) T.report('家庭成员:扣除数据已有 ' + job.familyMembers.length + ' 位(同名跳过)');
    T.setStatus('家庭成员:导航中');
    job.stage = 'family';
    return T.saveJob(job)
      .then(function () { if (cancelled(gen)) return; return FAMILY.navigateToFamily(); })
      .then(function (ok) {
        if (cancelled(gen)) return;
        if (!ok) {
          T.report('家庭成员采集跳过(导航失败)', 'err');
          return doExport(job, gen);
        }
        return processFamilyMembers(job, gen);
      });
  }

  function processFamilyMembers(job, gen) {
    if (cancelled(gen)) return;
    var cards = T.qsa('li.family-member-info-card').filter(function (c) { return T.isVisible(c); });
    if (!cards.length) {
      T.report('家庭成员 0 条');
      return doExport(job, gen);
    }
    if (job.familyIdx >= cards.length) {
      T.report('家庭成员采集完成:' + job.familyMembers.length + ' 条', 'ok');
      return doExport(job, gen);
    }
    var ci = job.familyIdx;
    var card = cards[ci];
    T.report('  [家庭成员 ' + (ci + 1) + '/' + cards.length + ']');
    T.setStatus('家庭成员 ' + (ci + 1) + '/' + cards.length);
    var base = FAMILY.readCard(card);
    var cardName = String(base['姓名'] || '').trim();
    // 专项附加扣除已查到的同名成员:
    //   已含出生日期 → 跳过卡片;缺出生日期(如 子女教育表无该列) → 进编辑补采后合并回已有成员
    var dup = cardName && job.familyMembers.filter(function (m) {
      return String(m['姓名'] || '').trim() === cardName;
    })[0];
    if (dup && dup['出生日期']) {
      T.report('    ' + cardName + ' 已在扣除数据中(含出生日期),跳过');
      job.familyIdx = ci + 1;
      return T.saveJob(job).then(function () { return processFamilyMembers(job, gen); });
    }
    if (dup) T.report('    ' + cardName + ' 已在扣除数据中(缺出生日期),进编辑补采');
    return FAMILY.editAndRead(card)
      .then(function (fields) {
        if (cancelled(gen)) return;
        if (dup) {
          // 同名补采:合并回已有成员(只补缺失字段,不重复入册)
          if (!dup['关系'] && (fields && fields['关系'])) dup['关系'] = fields['关系'];
          if (!dup['出生日期'] && (fields && fields['出生日期'])) dup['出生日期'] = fields['出生日期'];
        } else {
          job.familyMembers.push({
            '姓名': (fields && fields['姓名']) || base['姓名'] || '',
            '关系': (fields && fields['关系']) || base['关系'] || '',
            '出生日期': (fields && fields['出生日期']) || ''
          });
        }
        job.familyIdx = ci + 1;
        return T.saveJob(job).then(function () { return processFamilyMembers(job, gen); });
      })
      .catch(function (e) {
        // 编辑失败兜底:卡片本身有 姓名/关系,仍入册(出生日期留空);同名已存在则不重复
        T.report('    家庭成员 #' + (ci + 1) + ' 编辑读取失败(' + (e && e.message || e) + '),按卡片信息入册', 'err');
        if (cardName && !dup) {
          job.familyMembers.push({
            '姓名': base['姓名'] || '',
            '关系': base['关系'] || '',
            '出生日期': ''
          });
        }
        job.familyIdx = ci + 1;
        return T.saveJob(job).then(function () { return processFamilyMembers(job, gen); });
      });
  }

  function doExport(job) {
    var payload = PAYLOAD.transform(job);
    T.report('⑧ 导出(按年度去重重组)');
    return T.sendMessage({ type: 'EXPORT', payload: payload, realName: PAYLOAD.realName(job), _ts: T.timestampStr() })
      .then(function () {
        var settle = payload.年度汇算 || {};
        var ycount = Object.keys(settle).length;
        // 扣除统计:从各年度的 专项附加扣除 数组汇总
        var dcount = 0, dyears = 0;
        Object.keys(settle).forEach(function (y) {
          var arr = (settle[y] && settle[y].专项附加扣除) || [];
          if (arr.length) { dyears++; dcount += arr.length; }
        });
        T.report('年度汇算:' + ycount + ' 个年度 / 纳税人 ' + ((payload.纳税人 && payload.纳税人.姓名) || '未知'), 'ok');
        if (dcount) T.report('专项附加扣除:' + dyears + ' 个年度 / ' + dcount + ' 条', 'ok');
        if (payload.家庭成员 && payload.家庭成员.length) T.report('家庭成员:' + payload.家庭成员.length + ' 条', 'ok');
        job.stage = 'done';
        return T.saveJob(job);
      })
      .then(function () {
        T.setStatus('已完成');
        T.report('✓ 全部完成', 'ok');
        return T.clearJob();
      });
  }

  /* ------------------------- 续采:根据 stage + 当前页面定位断点 ------------------------- */

  function resume(job, gen) {
    // 给页面一点渲染时间
    return T.sleep(1500).then(function () {
      if (cancelled(gen)) return;  // 任务已被结束
      var onDetail = T.isOnDetailPage();
      var onList = T.isOnListPage();
      var onDeductList = T.isOnDeductionListPage();
      var onDeductDetail = T.isOnDeductionDetailPage();

      /* --- 申报阶段断点 --- */
      if (job.stage === 'detail' && onDetail) {
        // 刷新前正要点「查看」/已进入申报详情页但还没抓 → 现在在申报详情页,直接抓
        T.report('续采:在申报详情页,导出第 ' + (job.current + 1) + ' 条申报详情(基础信息+计税详情)');
        return captureAndStore(job, gen);
      }
      if (job.stage === 'detail-salary') {
        // 阶段A(基础信息+计税详情)已抓完并存盘 job.detailPartial;现在抓工资薪金明细
        // 可能在收入明细页(刷新后)或申报详情页(未刷新)—— captureSalaryDetail 会处理
        var r = job.rows[job.current] || {};
        var stag = '[' + (job.current + 1) + '/' + job.total + '] ' + (r['申报项目'] || '').slice(0, 16);
        T.report('续采:导出第 ' + (job.current + 1) + ' 条工资薪金明细');
        return captureSalaryAndFinish(job, job.detailPartial, stag, r, gen);
      }
      if (job.stage === 'detail-deduct') {
        // 工资薪金已采完(含收入总额,已存盘 detailPartial);面包屑回年度汇算页刷新后从这里继续:
        // 专项附加扣除明细 → 组装入库(不重采工资薪金)→ 返回列表继续下一条
        var rd = job.rows[job.current] || {};
        var stagd = '[' + (job.current + 1) + '/' + job.total + '] ' + (rd['申报项目'] || '').slice(0, 16);
        T.report('续采:第 ' + (job.current + 1) + ' 条专项附加扣除明细(工资薪金已采完)');
        return finishDetail(job, job.detailPartial || {}, stagd, rd, gen)
          .then(function () { return returnToListAndNext(job, gen); });
      }
      if (job.stage === 'returning') {
        // 刷新前正在返回列表 → 现在可能已在列表页或申报详情页
        if (onList) {
          T.report('续采:已回到列表页,继续下一条');
          job.current = job.current + 1;
          job.stage = 'list';
          return T.saveJob(job).then(function () { return processList(job, gen); });
        }
        // 还在申报详情页,再次尝试返回
        T.report('续采:仍在申报详情页,重试点面包屑返回');
        return DETAIL.clickBreadcrumb('申报查询').then(function (ok) {
          if (!ok) { try { history.back(); } catch (e) {} }
          return T.sleep(2500).then(function () { return resume(job, gen); });
        });
      }
      if (job.stage === 'detail') {
        // 点查看后刷新,但现在判定不在申报详情页 → 可能列表页,重新点查看
        if (onList) {
          T.report('续采:回到列表页,重新点第 ' + (job.current + 1) + ' 条「查看」');
          return processList(job, gen);
        }
      }
      if (job.stage === 'cond') {
        // 条件查询补采中断:在列表页则重新提取(未存盘前重跑幂等),否则从头
        if (onList) {
          T.report('续采:继续条件查询补采');
          return startConditionalPhase(job, gen);
        }
        T.report('续采:不在申报列表页,从头开始');
        return runFresh(gen);
      }
      if (job.stage === 'family') {
        // 家庭成员阶段中断:已在家庭成员页则继续下一位,否则重新导航(已采存 job.familyMembers)
        if (FAMILY && FAMILY.isOnFamilyPage()) {
          T.report('续采:已在家庭成员页,继续第 ' + ((job.familyIdx || 0) + 1) + ' 位');
          return processFamilyMembers(job, gen);
        }
        T.report('续采:重新导航家庭成员');
        return startFamilyPhase(job, gen);
      }
      if (job.stage === 'incometax') {
        // 收入纳税明细查询中断:已在明细页则续当年,否则重新导航(已采年份存于 job.incomeTax)
        if (INCOME && INCOME.isOnIncomeTaxPage()) {
          T.report('续采:已在收入纳税明细查询页,继续年度 ' + job.incomeTaxYear);
          return processIncomeTaxYear(job, gen);
        }
        T.report('续采:重新导航收入纳税明细查询');
        return startIncomeTaxPhase(job, gen);
      }
      if (job.stage === 'voided') {
        // 已作废 tab 准备/提取中断:在列表页则重新提取(未存盘前重跑幂等),否则从头
        if (onList) {
          T.report('续采:继续「已作废」tab 补采');
          return startVoidedPhase(job, gen);
        }
        T.report('续采:不在申报列表页,从头开始');
        return runFresh(gen);
      }
      if (job.stage === 'list' || job.stage === 'navigating') {
        // 列表阶段断了 → 列表页则继续 processList,否则从头导航
        if (onList && job.rows && job.rows.length) {
          T.report('续采:在列表页,继续逐条采集');
          return processList(job, gen);
        }
        T.report('续采:无法定位,从头开始');
        return runFresh(gen);
      }

      /* --- 专项附加扣除阶段已移除(数据改由 年度汇算详情页·专项附加扣除明细 采集):旧断点直接进家庭成员 --- */
      if (job.stage === 'deduction-detail' || job.stage === 'deduction-returning' ||
          job.stage === 'deduction-year' || job.stage === 'deduction-navigating') {
        T.report('续采:专项附加扣除阶段已移除,进入家庭成员阶段');
        return startFamilyPhase(job, gen);
      }

      T.report('续采:未识别的状态(' + job.stage + '),从头开始', 'err');
      return runFresh(gen);
    });
  }

  /* ------------------------- 消息入口(来自 popup) ------------------------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'START_TASK') {
      // 采集年份:N(正整数,1~5)→ 偏移量 -N。校验非法/缺失回退默认 4 年。
      var n = parseInt(msg.yearOffset, 10);
      if (isNaN(n) || n < 1) n = 4;
      if (n > 5) n = 5;
      pendingYearOffset = -n;
      sendResponse({ ok: true });
      start();
    } else if (msg.type === 'RESET') {
      // 用户点「结束任务」:generation++ 让所有在途异步链在下一节点早退停止
      running = false;
      generation++;
      T.setStatus('就绪');
      T.setProgress(0, 0);
      sendResponse({ ok: true });
    }
  });

  /* ------------------------- 启动时的自动续采 -------------------------
   * 页面加载后 content 自动注入。若存在未完成任务,自动 resume(无需用户点 popup)。
   * 用一点延迟,避开页面刚加载时的渲染抖动。
   */
  setTimeout(function () {
    getJob().then(function (job) {
      if (job && job.stage && job.stage !== 'done') {
        T.report('页面加载,自动检查续采…');
        start();
      }
    });
  }, 2000);

})();
