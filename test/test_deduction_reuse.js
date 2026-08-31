/**
 * 回归:申报详情全链编排(工资薪金→返回年度汇算→专项附加扣除标签页)+ 家庭成员种子
 * 2024/2025 两条申报,每年:
 *   captureSalaryDetail → returnToAnnualSettle → captureDeductionTabs(赡养老人+子女教育)
 * 期望:
 *   1. 每条申报进详情页 1 次(clickView),调用顺序严格 view→salary→return→deduct,逐年不串
 *   2. 标签页数据下沉为该年 专项附加扣除 条目(姓名脱敏)
 *   3. 家庭成员种子:赡养老人→父母(带出生日期)、子女教育→子女
 *   4. 收入纳税明细/家庭成员导航跳过不影响导出
 */
'use strict';
var path = require('path');
var BASE = path.join(__dirname, '..', 'content');
var seq = [];
var exportPayload = null;
var listCalls = { default: 0, cond: 0, voided: 0 };
var TABS_BY_YEAR = {
  2024: {
    '赡养老人': [{ '被赡养人姓名': '杨院利', '出生日期': '1964-05-15', '是否独生子女': '否', '分摊方式': '赡养人约定分摊', '本年度月扣除金额': '1000.00' }],
    '子女教育': [{ '子女姓名': '周千又', '当前受教育阶段': '高中阶段教育', '当前受教育阶段开始时间/结束时间': '2022-09-01/2025-06-30', '分配比例': '100%' }]
  },
  2025: {
    '赡养老人': [{ '被赡养人姓名': '杨院利', '出生日期': '1964-05-15', '是否独生子女': '否', '分摊方式': '赡养人约定分摊', '本年度月扣除金额': '1000.00' }],
    '子女教育': [{ '子女姓名': '周千又', '当前受教育阶段': '高中阶段教育', '当前受教育阶段开始时间/结束时间': '2025-09-01/2028-06-30', '分配比例': '100%' }]
  }
};
function yearOfRow(r) { return (String(r['申报项目'] || '').match(/(20\d{2})/) || [])[1]; }
var T = {
  report: function (m, lv) { if (process.env.VERBOSE) console.log('[' + (lv || 'log') + '] ' + m); },
  setStatus: function () {}, setProgress: function () {},
  timestampStr: function () { return 'TS'; },
  sleep: function () { return Promise.resolve(); },
  waitFor: function (fn) { var v = fn(); return v ? Promise.resolve(v) : Promise.reject(new Error('waitFor')); },
  findByText: function () { return [{}]; }, findCard: function () { return {}; },
  qsa: function (s) { return s.indexOf('.el-date-editor') === 0 ? [{}, {}] : []; },
  qs: function () { return null; }, clickEl: function () {},
  sendMessage: function (m) {
    if (m.type === 'GET_JOB') return Promise.resolve({ job: null });
    if (m.type === 'EXPORT') { exportPayload = m.payload; return Promise.resolve({ ok: true }); }
    return Promise.resolve({ ok: true });
  },
  saveJob: function () { return Promise.resolve(); }, clearJob: function () { return Promise.resolve(); },
  isOnListPage: function () { return false; }, isOnDetailPage: function () { return true; },
  MAX_ROWS: 50, DEDUCT_YEARS_OFFSET: -3,
  targetStartMonthFor: function (o) { return (2026 + o) + '-01'; },
  list: {
    prepareDefaultList: function () { listCalls.default++; return Promise.resolve(); },
    prepareList: function (ym, tab) { if (tab === '已作废') listCalls.voided++; else listCalls.cond++; return Promise.resolve(); },
    extractList: function () {
      // 默认视图 2 条;条件查询/已作废 0 条
      if (listCalls.default > 0 && listCalls.cond === 0 && listCalls.voided === 0) {
        return [
          { '申报项目': '2024年度综合所得年度汇算', '税款所属期': '2024-01-01至2024-12-31', '申报状态': '已完成', '应缴税款(元)': '100' },
          { '申报项目': '2025年度综合所得年度汇算', '税款所属期': '2025-01-01至2025-12-31', '申报状态': '已完成', '应缴税款(元)': '120' }
        ];
      }
      return [];
    },
    clickView: function (idx, r) { seq.push('view:' + yearOfRow(r)); return Promise.resolve(); }
  },
  detail: {
    captureBasicAndTax: function (sec) {
      sec['基础信息'] = { kv: { '个人基础信息': '周杨' } };
      sec['计税详情'] = {
        收入表: [{ '分类': '收入', '项目': '工资薪金', '金额(元)': '100' }],
        汇总: { '收入': '100元', '已缴税额': '692.46元' },
        工资薪金明细: [{ '税款所属期': '2024-12', '所得项目小类': '正常工资薪金', '扣缴义务人': '重庆玖奇科技有限公司', '收入(元)': '60.00', '状态': '正常' }]
      };
      return Promise.resolve();
    },
    captureSalaryDetail: function () { seq.push('salary'); return Promise.resolve({ 工资薪金: [], 单独计税奖金金额: '', 收入总额: '' }); },
    returnToAnnualSettle: function () { seq.push('return'); return Promise.resolve(true); },
    captureDeductionTabs: function () {
      var y = 0;
      for (var i = seq.length - 1; i >= 0; i--) {
        var m = seq[i].match(/^view:(20\d{2})$/);
        if (m) { y = parseInt(m[1], 10); break; }
      }
      seq.push('deduct:' + y);
      return Promise.resolve(TABS_BY_YEAR[y]);
    },
    clickBreadcrumb: function () { return Promise.resolve(true); }
  },
  incomeTax: {
    isOnIncomeTaxPage: function () { return false; },
    navigateToIncomeTax: function () { return Promise.resolve(false); },
    setQueryYear: function () { return Promise.resolve(false); },
    waitDeclaredTaxTotal: function () { return Promise.resolve(''); },
    collectMissingYear: function () { return Promise.resolve(null); },
    collectBonusDeclaredTax: function () { return Promise.resolve(''); }
  }
};
global.window = { __taxExport: T };
global.chrome = { runtime: { onMessage: { addListener: function (fn) { listeners.push(fn); } } } };
var listeners = [];
require(path.join(BASE, 'mask.js'));     // 真实脱敏
require(path.join(BASE, 'payload.js'));  // 真实 payload 重组
require(path.join(BASE, 'family.js'));   // 真实家庭成员(保留 seedMembers)
// 家庭成员阶段:仅跳过页面导航,保留种子逻辑
T.family.navigateToFamily = function () { return Promise.resolve(false); };
T.family.readCard = function () { return {}; };
T.family.editAndRead = function () { return Promise.resolve(null); };
require(path.join(BASE, 'main.js'));

listeners.forEach(function (fn) { fn({ type: 'START_TASK', yearOffset: 3 }, {}, function () {}); });
setTimeout(function () {
  var fails = [];
  function check(c, m) { if (!c) fails.push(m); else console.log('  ✓ ' + m); }
  check(seq.join(',') === 'view:2024,salary,return,deduct:2024,view:2025,salary,return,deduct:2025',
    '编排顺序 view→salary→return→deduct 逐年不串(实=' + seq.join(',') + ')');
  var settle = exportPayload && exportPayload['年度汇算'];
  var d2024 = (settle && settle['2024'] && settle['2024']['专项附加扣除']) || [];
  var d2025 = (settle && settle['2025'] && settle['2025']['专项附加扣除']) || [];
  check(d2024.length === 2 && d2025.length === 2, '专项附加扣除逐年下沉 2+2 条(实=' + d2024.length + '+' + d2025.length + ')');
  var eld = d2024.filter(function (it) { return it['项目'] === '赡养老人'; })[0];
  check(eld && eld['被赡养人姓名'] === '杨**' && eld['申报月数'] === 8 && eld['明细']['被赡养人信息']['出生日期'] === '1964-05-15',
    '赡养老人下沉+脱敏+申报月数 8(2024 满60当月起 5~12 月)(实=' + JSON.stringify(eld) + ')');
  var edu = d2025.filter(function (it) { return it['项目'] === '子女教育'; })[0];
  check(edu && edu['子女姓名'] === '周**' && edu['申报月数'] === 4,
    '子女教育 2025(9~12 月)申报月数 4(实=' + JSON.stringify(edu) + ')');
  var fam = (exportPayload && exportPayload['家庭成员']) || [];
  var parents = fam.filter(function (m) { return m['关系'] === '父母'; });
  var kids = fam.filter(function (m) { return m['关系'] === '子女'; });
  check(parents.length === 1 && parents[0]['出生日期'] === '1964-05-15' && parents[0]['姓名'] === '杨**',
    '家庭成员种子:赡养老人→父母(带出生日期,姓名脱敏)(实=' + JSON.stringify(parents) + ')');
  check(kids.length === 1 && kids[0]['姓名'] === '周**', '家庭成员种子:子女教育→子女(实=' + JSON.stringify(kids) + ')');
  check(JSON.stringify(exportPayload).indexOf('杨院利') === -1 && JSON.stringify(exportPayload).indexOf('周千又') === -1,
    '导出 JSON 无明文姓名');
  console.log(fails.length ? '✗ 失败:\n  - ' + fails.join('\n  - ') : '✓ 全部通过');
  process.exit(fails.length ? 1 : 0);
}, 1500);
