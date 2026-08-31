/**
 * content/mask.js —— 脱敏(导出前统一处理)
 *
 * 姓名/身份证/手机/邮箱/合同编号打码;公司/住址/机关/银行/学校只保留省级行政区或前2字(门牌号随地址丢弃)。
 * transformPayload(payload.js) 是导出 payload 的唯一出口,JSON 下载/PDF(含内嵌 JSON 附件)/历史缓存
 * 均经由 maskBy 覆盖;家庭成员种子(family.js)也复用本模块。
 *
 * 挂在 T.mask 下,不依赖其他模块,加载顺序在 payload/family/main 之前。
 */
(function () {
  'use strict';
  var T = window.__taxExport;

  /** 姓名:保留姓,其余打码(周杨→周*,周千又→周**) */
  function maskName(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return s;
    return s.charAt(0) + new Array(Math.min(s.length, 6)).join('*');
  }

  /** 身份证:18 位保留前 6(地区)后 4;其它长度保留前 4 后 2 */
  function maskId(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return s;
    if (s.length === 18) return s.slice(0, 6) + '********' + s.slice(-4);
    if (s.length > 6) return s.slice(0, 4) + '****' + s.slice(-2);
    return '****';
  }

  /** 手机:11 位 138****5678;其它保留前 2 后 2 */
  function maskPhone(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return s;
    if (/^\d{11}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(-4);
    return s.length > 4 ? s.slice(0, 2) + '****' + s.slice(-2) : '****';
  }

  /** 邮箱:本地部分与域名均只留首字符,保留顶级域(zhou.yang@example.com→z***@e***.com) */
  function maskEmail(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return s;
    var at = s.indexOf('@');
    if (at <= 0) return s.length > 2 ? s.slice(0, 1) + '***' : '***';
    var dom = s.slice(at + 1);
    var dot = dom.lastIndexOf('.');
    var tld = dot > 0 ? dom.slice(dot) : '';
    var dname = dot > 0 ? dom.slice(0, dot) : dom;
    return s.slice(0, 1) + '***@' + (dname ? dname.charAt(0) + '***' : '') + tld;
  }

  /** 合同编号:保留前4后2(2009渝银房贷字第611803号→2009****号);过短全打码 */
  function maskContract(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return s;
    return s.length > 6 ? s.slice(0, 4) + '****' + s.slice(-2) : '****';
  }

  /** 省级行政区提取:重庆市江北区…→重庆市;广东省深圳市…→广东省;深圳市…→深圳市;
   *  地区在中段的(如「国家税务总局重庆市…税务局」)也能提到重庆市;无特征→前2字+*** */
  function provinceOf(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return s;
    var m;
    if ((m = s.match(/^(.{2,8}?自治区)/)) || (m = s.match(/^(.{1,6}省)/))) return m[1];
    if ((m = s.match(/(北京|天津|上海|重庆)(市|省)?/))) return m[1] + '市';
    if ((m = s.match(/^(.{1,6}?市)/))) return m[1];
    if ((m = s.match(/(.{1,6}?市)/))) return m[1];
    return s.slice(0, 2) + '***';
  }

  /** 按字段名路由脱敏:命中规则即脱敏,未命中原样返回 */
  function maskBy(key, v) {
    var k = String(key || '');
    var s = String(v == null ? '' : v);
    if (!s) return s;
    if (/门牌/.test(k)) return '***';
    if (/姓名/.test(k)) return maskName(s);
    if (/身份证|证件号码|证号/.test(k)) return maskId(s);
    if (/合同编号/.test(k)) return maskContract(s);
    if (/手机|电话/.test(k)) return maskPhone(s);
    if (/邮箱|邮件/.test(k)) return maskEmail(s);
    if (/地址|坐落/.test(k)) return provinceOf(s);
    if (/单位|义务人|机关/.test(k)) return provinceOf(s);
    if (/银行/.test(k)) return s.length > 2 ? s.slice(0, 2) + '***' : '***';  // 中信银行→中信***
    if (/学校/.test(k)) return provinceOf(s);
    return s;
  }

  T.mask = {
    name: maskName,
    id: maskId,
    phone: maskPhone,
    email: maskEmail,
    contract: maskContract,
    province: provinceOf,
    by: maskBy
  };
})();
