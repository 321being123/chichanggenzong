// 反馈 #46 追加回归：交易录入后的定点收盘价补齐与现金结算 409 解耦。
// 覆盖：本账户已有确认价但仍核对共享冲突、跨账户共享复用、两边都缺时单证券单日取价、
// 证据不足/冲突/无净值行不阻塞交易、当天交易交给现有收盘流程、港股 5/6 位别名、
// 现金收益结算 409 有限重试后立即返回待重算且不读写净值，以及前端手工录入的账户切换守卫。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  ensureTradeClosePrice,
  settleCashIncomeForRecompute,
  recomputeNav,
  selectBackfillRows,
} = require('../jobs/replayNav');

const root = path.resolve(__dirname, '../..');
const BOND = '119999';
const TRADE_DATE = '2026-11-20';
const TODAY = '2026-11-22';

function priceRow(overrides = {}) {
  return {
    date: TRADE_DATE,
    code: BOND,
    market: 'CN',
    price: 101,
    quality: 'confirmed',
    is_final: true,
    source: 'history_backfill:tushare',
    evidence: {},
    ...overrides,
  };
}

function noopCounters() {
  return { own: 0, shared: 0, save: 0, backfill: 0 };
}

(async () => {
  // 1) 本账户已有 exact confirmed+final：仍要读共享做同日冲突核对，但不补价、不写库。
  {
    const calls = noopCounters();
    const result = await ensureTradeClosePrice('u1', 'A', {
      code: BOND, subtype: '沪市', tradeDate: TRADE_DATE,
    }, {
      today: TODAY,
      expectedCloseDate: async () => TRADE_DATE,
      readOwn: async () => { calls.own++; return [priceRow()]; },
      readShared: async () => { calls.shared++; return []; },
      savePrice: async () => { calls.save++; return [{ written: true }]; },
      backfill: async () => { calls.backfill++; return true; },
    });
    assert.strictEqual(result.status, 'already');
    assert.strictEqual(result.closeDate, TRADE_DATE);
    assert.strictEqual(calls.shared, 1, '本账户已有确认价也必须读共享核对同日冲突');
    assert.strictEqual(calls.save + calls.backfill, 0);
  }

  // 休市补录保留账本成交日，取价目标由市场日历确定。
  {
    const tradeDate = '2026-11-21';
    const result = await ensureTradeClosePrice('u1', 'A', { code: BOND, tradeDate }, {
      today: TODAY,
      expectedCloseDate: async (market, date) => {
        assert.strictEqual(market, 'CN');
        assert.strictEqual(date, tradeDate);
        return TRADE_DATE;
      },
      readOwn: async ({ date }) => {
        assert.strictEqual(date, TRADE_DATE);
        return [priceRow()];
      },
      readShared: async () => [],
    });
    assert.strictEqual(result.tradeDate, tradeDate);
    assert.strictEqual(result.closeDate, TRADE_DATE);
  }

  // 2) 第二个账户同证券同成交日：直接复用其它账户公开确认价，不再发起网络取价。
  {
    const calls = noopCounters();
    let saved = null;
    const sharedRow = priceRow({
      price: 101.25, username: 'u2', account_name: 'B',
      evidence: {
        origin: 'daily_bar_history', price_adjust: 'none', qualification: 'unadjusted',
        internalAccountNote: 'must-not-copy', rawAccountId: 'secret-id',
      },
    });
    const result = await ensureTradeClosePrice('u1', 'B', {
      code: BOND, subtype: '沪市', tradeDate: TRADE_DATE,
    }, {
      today: TODAY,
      expectedCloseDate: async () => TRADE_DATE,
      readOwn: async () => { calls.own++; return []; },
      readShared: async (params) => {
        calls.shared++;
        assert.strictEqual(params.username, 'u1');
        assert.strictEqual(params.accountName, 'B');
        assert.deepStrictEqual(params.codes, [BOND]);
        return [sharedRow];
      },
      savePrice: async (row) => { calls.save++; saved = row; return [{ written: true }]; },
      backfill: async () => { calls.backfill++; return true; },
    });
    assert.strictEqual(result.status, 'reused');
    assert.strictEqual(result.source, 'history_backfill:tushare');
    assert.strictEqual(calls.backfill, 0, '共享价命中后不得重复网络取价');
    assert.strictEqual(calls.save, 1);
    assert.strictEqual(saved.quality, 'confirmed');
    assert.strictEqual(saved.is_final, true);
    assert.strictEqual(saved.market, 'CN');
    assert.strictEqual(saved.evidence.price_adjust, 'none', '保留公开复权口径');
    assert.strictEqual(saved.evidence.qualification, 'unadjusted', '保留公开资格字段');
    assert.strictEqual(saved.evidence.internalAccountNote, undefined, '不得复制共享账户内部证据');
    assert.strictEqual(saved.evidence.rawAccountId, undefined, '不得复制共享账户内部标识');
    assert.strictEqual(saved.evidence.shared_close_reuse.basis, 'same_market_code_expected_close');
  }

  // 3) 两边都真缺：只按该证券该成交日调用一次 backfillDailyPrices，且只接受可核实终盘。
  {
    let ownRows = [];
    let backfillCall = null;
    let backfillCount = 0;
    const result = await ensureTradeClosePrice('u1', 'A', {
      code: BOND, subtype: '沪市', tradeDate: TRADE_DATE,
    }, {
      today: TODAY,
      expectedCloseDate: async () => TRADE_DATE,
      readOwn: async () => ownRows,
      readShared: async () => [],
      savePrice: async () => [{ written: true }],
      backfill: async (username, accountName, code, start, end, position, options) => {
        backfillCount++;
        backfillCall = { username, accountName, code, start, end, position, options };
        ownRows = [priceRow({ source: 'history_backfill:tushare' })];
        return true;
      },
    });
    assert.strictEqual(result.status, 'fetched');
    assert.strictEqual(backfillCount, 1, '真缺时只发起一次定点取价');
    assert.deepStrictEqual(backfillCall, {
      username: 'u1', accountName: 'A', code: BOND,
      start: TRADE_DATE, end: TRADE_DATE,
      position: { code: BOND, subtype: '沪市', tradeDate: TRADE_DATE },
      options: { qualifiedOnly: true, businessDate: TRADE_DATE },
    }, '补价范围必须收敛到成交日对应收盘日，并只接受 qualified 行');
  }

  // 3b) 两账户同证券先后录入：第一个账户真缺取价一次，第二个账户直接复用共享价、零外采。
  {
    const sharedStore = [];
    let backfillCount = 0;
    const first = await ensureTradeClosePrice('u1', 'A', {
      code: BOND, subtype: '沪市', tradeDate: TRADE_DATE,
    }, {
      today: TODAY,
      expectedCloseDate: async () => TRADE_DATE,
      readOwn: async () => sharedStore,
      readShared: async () => [],
      backfill: async () => {
        backfillCount++;
        sharedStore.push(priceRow({ source: 'history_backfill:tushare' }));
        return true;
      },
    });
    const second = await ensureTradeClosePrice('u1', 'B', {
      code: BOND, subtype: '沪市', tradeDate: TRADE_DATE,
    }, {
      today: TODAY,
      expectedCloseDate: async () => TRADE_DATE,
      readOwn: async () => [],
      readShared: async () => sharedStore,
      savePrice: async () => [{ written: true }],
      backfill: async () => { backfillCount++; return true; },
    });
    assert.strictEqual(first.status, 'fetched');
    assert.strictEqual(second.status, 'reused');
    assert.strictEqual(backfillCount, 1, '第二个账户复用共享价时不得再次外采');
  }

  // 4) 取价失败/无数据：交易已保存，补价返回 pending 而不是抛错。
  {
    const result = await ensureTradeClosePrice('u1', 'A', {
      code: BOND, subtype: '沪市', tradeDate: TRADE_DATE,
    }, {
      today: TODAY,
      expectedCloseDate: async () => TRADE_DATE,
      readOwn: async () => [],
      readShared: async () => [],
      savePrice: async () => [{ written: true }],
      backfill: async () => false,
    });
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.reason, 'history_close_unavailable');
  }

  // 5) 当天/未来交易：尊重现有收盘流程，不写盘中候选价。
  {
    const calls = noopCounters();
    const result = await ensureTradeClosePrice('u1', 'A', {
      code: BOND, subtype: '沪市', tradeDate: TODAY,
    }, {
      today: TODAY,
      expectedCloseDate: async () => { calls.shared++; return TODAY; },
      readOwn: async () => { calls.own++; return []; },
      readShared: async () => { calls.shared++; return []; },
      savePrice: async () => { calls.save++; return [{ written: true }]; },
      backfill: async () => { calls.backfill++; return true; },
    });
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.reason, 'today_close_flow');
    assert.strictEqual(calls.own + calls.shared + calls.save + calls.backfill, 0);
  }

  // 6) 其它账户同日 confirmed 价格冲突：不选价、不写库、不补价。
  {
    const calls = noopCounters();
    const result = await ensureTradeClosePrice('u1', 'A', {
      code: BOND, subtype: '沪市', tradeDate: TRADE_DATE,
    }, {
      today: TODAY,
      expectedCloseDate: async () => TRADE_DATE,
      readOwn: async () => { calls.own++; return []; },
      readShared: async () => { calls.shared++; return [priceRow(), priceRow({ price: 102, username: 'u3', account_name: 'C' })]; },
      savePrice: async () => { calls.save++; return [{ written: true }]; },
      backfill: async () => { calls.backfill++; return true; },
    });
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.reason, 'shared_close_conflict');
    assert.strictEqual(calls.save + calls.backfill, 0);
  }

  // 7) 本账户只有 confirmed 但非 final：保持待补，不能让共享候选/网络结果冒充终盘。
  {
    const result = await ensureTradeClosePrice('u1', 'A', {
      code: BOND, subtype: '沪市', tradeDate: TRADE_DATE,
    }, {
      today: TODAY,
      expectedCloseDate: async () => TRADE_DATE,
      readOwn: async () => [priceRow({ is_final: null })],
      readShared: async () => [priceRow()],
      savePrice: async () => [{ written: true }],
      backfill: async () => true,
    });
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.reason, 'local_close_not_final');
  }

  // 8) 港股 5/6 位别名：同一市场身份一起查询，不跨市场串价。
  {
    let seenCodes = null;
    const result = await ensureTradeClosePrice('u1', 'A', {
      code: '00001', subtype: '港股', tradeDate: TRADE_DATE,
    }, {
      today: TODAY,
      expectedCloseDate: async (market) => { assert.strictEqual(market, 'HK'); return TRADE_DATE; },
      readOwn: async (params) => { seenCodes = params.codes; return [priceRow({ code: '00001', market: 'HK' })]; },
      readShared: async () => [],
      savePrice: async () => [{ written: true }],
      backfill: async () => true,
    });
    assert.strictEqual(result.status, 'already');
    assert.deepStrictEqual(seenCodes, ['00001', '000001']);
  }

  // 9) 现金收益结算 409：在最新状态有限重试一次，成功后继续净值重算。
  {
    let attempts = 0;
    const result = await settleCashIncomeForRecompute(async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('账户版本已变化，请重试'), { status: 409 });
      return { status: 'calculated', changed: 2, navUpdated: 1 };
    }, 'u1', 'A');
    assert.strictEqual(result.status, 'calculated');
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(attempts, 2);
  }

  // 10) 连续 409：包装器返回可报告失败；recomputeNav 据此立即 pending，不再继续写净值。
  {
    let attempts = 0;
    const result = await settleCashIncomeForRecompute(async () => {
      attempts++;
      throw Object.assign(new Error('账户版本已变化，请重试'), { status: 409 });
    }, 'u1', 'A');
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.reason, 'version_conflict');
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(attempts, 2);
  }

  // 11) 授权失败必须原样抛出，不能被包装成“待重试”吞掉。
  {
    let attempts = 0;
    await assert.rejects(
      () => settleCashIncomeForRecompute(async () => {
        attempts++;
        throw Object.assign(new Error('forbidden'), { status: 403 });
      }, 'u1', 'A'),
      error => error && error.status === 403
    );
    assert.strictEqual(attempts, 1, '非版本冲突不得重试');
  }

  // 11a) 非授权、非 409 的结算失败：返回结构化 pending，仍不进入净值读写。
  {
    const settlement = await settleCashIncomeForRecompute(async () => {
      throw Object.assign(new Error('db down'), { status: 500 });
    }, 'u1', 'A');
    assert.strictEqual(settlement.status, 'failed');
    assert.strictEqual(settlement.reason, 'settlement_failed');
    assert.strictEqual(settlement.httpStatus, 500);
    let loads = 0;
    const result = await recomputeNav('u1', 'A', TRADE_DATE, {
      settleCashIncome: async () => {
        throw Object.assign(new Error('db down'), { status: 500 });
      },
      loadAccountData: async () => { loads++; return { navHistory: [], trades: [], cashFlows: [] }; },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.reason, 'cash_settlement_failed');
    assert.strictEqual(loads, 0);
  }

  // 11b) recomputeNav 连续 409：立即返回 pending/ok=false，未进入净值读取或写入。
  {
    let loads = 0;
    const result = await recomputeNav('u1', 'A', TRADE_DATE, {
      settleCashIncome: async () => {
        throw Object.assign(new Error('账户版本已变化，请重试'), { status: 409 });
      },
      loadAccountData: async () => {
        loads++;
        return { navHistory: [{ date: TRADE_DATE, nav: 1, totalAsset: 100 }], trades: [], cashFlows: [] };
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.reason, 'cash_settlement_conflict');
    assert.strictEqual(result.cashSettlement.attempts, 2);
    assert.strictEqual(result.days, 0);
    assert.strictEqual(loads, 0, '结算失败后不得读取/重放净值，也不得清除 nav_dirty_from');
    assert.deepStrictEqual(result.warnings, ['cash_settlement_conflict'], '同一原因只保留一条警告');
  }

  // 11c) 现金收益结算明确 partial：同样立即返回待重算，不写净值。
  {
    let loads = 0;
    const result = await recomputeNav('u1', 'A', TRADE_DATE, {
      settleCashIncome: async () => ({ status: 'partial' }),
      loadAccountData: async () => {
        loads++;
        return { navHistory: [{ date: TRADE_DATE, nav: 1, totalAsset: 100 }], trades: [], cashFlows: [] };
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.reason, 'cash_settlement_partial');
    assert.strictEqual(loads, 0);
  }

  // 11d) 授权失败保留原状态码，不被改写成普通 400 或 pending。
  {
    let loads = 0;
    await assert.rejects(
      () => recomputeNav('u1', 'A', TRADE_DATE, {
        settleCashIncome: async () => {
          throw Object.assign(new Error('forbidden'), { status: 403 });
        },
        loadAccountData: async () => { loads++; return { navHistory: [], trades: [], cashFlows: [] }; },
      }),
      error => error && error.status === 403
    );
    assert.strictEqual(loads, 0);
  }

  // 11d2) 无净值行：结算成功时返回 no_nav，不因补价流程要求已有净值行。
  {
    const result = await recomputeNav('u1', 'A', TRADE_DATE, {
      settleCashIncome: async () => ({ status: 'calculated' }),
      loadAccountData: async () => ({ navHistory: [], trades: [], cashFlows: [] }),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'no_nav');
    assert.strictEqual(result.days, 0);
  }

  // 11e) 定点补价行准入：provider 多返回的日期和候选行都不得写入。
  {
    const byDate = {
      [TRADE_DATE]: [
        priceRow(),
        priceRow({ quality: 'candidate', is_final: null }),
        priceRow(),
      ],
      '2026-11-21': [priceRow({ date: '2026-11-21' })],
    };
    const picked = selectBackfillRows(byDate, { qualifiedOnly: true, businessDate: TRADE_DATE });
    assert.strictEqual(picked.length, 1);
    assert.strictEqual(picked[0][0], TRADE_DATE);
    assert.strictEqual(picked[0][1].length, 1);
    assert.ok(picked[0][1].every(row => row.quality === 'confirmed' && row.is_final === true));
    assert.deepStrictEqual(selectBackfillRows({
      [TRADE_DATE]: [priceRow({ price: 101 }), priceRow({ price: 102 })],
    }, { qualifiedOnly: true, businessDate: TRADE_DATE }), []);
  }

  // 11f) 本账户已 confirmed + 另一账户不同价：仍须整日冲突，不得先返回 own 跳过共享。
  {
    const calls = noopCounters();
    const result = await ensureTradeClosePrice('u1', 'A', {
      code: BOND, subtype: '沪市', tradeDate: TRADE_DATE,
    }, {
      today: TODAY,
      expectedCloseDate: async () => TRADE_DATE,
      readOwn: async () => { calls.own++; return [priceRow({ price: 101 })]; },
      readShared: async () => {
        calls.shared++;
        return [priceRow({ price: 102, username: 'u2', account_name: 'B' })];
      },
      savePrice: async () => { calls.save++; return [{ written: true }]; },
      backfill: async () => { calls.backfill++; return true; },
    });
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.reason, 'shared_close_conflict');
    assert.strictEqual(calls.shared, 1);
    assert.strictEqual(calls.save + calls.backfill, 0);
  }

  // 11g) 路由保留 409 语义、非 409 异常保留原状态码。
  {
    const routes = fs.readFileSync(path.join(root, 'server/routes/accounts.js'), 'utf8');
    assert.ok(routes.includes("body.reason === 'cash_settlement_failed' ? Math.max(400, settlementStatus) : 409"), '现金结算待重试必须保留 409/原失败状态');
    assert.ok(routes.includes('Number(error && error.status) || 500'), '权限等异常不得一律改 400');
  }

  // 12) 前端手工录入冻结开始时账户/登录身份/代次：交易/重算/重载响应不得应用到切换后的新账户，
  //     且收盘价、净值重算与现金结算分别提示。
  {
    const source = fs.readFileSync(path.join(root, 'public/shared/core-trade.js'), 'utf8');
    assert.ok(source.includes('const scope = captureSmartImportScope()'), '手工录入必须冻结开始时账户/身份/代次');
    assert.ok(source.includes('isSmartImportScopeCurrent(scope)'), '迟到响应必须复用统一账户身份代次守卫');
    assert.ok(source.includes("payload.reason === 'cash_settlement_conflict'"), '现金结算待重算只能提示一次');
    assert.ok(source.includes('const requestOk = !!(r && r.ok)'), '旧服务 error 与失败 HTTP 必须明确提示');
    assert.ok(source.includes('closePriceStatusText'), '收盘价待补必须可提示');
    assert.ok(source.includes('navRecomputeStatusText'), '净值重算/现金结算必须分别提示');

    const manualTrade = source.slice(source.indexOf('function closePriceStatusText('),
      source.indexOf('async function deleteTrade('));
    async function switchWhileSaving(nextScope, response) {
      const first = { generation: 0, user: 'u1', identity: 'subject1', account: 'A' };
      let active = first;
      let finishSave;
      const rebased = [];
      const notices = [];
      const fields = new Map(Object.entries({
        'trade-code': BOND, 'trade-dir': 'buy', 'trade-price': '100', 'trade-qty': '10',
        'trade-date': TRADE_DATE,
      }).map(([key, value]) => [key, { value }]));
      const data = { original: true };
      const context = vm.createContext({
        document: { getElementById: key => fields.get(key) || { value: '' } },
        classifyCode: { normalizeCode: code => code }, autoCalcTrade() {},
        todayCN: () => TODAY, uid: () => 'test-trade', dataVersion: 1, data,
        captureSmartImportScope: () => active,
        isSmartImportScopeCurrent: scope => scope === active,
        renderAll() { throw new Error('迟到响应不得触发当前页面重绘'); },
        showToast: message => notices.push(message),
        window: { tradeLedgerApi: {
          addTrade: (account, version) => {
            assert.strictEqual(account, 'A');
            assert.strictEqual(version, 1);
            return new Promise(resolve => { finishSave = resolve; });
          },
          recomputeNav: async (account, date) => {
            rebased.push([account, date]);
            return { ok: true, payload: { ok: true } };
          },
        } },
      });
      vm.runInContext(manualTrade, context);
      const pending = context.addTrade();
      active = { ...first, generation: 2, ...nextScope };
      finishSave(response);
      await pending;
      assert.strictEqual(context.data, data, '原账户的迟到响应不得覆盖当前页面数据');
      return { rebased, notices };
    }

    const response = { ok: true, payload: { ok: true, data: { late: true } } };
    const differentAccount = await switchWhileSaving({ account: 'B' }, response);
    assert.deepStrictEqual(differentAccount.rebased, [['A', TRADE_DATE]]);
    const differentLogin = await switchWhileSaving({ user: 'u2', identity: 'subject2' }, response);
    assert.deepStrictEqual(differentLogin.rebased, [], '换登录主体后不得向原账户名称重新发起写请求');
    const failed = await switchWhileSaving({ account: 'B' }, { ok: false, payload: { error: '冲突' } });
    assert.deepStrictEqual(failed.rebased, []);
    assert.ok(failed.notices.every(message => !message.includes('已记入')));
    const missingClose = await switchWhileSaving({ account: 'B' }, {
      ok: true, payload: { ok: true, closePrice: { status: 'pending' } },
    });
    assert.deepStrictEqual(missingClose.rebased, [], '定点补价待完成时不得立即从旧重算路径重复请求');
    assert.ok(missingClose.notices.some(message => message.includes('收盘价待补')));
  }

  console.log('trade close price: targeted shared reuse, conflict guards, pending evidence, 409 decoupling and account-scope guard passed');
})().catch(error => { console.error(error); process.exit(1); });
