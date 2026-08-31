/**
 * content/family.js —— 家庭成员信息采集(最终阶段)
 *
 * 流程:页面右上头像(.header-user-avatar)→ popover(.header-user-info-popover)
 *   →「个人信息管理」→ 页面内点「家庭成员信息」→ 逐个家庭成员卡片(li.family-member-info-card)
 *   → 点「编辑」开弹窗 → 读 关系/姓名/出生日期 → 关弹窗 → 下一个。
 *
 * 真机 DOM(2026-08 用户提供):
 *   头像:.header-user-avatar .header-user-thumb(el-popover__reference)
 *   popover:ul > li > a「个人信息管理」/「退出登录」
 *   卡片:li.family-member-info-card > p.family-name(姓名) + .option(关系：父母 / 证件类型 / 证件号码)
 *        + .btns > span「编辑」|「删除」
 * 编辑表单(真机 DOM 2026-08 校准):非弹窗,是页面内隐藏块
 *   div[display:none] > .family-members > form.el-form,点「编辑」后显示;
 *   字段 .el-form-item(label + input.value):他(她)是我的(select)→关系、证件号码、姓名、
 *   出生日期(禁用输入框,由证件号自动填入);表单内含滑块验证,但只读不提交,不受影响。
 * 任一步失败只跳过该成员/整阶段,不阻塞导出。
 */
(function () {
  'use strict';
  var T = window.__taxExport;
  var maskBy = T.mask.by;

  /** 是否在家庭成员信息页(存在家庭成员卡片) */
  function isOnFamilyPage() {
    return T.qsa('li.family-member-info-card').length > 0;
  }

  /** 可信点击(detail.js 的 realClick:CDP 优先 + 无导航 JS 兜底,瑞数页必需) */
  function rc(el) {
    return T.detail.realClick(el).catch(function () {});
  }

  /* ------------------------- 导航:头像 → 个人信息管理 → 家庭成员信息 ------------------------- */

  function navigateToFamily() {
    T.report('① 点击右上头像');
    return T.waitFor(function () {
      return T.qsa('.header-user-avatar .header-user-thumb, .header-user-avatar').filter(function (a) {
        return T.isVisible(a);
      })[0] || null;
    }, 8000)
      .then(function (avatar) { return rc(avatar); })
      .then(function () {
        // 等 popover 出现 → 点「个人信息管理」
        return T.waitFor(function () {
          return T.qsa('.header-user-info-popover a, .el-popover a').filter(function (a) {
            return (a.textContent || '').indexOf('个人信息管理') !== -1 && T.isVisible(a);
          })[0] || null;
        }, 6000);
      })
      .then(function (link) {
        T.report('② 点击「个人信息管理」');
        return rc(link).then(function () { return T.sleep(4000); });
      })
      .then(function () {
        // 进入个人信息管理页后,点「家庭成员信息」菜单(页面可能刷新后重注入,由 resume 续)
        T.report('③ 点击「家庭成员信息」');
        return T.waitFor(function () {
          var hits = T.findByText('a, li, span, div', '家庭成员信息', false).filter(function (el) {
            return T.isVisible(el) && (el.textContent || '').trim().length <= 20;  // 避开整页大容器
          });
          return hits[0] || null;
        }, 12000);
      })
      .then(function (menu) {
        return rc(menu).then(function () { return T.sleep(2500); });
      })
      .then(function () {
        // 等家庭成员卡片渲染(无成员/超时按 0 条处理,不阻塞)
        return T.waitFor(isOnFamilyPage, 8000).catch(function () { return false; });
      })
      .then(function () { T.report('已进入家庭成员信息'); return true; })
      .catch(function (e) {
        T.report('导航家庭成员失败:' + (e && e.message || e), 'err');
        return false;
      });
  }

  /* ------------------------- 卡片与编辑弹窗 ------------------------- */

  /** 读卡片基础信息:姓名(.family-name)+ .option 的「键：值」对 */
  function readCard(cardEl) {
    var out = {};
    var nm = T.qs('.family-name', cardEl);
    if (nm) out['姓名'] = (nm.textContent || '').trim();
    T.qsa('.option', cardEl).forEach(function (op) {
      var t = (op.textContent || '').replace(/\s+/g, '');
      var m = t.match(/^(.+?)[:：](.+)$/);
      if (m) out[m[1].trim()] = m[2].trim();
    });
    return out;
  }

  /** 当前可见的编辑表单(页面内隐藏块 div[display:none] > .family-members > form.el-form,
   *  点「编辑」后该 div 显示)。可见性按「任一祖先 display:none 即隐藏」判定,兼容打包器形态。 */
  function visibleForm() {
    var forms = T.qsa('form.el-form');
    for (var i = 0; i < forms.length; i++) {
      if (!T.isVisible(forms[i])) continue;
      var inFamily = false, p = forms[i];
      for (var j = 0; j < 5 && p; j++) {
        if (p.classList && p.classList.contains('family-members')) { inFamily = true; break; }
        p = p.parentElement;
      }
      if (inFamily) return forms[i];
    }
    return null;
  }

  /** DOM 里存在的编辑表单(无论显示与否)-- 用于诊断与「点编辑前」状态 */
  function anyFamilyForm() {
    return T.qsa('form.el-form').filter(function (f) {
      var p = f, hit = false;
      for (var j = 0; j < 5 && p; j++) {
        if (p.classList && p.classList.contains('family-members')) { hit = true; break; }
        p = p.parentElement;
      }
      return hit;
    })[0] || null;
  }

  /** 读编辑表单字段:.el-form-item(label + 值)。
   *  值来源优先级(对齐真机「修改家庭成员信息」子页 DOM,2026-08):
   *    ① input.value(禁用/普通;出生日期=证件号自动填入;证件号码=脱敏明文)
   *    ② select 已选项(.el-select .el-input__inner 的 value 或下拉 .selected 项文字)
   *    ③ input.placeholder(证件号码 真机为 placeholder=4****************5)
   *  他(她)是我的 → 关系;白名单只取 关系/姓名/出生日期。 */
  function readDialogFields() {
    var out = {};
    var form = visibleForm();
    if (!form) return out;
    T.qsa('.el-form-item', form).forEach(function (item) {
      if (!T.isVisible(item)) return;
      var lbl = T.qs('.el-form-item__label', item);
      var k = lbl ? (lbl.textContent || '').replace(/[：:\s]+/g, '') : '';
      if (!k) return;
      var v = '';
      // ① input.value(可见)
      var inputs = T.qsa('input, textarea', item);
      for (var i = 0; i < inputs.length; i++) {
        if (!T.isVisible(inputs[i])) continue;
        var s = String(inputs[i].value || '').trim();
        if (s && s.indexOf('请选择') === -1 && s.indexOf('请输入') === -1) { v = s; break; }
      }
      // ② select 已选项:下拉 .selected 项文字
      if (!v) {
        var selItem = T.qsa('.el-select-dropdown__item.selected', item).filter(T.isVisible)[0] ||
          T.qsa('.el-select-dropdown__item.selected', form).filter(T.isVisible)[0];
        if (selItem) v = (selItem.textContent || '').trim();
      }
      // ③ placeholder(证件号码等脱敏值)
      if (!v) {
        for (var j = 0; j < inputs.length; j++) {
          var ph = String(inputs[j].placeholder || '').trim();
          if (ph && ph.indexOf('请选择') === -1 && ph.indexOf('请输入') === -1) { v = ph; break; }
        }
      }
      if (v) {
        // 只取需要的三项(白名单):证件号码等敏感中间数据不入结果
        var key = (k === '他(她)是我的') ? '关系' : k;
        if (key === '关系' || key === '姓名' || key === '出生日期') out[key] = v;
      }
    });
    return out;
  }

  /** 收起编辑表单:点表单内「取消」按钮(可信点击;真机为「修改家庭成员信息」子页,点取消返回列表) */
  function closeDialog() {
    var form = visibleForm();
    if (!form) return T.sleep(300);
    var cancel = T.qsa('button', form).filter(function (b) {
      return (b.textContent || '').replace(/\s+/g, '') === '取消';
    })[0];
    if (cancel) {
      try { if (cancel.scrollIntoView) cancel.scrollIntoView({ block: 'center' }); } catch (e) {}
      rc(cancel);
    }
    return T.sleep(800);
  }

  /** 点卡片「编辑」-> 等表单显示 -> 读字段 -> 收起。返回 Promise<object|null>(null=无编辑按钮)。
   *  点击策略:滚动居中 -> 原生 click()(对齐 detail.js 翻页,瑞数兼容)-> realClick 兜底 -> 点卡片 li;
   *  未展开自动重试一轮,仍失败打 DOM 诊断(区分 点击没生效 / 表单结构变化)。 */
  function editAndRead(cardEl) {
    var editBtn = T.qsa('.btns span', cardEl).filter(function (s) {
      return (s.textContent || '').trim() === '编辑';
    })[0];
    if (!editBtn) return Promise.resolve(null);
    function clickEdit() {
      try { if (editBtn.scrollIntoView) editBtn.scrollIntoView({ block: 'center' }); } catch (e) {}
      return T.sleep(300).then(function () {
        try { editBtn.click(); return true; } catch (e) {}          // ① 原生 click
        return rc(editBtn).then(function () { return true; })        // ② CDP 可信点击
          .catch(function () { try { T.clickEl(cardEl); } catch (e2) {} return true; });  // ③ 卡片兜底
      });
    }
    return clickEdit()
      .then(function () {
        return T.waitFor(visibleForm, 6000).catch(function () {
          T.report('    编辑点击未展开表单,重试(可信点击+卡片兜底)', 'err');
          return rc(editBtn).then(function () { return T.sleep(500); })
            .then(function () { return T.waitFor(visibleForm, 6000); })
            .catch(function () {
              try { T.clickEl(cardEl); } catch (e) {}
              return T.waitFor(visibleForm, 6000);
            });
        });
      })
      .catch(function () {
        var form = anyFamilyForm();
        T.report('    编辑表单未展开(DOM 有表单:' + (form ? '是' : '否') + '),放弃该成员编辑', 'err');
        throw new Error('等待超时');
      })
      .then(function () { return T.sleep(1200); })
      .then(function () {
        var fields = readDialogFields();
        // 姓名 input 为空(修改页占位符 请输入):用点击前读到的卡片姓名兜底
        if (fields && !fields['姓名']) {
          var cardName = readCard(cardEl)['姓名'];
          if (cardName) fields['姓名'] = cardName;
        }
        return fields;
      })
      .then(function (fields) { return closeDialog().then(function () { return fields; }); });
  }

  /* ------------------------- 家庭成员种子(采集前)-------------------------
   * 从专项附加扣除数据提取已知家庭成员(子女教育/婴幼儿→子女;赡养老人→父母;明细段补出生日期)。
   * 赡养老人已改由 年度汇算详情页「专项附加扣除→详情」采集 → 从 job.details.赡养老人明细 种入父母(含出生日期)。
   * 家庭成员页同名者跳过重复采集,但与页面采集结果合并输出。
   */

  function seedMembers(job) {
    var out = [], seen = {};
    function add(name, rel) {
      name = String(name || '').trim();
      if (!name || seen[name]) return;
      seen[name] = 1;
      out.push({ '姓名': name, '关系': rel || '', '出生日期': '' });
    }
    ((job.deduction && job.deduction.记录) || []).forEach(function (c) {
      var proj = c['项目'] || '';
      if (proj.indexOf('子女教育') !== -1 || proj.indexOf('婴幼儿') !== -1) add(c['子女姓名'], '子女');
      else if (proj.indexOf('赡养') !== -1) add(c['被赡养人姓名'], '父母');
    });
    // 年度汇算详情页「专项附加扣除明细」标签数据 → 家庭成员种子:
    // 子女教育/婴幼儿照护 → 子女;赡养老人 → 父母(直接带出生日期,同名去重;兼容旧字段 赡养老人明细)
    ((job.details) || []).forEach(function (d) {
      var sec = (d && d._detail_sections) || {};
      var tabMap = sec['专项附加扣除明细'] || {};
      function seed(rows, rel) {
        rows.forEach(function (r) {
          var name = String(r['子女姓名'] || r['被赡养人姓名'] || r['姓名'] || '').trim();
          if (!name || seen[name]) return;
          seen[name] = 1;
          out.push({ '姓名': name, '关系': rel, '出生日期': String(r['出生日期'] || '').trim() });
        });
      }
      seed(tabMap['子女教育'] || [], '子女');
      seed(tabMap['3岁以下婴幼儿照护'] || [], '子女');
      seed(tabMap['赡养老人'] || sec['赡养老人明细'] || [], '父母');
    });
    // 明细段(教育信息/被赡养人信息)兜底补 出生日期
    ((job.deduction && job.deduction.明细) || []).forEach(function (m) {
      var sections = (m && m.sections) || {};
      Object.keys(sections).forEach(function (seg) {
        if (seg.indexOf('被赡养人') === -1 && seg.indexOf('教育信息') === -1) return;
        var kv = sections[seg] || {};
        var name = String(kv['姓名'] || kv['子女姓名'] || kv['被赡养人姓名'] || '').trim();
        var birth = kv['出生日期'] || '';
        if (!name || !birth) return;
        for (var i = 0; i < out.length; i++) {
          if (out[i]['姓名'] === name && !out[i]['出生日期']) out[i]['出生日期'] = birth;
        }
      });
    });
    return out;
  }

  T.family = {
    isOnFamilyPage: isOnFamilyPage,
    navigateToFamily: navigateToFamily,
    readCard: readCard,
    readDialogFields: readDialogFields,
    editAndRead: editAndRead,
    seedMembers: seedMembers
  };
})();
