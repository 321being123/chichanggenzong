const { pool } = require('../db/connection');

const STATEMENTS = {
  balance: { name:'资产负债表', sections:[
    ['资产概览',[['total_assets','资产总计'],['total_cur_assets','流动资产合计'],['total_nca','非流动资产合计']]],
    ['流动资产',[['money_cap','货币资金'],['trad_asset','交易性金融资产'],['accounts_receiv_bill','应收票据及应收账款'],['notes_receiv','应收票据',1,'accounts_receiv_bill'],['accounts_receiv','应收账款',1,'accounts_receiv_bill'],['oth_rcv_total','其他应收款合计'],['int_receiv','应收利息',1,'oth_rcv_total'],['div_receiv','应收股利',1,'oth_rcv_total'],['oth_receiv','其他应收款',1,'oth_rcv_total'],['prepayment','预付款项'],['inventories','存货'],['contract_assets','合同资产'],['hfs_assets','持有待售资产'],['nca_within_1y','一年内到期的非流动资产'],['oth_cur_assets','其他流动资产']]],
    ['非流动资产',[['lt_eqt_invest','长期股权投资'],['invest_real_estate','投资性房地产'],['debt_invest','债权投资'],['oth_debt_invest','其他债权投资'],['fix_assets_total','固定资产合计'],['fix_assets','固定资产',1,'fix_assets_total'],['fixed_assets_disp','固定资产清理',1,'fix_assets_total'],['cip_total','在建工程合计'],['cip','在建工程',1,'cip_total'],['const_materials','工程物资',1,'cip_total'],['intan_assets','无形资产'],['r_and_d','开发支出'],['goodwill','商誉'],['lt_amor_exp','长期待摊费用'],['defer_tax_assets','递延所得税资产'],['oth_nca','其他非流动资产']]],
    ['金融企业资产',[['cash_reser_cb','现金及存放中央银行款项'],['depos_in_oth_bfi','存放同业和其他金融机构款项'],['loanto_oth_bank_fi','拆出资金'],['pur_resale_fa','买入返售金融资产'],['client_depos','客户资金存款'],['client_prov','客户备付金'],['invest_as_receiv','应收款项类投资']]],
    ['负债概览',[['total_liab','负债合计'],['total_cur_liab','流动负债合计'],['total_ncl','非流动负债合计']]],
    ['流动负债',[['st_borr','短期借款'],['accounts_pay','应付票据及应付账款'],['notes_payable','应付票据',1,'accounts_pay'],['acct_payable','应付账款',1,'accounts_pay'],['adv_receipts','预收款项'],['contract_liab','合同负债'],['payroll_payable','应付职工薪酬'],['taxes_payable','应交税费'],['oth_pay_total','其他应付款合计'],['int_payable','应付利息',1,'oth_pay_total'],['div_payable','应付股利',1,'oth_pay_total'],['oth_payable','其他应付款',1,'oth_pay_total'],['non_cur_liab_due_1y','一年内到期的非流动负债'],['oth_cur_liab','其他流动负债']]],
    ['非流动负债',[['lt_borr','长期借款'],['bond_payable','应付债券'],['long_pay_total','长期应付款合计'],['lt_payable','长期应付款',1,'long_pay_total'],['specific_payables','专项应付款',1,'long_pay_total'],['estimated_liab','预计负债'],['defer_tax_liab','递延所得税负债'],['defer_inc_non_cur_liab','递延收益（非流动负债）'],['oth_ncl','其他非流动负债']]],
    ['金融企业负债',[['depos_ib_deposits','同业和其他金融机构存放款项'],['loan_oth_bank','拆入资金'],['trading_fl','交易性金融负债'],['sold_for_repur_fa','卖出回购金融资产款'],['depos','吸收存款'],['agency_bus_liab','代理业务负债']]],
    ['所有者权益',[['total_hldr_eqy_exc_min_int','归母股东权益'],['minority_int','少数股东权益'],['total_hldr_eqy_inc_min_int','所有者权益合计'],['cap_rese','资本公积'],['surplus_rese','盈余公积'],['undistr_porfit','未分配利润'],['treasury_share','库存股'],['oth_comp_income','其他综合收益']]],
    ['负债和权益总计',[['total_liab_hldr_eqy','负债和所有者权益总计']]]
  ]},
  income: { name:'利润表', sections:[
    ['营业收入',[['total_revenue','营业总收入'],['revenue','营业收入',1,'total_revenue'],['int_income','利息收入',1,'total_revenue'],['prem_earned','已赚保费',1,'total_revenue'],['comm_income','手续费及佣金收入',1,'total_revenue'],['n_commis_income','手续费及佣金净收入',1,'total_revenue'],['n_sec_tb_income','代理买卖证券业务净收入',1,'total_revenue'],['n_sec_uw_income','证券承销业务净收入',1,'total_revenue'],['n_asset_mg_income','受托客户资产管理业务净收入',1,'total_revenue'],['oth_b_income','其他业务收入',1,'total_revenue']]],
    ['营业成本及费用',[['total_cogs','营业总成本'],['oper_cost','营业成本',1,'total_cogs'],['int_exp','利息支出',1,'total_cogs'],['comm_exp','手续费及佣金支出',1,'total_cogs'],['biz_tax_surchg','税金及附加',1,'total_cogs'],['sell_exp','销售费用',1,'total_cogs'],['admin_exp','管理费用',1,'total_cogs'],['fin_exp','财务费用',1,'total_cogs'],['rd_exp','研发费用',1,'total_cogs'],['assets_impair_loss','资产减值损失',1,'total_cogs'],['credit_impa_loss','信用减值损失',1,'total_cogs'],['other_bus_cost','其他业务成本',1,'total_cogs']]],
    ['其他收益与损失',[['fv_value_chg_gain','公允价值变动收益'],['invest_income','投资收益'],['ass_invest_income','对联营和合营企业投资收益'],['forex_gain','汇兑收益']]],
    ['利润形成',[['operate_profit','营业利润'],['non_oper_income','营业外收入'],['non_oper_exp','营业外支出'],['nca_disploss','非流动资产处置净损失'],['total_profit','利润总额'],['income_tax','所得税费用'],['n_income','净利润'],['continued_net_profit','持续经营净利润',1,'n_income'],['n_income_attr_p','归母净利润',1,'n_income'],['minority_gain','少数股东损益',1,'n_income']]],
    ['综合收益',[['oth_compr_income','其他综合收益'],['t_compr_income','综合收益总额'],['compr_inc_attr_p','归母综合收益'],['compr_inc_attr_m_s','少数股东综合收益']]],
    ['每股及补充指标',[['basic_eps','基本每股收益'],['diluted_eps','稀释每股收益'],['ebit','息税前利润'],['ebitda','息税折旧摊销前利润'],['fin_exp_int_exp','财务费用中的利息费用'],['fin_exp_int_inc','财务费用中的利息收入']]]
  ]},
  cashflow: { name:'现金流量表', sections:[
    ['经营活动现金流入',[['c_inf_fr_operate_a','经营活动现金流入小计'],['c_fr_sale_sg','销售商品、提供劳务收到的现金',1,'c_inf_fr_operate_a'],['recp_tax_rends','收到的税费返还',1,'c_inf_fr_operate_a'],['c_fr_oth_operate_a','收到其他与经营活动有关的现金',1,'c_inf_fr_operate_a']]],
    ['经营活动现金流出',[['st_cash_out_act','经营活动现金流出小计'],['c_paid_goods_s','购买商品、接受劳务支付的现金',1,'st_cash_out_act'],['c_paid_to_for_empl','支付给职工以及为职工支付的现金',1,'st_cash_out_act'],['c_paid_for_taxes','支付的各项税费',1,'st_cash_out_act'],['oth_cash_pay_oper_act','支付其他与经营活动有关的现金',1,'st_cash_out_act'],['n_cashflow_act','经营活动现金流量净额']]],
    ['投资活动现金流',[['stot_inflows_inv_act','投资活动现金流入小计'],['c_recp_return_invest','收回投资收到的现金',1,'stot_inflows_inv_act'],['n_recp_disp_fiolta','处置长期资产收到的现金净额',1,'stot_inflows_inv_act'],['oth_recp_ral_inv_act','收到其他与投资活动有关的现金',1,'stot_inflows_inv_act'],['stot_out_inv_act','投资活动现金流出小计'],['c_pay_acq_const_fiolta','购建长期资产支付的现金',1,'stot_out_inv_act'],['c_paid_invest','投资支付的现金',1,'stot_out_inv_act'],['oth_pay_ral_inv_act','支付其他与投资活动有关的现金',1,'stot_out_inv_act'],['n_cashflow_inv_act','投资活动现金流量净额']]],
    ['筹资活动现金流',[['stot_cash_in_fnc_act','筹资活动现金流入小计'],['c_recp_cap_contrib','吸收投资收到的现金',1,'stot_cash_in_fnc_act'],['c_recp_borrow','取得借款收到的现金',1,'stot_cash_in_fnc_act'],['proc_issue_bonds','发行债券收到的现金',1,'stot_cash_in_fnc_act'],['oth_cash_recp_ral_fnc_act','收到其他与筹资活动有关的现金',1,'stot_cash_in_fnc_act'],['stot_cashout_fnc_act','筹资活动现金流出小计'],['c_prepay_amt_borr','偿还债务支付的现金',1,'stot_cashout_fnc_act'],['c_pay_dist_dpcp_int_exp','分配股利、利润或偿付利息支付的现金',1,'stot_cashout_fnc_act'],['oth_cashpay_ral_fnc_act','支付其他与筹资活动有关的现金',1,'stot_cashout_fnc_act'],['n_cash_flows_fnc_act','筹资活动现金流量净额']]],
    ['现金净变动',[['eff_fx_flu_cash','汇率变动对现金的影响'],['n_incr_cash_cash_equ','现金及现金等价物净增加额'],['c_cash_equ_beg_period','期初现金及现金等价物余额'],['c_cash_equ_end_period','期末现金及现金等价物余额'],['free_cashflow','企业自由现金流']]],
    ['现金流补充资料',[['net_profit','净利润'],['finan_exp','财务费用'],['prov_depr_assets','资产减值准备'],['depr_fa_coga_dpba','固定资产折旧等'],['amort_intang_assets','无形资产摊销'],['lt_amort_deferred_exp','长期待摊费用摊销'],['decr_inventories','存货减少'],['decr_oper_payable','经营性应收项目减少'],['incr_oper_payable','经营性应付项目增加'],['im_net_cashflow_oper_act','间接法经营活动现金流量净额']]]
  ]}
};

for (const definition of Object.values(STATEMENTS)) {
  definition.fields = definition.sections.flatMap(([section, fields]) => fields.map(([code,label,level=0,parent=null]) => [code,label,section,level,parent]));
}

function statementApiFields(type) {
  const definition = STATEMENTS[type];
  const metadata = ['ts_code','ann_date','f_ann_date','end_date','report_type','comp_type','update_flag'];
  return [...new Set(metadata.concat(definition ? definition.fields.map(([code]) => code) : []))].join(',');
}

function finite(value){if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;}

async function getStockStatements(tsCode,type='balance',limit=8){const definition=STATEMENTS[type];if(!definition)throw new Error('三表类型无效');const {rows}=await pool.query(`SELECT to_char(r.period_end,'YYYY') AS fiscal_year,to_char(r.announced_at,'YYYY-MM-DD') AS announced_at,r.raw_payload
  FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id
  WHERE i.canonical_code=$1 AND r.report_kind=$2 AND r.period_type='annual' AND r.is_current_version=true ORDER BY r.period_end DESC LIMIT $3`,[tsCode,type,Math.max(3,Math.min(20,Number(limit)||8))]);
  const periods=rows.map(row=>({year:row.fiscal_year,announced_at:row.announced_at||'',data:row.raw_payload||{}}));
  const visible=definition.fields.filter(([code])=>periods.some(period=>finite(period.data[code])!==null)),visibleCodes=new Set(visible.map(([code])=>code));
  const parentCodes=new Set(visible.map(([, , , ,parent])=>parent).filter(parent=>parent&&visibleCodes.has(parent)));
  const fields=visible.map(([code,label,section,level,parent])=>({code,label,section,level:parent&&visibleCodes.has(parent)?level:0,is_parent:parentCodes.has(code),unit:code.includes('eps')?'元':'亿元',values:periods.map((period,index)=>{const value=finite(period.data[code]),prior=finite(periods[index+1]?.data?.[code]);return {value:value==null?null:(code.includes('eps')?value:value/1e8),yoy:value==null||prior==null||prior===0?null:(value-prior)/Math.abs(prior)};})}));
  return {type,name:definition.name,periods:periods.map(({year,announced_at})=>({year,announced_at})),fields};}

module.exports={STATEMENTS,statementApiFields,getStockStatements};
