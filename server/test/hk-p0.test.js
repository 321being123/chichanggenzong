const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  groupCandidates,
  fetchBatch,
  coverageForCandidate,
  rowsFromTencentHkKline,
  fetchTencentHkDaily,
} = require('../services/hkDailyCoverage');
const {
  evaluateFormalGate,
  buildWalkForward,
  buildBacktestRows,
  dailyCoverageFromBars,
  auditFormalValidation,
  MODEL_CONFIG,
  consecutiveWorkdayCount,
  upsertHkFormalRecommendationSnapshot,
} = require('../services/hkIpoBacktest');
const { parsePredefinedDocumentHtml, parseNewListingReportWorkbook, buildProbePlan, persistHkexProbe, resolveHkexEnglishPdfUrl, HKEX_NON_PUBLIC_LISTINGS } = require('../services/hkexIpo');
const ExcelJS = require('exceljs');

const candidates = [
  { instrument_id: 1, canonical_code: '00001.HK', list_date: '2025-08-04' },
  { instrument_id: 2, canonical_code: '00002.HK', list_date: '2025-08-05' },
  { instrument_id: 3, canonical_code: '00003.HK', list_date: '2025-10-01' },
];
assert.strictEqual(groupCandidates(candidates, 45, 2).length, 2);
assert.strictEqual(consecutiveWorkdayCount(
  ['2026-09-07', '2026-09-08', '2026-09-10'],
  ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']
), 2, '双环境门禁必须按同一日期交集计算连续工作日');
assert.strictEqual(consecutiveWorkdayCount(
  ['2026-09-07', '2026-09-09'],
  ['2026-09-07', '2026-09-08', '2026-09-09']
), 1, '缺失中间交易日不能拼成连续工作日');
assert.strictEqual(HKEX_NON_PUBLIC_LISTINGS.length, 6);
assert.ok(HKEX_NON_PUBLIC_LISTINGS.every(item => /^https:\/\/(?:www1|www2)\.hkexnews\.hk\//.test(item.sourceUrl)));
assert.deepStrictEqual(HKEX_NON_PUBLIC_LISTINGS.map(item => item.ipoStatus), [
  'introduction', 'gem_transfer', 'de_spac', 'introduction', 'gem_transfer', 'gem_transfer',
]);

const exactCoverageCandidates = [
  { instrument_id: 10, security_code: '00010.HK', listing_date: '2025-08-04', issue_price_final: 10, issue_price_low: 10, issue_price_high: 10, lot_size_shares: 100, offer_close_at: '2025-08-01', source_documents: [{ parserEvidence: { sponsorGroup: '示例保荐人' } }] },
  { instrument_id: 11, security_code: '00011.HK', listing_date: '2025-08-04', issue_price_final: 10, issue_price_low: 10, issue_price_high: 10, lot_size_shares: 100, offer_close_at: '2025-08-01' },
];
const exactOpenDates = ['2025-08-04', '2025-08-05', '2025-08-06', '2025-08-07', '2025-08-08'];
const exactBars = new Map([
  ['10', exactOpenDates.map(tradeDate => ({ tradeDate, close: 10 }))],
  ['11', ['2025-08-04', '2025-08-05', '2025-08-06', '2025-08-07', '2025-08-11'].map(tradeDate => ({ tradeDate, close: 10 }))],
]);
const exactCoverage = dailyCoverageFromBars(exactCoverageCandidates, exactBars, exactOpenDates);
assert.strictEqual(exactCoverage.firstDayCoverage, 1);
assert.strictEqual(exactCoverage.fiveDayCoverage, 0.5, '第五个交易日必须按交易日历精确匹配');
const exactRows = buildBacktestRows(exactCoverageCandidates, exactBars, exactOpenDates);
assert.strictEqual(exactRows[1].fiveDayReturn, null, '缺少第五个交易日行情不能用第六个观测日顶替');
assert.strictEqual(exactRows[0].sponsorGroup, '示例保荐人');

(async () => {
  const batch = await fetchBatch(candidates.slice(0, 2), async (code) => ({
    fields: ['ts_code', 'trade_date', 'close'],
    items: code === '00001.HK'
      ? [['00001.HK', '20250804', 10], ['00001.HK', '20250805', 11], ['00001.HK', '20250806', 12], ['00001.HK', '20250807', 13], ['00001.HK', '20250808', 14]]
      : [['00002.HK', '20250805', 20]],
  }), '2026-09-07');
  assert.strictEqual(batch[0].coverage.firstDay, true);
  assert.strictEqual(batch[0].coverage.fiveDay, true);
  assert.strictEqual(batch[1].coverage.fiveDay, false);
  assert.deepStrictEqual(coverageForCandidate(candidates[0], batch[0].rows).dates.length, 5);
  const tencentPayload = { code: 0, data: { hk00001: { day: [['2025-08-04', '10', '11', '12', '9', '100'], ['2025-08-05', '11', '12', '13', '10', '120']] } } };
  assert.strictEqual(rowsFromTencentHkKline(tencentPayload, '00001.HK')[0].ts_code, '00001.HK');
  const tencentBatch = await fetchTencentHkDaily(candidates[0], '2026-09-07', async () => tencentPayload);
  assert.strictEqual(tencentBatch.rows.length, 2);
  assert.strictEqual(tencentBatch.coverage.firstDay, true);
  await assert.rejects(
    () => fetchBatch(candidates.slice(0, 2), null, '2026-09-07'),
    /一次只允许一个 ts_code/
  );

  const fixture = parsePredefinedDocumentHtml(
    '<table><tr><td>00700</td><td>示例公司</td><td><a href="/docs/prospectus.pdf">招股章程</a></td></tr></table>',
    { documentType: 'prospectus', sourceUrl: 'https://www2.hkexnews.hk/new-listings/new-listing-information/main-board?sc_lang=en' }
  );
  assert.strictEqual(fixture[0].securityCode, '00700.HK');
  assert.ok(fixture[0].url.includes('www2.hkexnews.hk'));
  assert.ok(buildProbePlan().every(target => new URL(target.url).protocol === 'https:'));
  assert.strictEqual(
    resolveHkexEnglishPdfUrl('https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0929/2025092902275_c.pdf'),
    'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0929/2025092902274.pdf'
  );
  const parserScript = path.join(__dirname, '..', 'scripts', 'extractHkIpoAllotment.py');
  const parserPython = path.join(__dirname, '..', '..', 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(parserPython)) {
    const parserInput = [
      'Number of Offer Shares 109,808,800',
      'No. of Offer Shares initially available under the Public Offer 10,981,200',
      'No. of Offer Shares initially available under the International Offer (including 1,317,600 Shares) 98,827,600',
    ].join(' ');
    const parsed = spawnSync(parserPython, [parserScript, '--text'], { input: parserInput, encoding: 'utf8' });
    assert.strictEqual(parsed.status, 0);
    const parsedFacts = JSON.parse(parsed.stdout);
    assert.strictEqual(parsedFacts.parserStatus, 'parsed');
    assert.ok(Math.abs(parsedFacts.initialPublicOfferRatio - 0.10000291415624249) < 1e-12);
    assert.ok(Math.abs(parsedFacts.initialInternationalOfferRatio - 0.8999970858437575) < 1e-12);
    const lotteryInput = [
      'Number of Offer Shares 279,992,500',
      'No. of Offer Shares initially available under the Hong Kong Public Offering 27,999,300',
      'No. of Offer Shares initially available under the International Offering 251,993,200',
      'BASIS OF ALLOCATION UNDER THE HONG KONG PUBLIC OFFERING',
      'POOL A',
      '100',
      '15,312',
      '2,820 out of 15,312 to receive 100 Shares',
      '18.42%',
    ].join('\n');
    const lotteryParsed = spawnSync(parserPython, [parserScript, '--text', '--lot-size', '100'], { input: lotteryInput, encoding: 'utf8' });
    assert.strictEqual(lotteryParsed.status, 0);
    const lotteryFacts = JSON.parse(lotteryParsed.stdout);
    assert.strictEqual(lotteryFacts.lotteryParserStatus, 'parsed');
    assert.strictEqual(lotteryFacts.oneLotAppliedShares, 100);
    assert.strictEqual(lotteryFacts.oneLotValidApplications, 15312);
    assert.strictEqual(lotteryFacts.oneLotSuccessfulApplications, 2820);
    assert.strictEqual(lotteryFacts.oneLotSuccessRate, 18.42);
    const feeInput = [
      'Number of Offer Shares 279,992,500',
      'No. of Offer Shares initially available under the Hong Kong Public Offering 27,999,300',
      'No. of Offer Shares initially available under the International Offering 251,993,200',
      'Final Offer Price HK$48.56 per Offer Share plus brokerage of 1%, SFC transaction levy of 0.0027%, AFRC transaction levy of 0.00015% and the Stock Exchange trading fee of 0.00565%',
      'BASIS OF ALLOCATION UNDER THE HONG KONG PUBLIC OFFERING',
      'POOL A', '100', '15,312', '2,820 out of 15,312 to receive 100 Shares', '18.42%',
    ].join('\n');
    const feeParsed = spawnSync(parserPython, [parserScript, '--text', '--lot-size', '100'], { input: feeInput, encoding: 'utf8' });
    assert.strictEqual(feeParsed.status, 0);
    const feeFacts = JSON.parse(feeParsed.stdout);
    assert.strictEqual(feeFacts.feeParserStatus, 'parsed');
    assert.strictEqual(feeFacts.finalOfferPrice, 48.56);
    assert.strictEqual(feeFacts.lotAmountHkd, 4904.97);
    assert.strictEqual(feeFacts.applicationFeeHkd, 48.97);
    assert.strictEqual(feeFacts.brokerageFeeHkd, 48.56);
    const oversubscriptionInput = [
      'The Hong Kong Public Offering has been oversubscribed 50 times or more.',
      'No. of Offer Shares initially available under the Hong Kong Public Offering 27,999,300.',
      'No. of Offer Shares initially available under the International Offering 251,993,200.',
      'Final Number of Offer Shares in Hong Kong Public Offering (after reallocation) 27,999,300.',
      'Over-allocation No. of Offer Shares over-allocated 30,184,000 Shares.',
      'Such over-allocation may be covered by exercising the Over-allotment Option.',
    ].join(' ');
    const oversubscriptionParsed = spawnSync(parserPython, [parserScript, '--text'], { input: oversubscriptionInput, encoding: 'utf8' });
    assert.strictEqual(oversubscriptionParsed.status, 0);
    const oversubscriptionFacts = JSON.parse(oversubscriptionParsed.stdout);
    assert.strictEqual(oversubscriptionFacts.oversubscriptionParserStatus, 'parsed');
    assert.strictEqual(oversubscriptionFacts.publicOversubscription, 50);
    assert.strictEqual(oversubscriptionFacts.publicOversubscriptionQualifier, 'or_more');
    assert.strictEqual(oversubscriptionFacts.greenshoeParserStatus, 'parsed');
    assert.strictEqual(oversubscriptionFacts.greenshoeDetails.status, 'over_allocated');
    assert.strictEqual(oversubscriptionFacts.greenshoeDetails.overAllocatedShares, 30184000);
    assert.strictEqual(oversubscriptionFacts.greenshoeDetails.publicOfferShares, 27999300);
    assert.strictEqual(oversubscriptionFacts.greenshoeDetails.initialPublicOfferShares, 27999300);
    assert.strictEqual(oversubscriptionFacts.greenshoeDetails.finalPublicOfferShares, 27999300);
    assert.strictEqual(oversubscriptionFacts.greenshoeDetails.publicOfferSharesBasis, 'final_public_offer_after_reallocation');
    assert.strictEqual(oversubscriptionFacts.greenshoeDetails.protectionRatioPct, 107.8027);
    const reallocatedGreenshoeInput = [
      'The Hong Kong Public Offering has been oversubscribed 3,835.36 times.',
      'No. of Offer Shares initially available under the Hong Kong Public Offering 1,157,040.',
      'No. of Offer Shares initially available under the International Offering 21,983,550.',
      'Final Number of Offer Shares in Hong Kong Public Offering (after reallocation) 4,628,130.',
      'Over-allocation No. of Offer Shares over-allocated 3,471,060 Shares.',
    ].join(' ');
    const reallocatedGreenshoeParsed = spawnSync(parserPython, [parserScript, '--text'], { input: reallocatedGreenshoeInput, encoding: 'utf8' });
    assert.strictEqual(reallocatedGreenshoeParsed.status, 0);
    const reallocatedGreenshoeFacts = JSON.parse(reallocatedGreenshoeParsed.stdout);
    assert.strictEqual(reallocatedGreenshoeFacts.finalPublicOfferShares, 4628130);
    assert.strictEqual(reallocatedGreenshoeFacts.greenshoeDetails.publicOfferShares, 4628130);
    assert.strictEqual(reallocatedGreenshoeFacts.greenshoeDetails.protectionRatioPct, 74.9992);
    const missingFinalGreenshoeParsed = spawnSync(parserPython, [parserScript, '--text'], {
      input: 'No. of Offer Shares initially available under the Hong Kong Public Offering 1,000,000. Over-allocation No. of Offer Shares over-allocated 1,500,000 Shares.',
      encoding: 'utf8',
    });
    assert.strictEqual(missingFinalGreenshoeParsed.status, 0);
    const missingFinalGreenshoeFacts = JSON.parse(missingFinalGreenshoeParsed.stdout);
    assert.strictEqual(missingFinalGreenshoeFacts.greenshoeDetails.publicOfferSharesBasis, 'final_public_offer_missing');
    assert.strictEqual(missingFinalGreenshoeFacts.greenshoeDetails.protectionRatioPct, undefined);
    const subscriptionLevelInput = 'ALLOTMENT RESULTS DETAILS PUBLIC OFFER No. of valid applications 153,533 Subscription level (before taking into account the Offer Size Adjustment Option) 557.2 times';
    const subscriptionLevelParsed = spawnSync(parserPython, [parserScript, '--text'], { input: subscriptionLevelInput, encoding: 'utf8' });
    assert.strictEqual(subscriptionLevelParsed.status, 0);
    const subscriptionLevelFacts = JSON.parse(subscriptionLevelParsed.stdout);
    assert.strictEqual(subscriptionLevelFacts.publicOversubscription, 557.2);
    const noGreenshoeInput = [
      'Over-allocation No. of Offer Shares over-allocated 0.',
      'The Over-allotment Option will not be exercised and will lapse upon Listing.',
    ].join(' ');
    const noGreenshoeParsed = spawnSync(parserPython, [parserScript, '--text'], { input: noGreenshoeInput, encoding: 'utf8' });
    assert.strictEqual(noGreenshoeParsed.status, 0);
    const noGreenshoeFacts = JSON.parse(noGreenshoeParsed.stdout);
    assert.strictEqual(noGreenshoeFacts.greenshoeDetails.status, 'not_exercised');
    assert.strictEqual(noGreenshoeFacts.greenshoeDetails.exercised, false);
    const noStabilizationParsed = spawnSync(parserPython, [parserScript, '--text'], {
      input: 'No stabilizing manager will be appointed, and no stabilization activities will be carried out in relation to the Global Offering.',
      encoding: 'utf8',
    });
    assert.strictEqual(noStabilizationParsed.status, 0);
    const noStabilizationFacts = JSON.parse(noStabilizationParsed.stdout);
    assert.strictEqual(noStabilizationFacts.greenshoeDetails.status, 'not_available');
    const offerPriceInput = [
      'Offer Price HK$18.68 per H Share, plus brokerage of 1.0%, AFRC transaction levy of 0.00015%, SFC transaction levy of 0.0027% and Stock Exchange trading fee of 0.00565%',
      'Number of Offer Shares 36,556,400',
      'No. of Offer Shares initially available under the Hong Kong Public Offer 3,655,800',
      'No. of Offer Shares initially available under the International Offer 32,900,600',
    ].join('\n');
    const offerPriceParsed = spawnSync(parserPython, [parserScript, '--text', '--lot-size', '200'], { input: offerPriceInput, encoding: 'utf8' });
    assert.strictEqual(offerPriceParsed.status, 0);
    const offerPriceFacts = JSON.parse(offerPriceParsed.stdout);
    assert.strictEqual(offerPriceFacts.finalOfferPrice, 18.68);
    assert.strictEqual(offerPriceFacts.feeParserStatus, 'parsed');
    assert.strictEqual(offerPriceFacts.lotAmountHkd, 3773.68);
    const allocationTableInput = [
      'Number of Offer Shares 19,207,300',
      'No. of Offer Shares initially available under the Hong Kong Public Offering 1,920,800',
      'No. of Offer Shares initially available under the International Offering 17,286,500',
      'BASIS OF ALLOCATION UNDER THE HONG KONG PUBLIC OFFERING',
      'NO. OF H SHARES APPLIED FOR',
      'NO. OF VALID APPLICATIONS',
      'BASIS OF ALLOTMENT/BALLOT',
      'APPROXIMATE PERCENTAGE ALLOTTED OF THE TOTAL NO. OF H SHARES APPLIED FOR',
      '100',
      '57,352',
      '0 H Shares',
      '2.00%',
      '100',
      '1,171',
      '100 H Shares',
    ].join('\n');
    const allocationTableParsed = spawnSync(parserPython, [parserScript, '--text', '--lot-size', '100'], { input: allocationTableInput, encoding: 'utf8' });
    assert.strictEqual(allocationTableParsed.status, 0);
    const allocationTableFacts = JSON.parse(allocationTableParsed.stdout);
    assert.strictEqual(allocationTableFacts.lotteryParserStatus, 'parsed');
    assert.strictEqual(allocationTableFacts.oneLotAppliedShares, 100);
    assert.strictEqual(allocationTableFacts.oneLotValidApplications, 57352);
    assert.strictEqual(allocationTableFacts.oneLotSuccessfulApplications, null);
    assert.strictEqual(allocationTableFacts.oneLotSuccessRate, 2);
    const inlineAllocationInput = [
      'Number of Offer Shares 121,952,000',
      'No. of Offer Shares initially available under the Hong Kong Public Offering 12,196,000',
      'No. of Offer Shares initially available under the International Offering 109,756,000',
      'BASIS OF ALLOCATION UNDER THE HONG KONG PUBLIC OFFERING',
      'POOL A',
      '1,000',
      '47,424 474 out of 47,424 applicants to receive 1,000 Shares',
      '1.00%',
    ].join('\n');
    const inlineAllocationParsed = spawnSync(parserPython, [parserScript, '--text', '--lot-size', '1000.0000'], { input: inlineAllocationInput, encoding: 'utf8' });
    assert.strictEqual(inlineAllocationParsed.status, 0);
    const inlineAllocationFacts = JSON.parse(inlineAllocationParsed.stdout);
    assert.strictEqual(inlineAllocationFacts.lotteryParserStatus, 'parsed');
    assert.strictEqual(inlineAllocationFacts.oneLotAppliedShares, 1000);
    assert.strictEqual(inlineAllocationFacts.oneLotValidApplications, 47424);
    assert.strictEqual(inlineAllocationFacts.oneLotSuccessfulApplications, 474);
    assert.strictEqual(inlineAllocationFacts.oneLotSuccessRate, 1);
    const prospectusScript = path.join(__dirname, '..', 'scripts', 'extractHkIpoProspectus.py');
    const prospectusInput = [
      'Guangzhou Innogen Pharmaceutical Group Co., Ltd.',
      'Stock Code: 2591',
      'Offer Price: HK$18.68',
      'Application for Hong Kong Offer Shares must be for a minimum of 200 Hong Kong Offer Shares.',
      'The Hong Kong Public Offering will commence on 7 August 2025 at 9:00 a.m.',
      'The latest time for lodging applications is 12 August 2025 at 12:00 noon.',
    ].join(' ');
    const prospectusParsed = spawnSync(parserPython, [prospectusScript, '--text'], { input: prospectusInput, encoding: 'utf8' });
    assert.strictEqual(prospectusParsed.status, 0);
    const prospectusFacts = JSON.parse(prospectusParsed.stdout);
    assert.strictEqual(prospectusFacts.parserStatus, 'parsed');
    assert.strictEqual(prospectusFacts.securityCode, '02591.HK');
    assert.strictEqual(prospectusFacts.lotSizeShares, 200);
    assert.strictEqual(prospectusFacts.offerOpenAt, '2025-08-07T09:00:00+08:00');
    assert.strictEqual(prospectusFacts.offerCloseAt, '2025-08-12T12:00:00+08:00');

    const sponsorParsed = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'Stock Code: 2591 Joint Sponsors ABC Capital Limited and XYZ Securities Limited Joint Global Coordinators',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorParsed.status, 0);
    const sponsorFacts = JSON.parse(sponsorParsed.stdout);
    assert.strictEqual(sponsorFacts.sponsorGroup, 'ABC Capital Limited and XYZ Securities Limited');

    const sponsorBodyReference = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: '本公司可能因任何事宜構成重大遺漏，保薦人已就刊發本招股章程撤回同意書。',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorBodyReference.status, 0);
    const sponsorBodyFacts = JSON.parse(sponsorBodyReference.stdout);
    assert.strictEqual(sponsorBodyFacts.sponsorGroup, null, '正文风险/责任段落不能误识别为保荐人分组');

    const sponsorRoleOnly = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'Stock Code: 2591 Joint Sponsors, Overall Coordinators, Sponsor-Overall Coordinators, Joint Global Coordinators and Joint Bookrunners',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorRoleOnly.status, 0);
    const sponsorRoleFacts = JSON.parse(sponsorRoleOnly.stdout);
    assert.strictEqual(sponsorRoleFacts.sponsorGroup, null, '仅有角色标题不能误识别为保荐人分组');

    const sponsorAppendix = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'APPENDIX IV 3. Joint Sponsors Each of Goldman Sachs (Asia) L.L.C., Morgan Stanley Asia Limited and J.P. Morgan Securities (Far East) Limited satisfies the independence criteria applicable to sponsors. 4. Consents of Experts',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorAppendix.status, 0);
    const sponsorAppendixFacts = JSON.parse(sponsorAppendix.stdout);
    assert.strictEqual(sponsorAppendixFacts.sponsorGroup, 'Goldman Sachs (Asia) L.L.C., Morgan Stanley Asia Limited and J.P. Morgan Securities (Far East) Limited');

    const sponsorTable = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'DIRECTORS AND PARTIES INVOLVED IN THE GLOBAL OFFERING\nPARTIES INVOLVED IN THE GLOBAL OFFERING\nJoint Sponsors\nChina International Capital Corporation\nHong Kong Securities Limited\n29/F, One International Finance Centre\nCentral\nHong Kong\nUBS Securities Hong Kong Limited\n52/F, Two International Finance Centre\nCentral\nHong Kong\nOverall Coordinators',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorTable.status, 0);
    const sponsorTableFacts = JSON.parse(sponsorTable.stdout);
    assert.strictEqual(sponsorTableFacts.sponsorGroup, 'China International Capital Corporation Hong Kong Securities Limited; UBS Securities Hong Kong Limited');

    const sponsorTableSameLine = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'PARTIES INVOLVED IN THE GLOBAL OFFERING Joint Sponsors\nChina International Capital Corporation Hong Kong Securities Limited\n29/F, One International Finance Centre\nUBS Securities Hong Kong Limited\nLevel 1, Two Exchange Square\nSponsor-Overall Coordinator',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorTableSameLine.status, 0);
    const sponsorTableSameLineFacts = JSON.parse(sponsorTableSameLine.stdout);
    assert.strictEqual(sponsorTableSameLineFacts.sponsorGroup, 'China International Capital Corporation Hong Kong Securities Limited; UBS Securities Hong Kong Limited');

    const sponsorSoleTable = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'PARTIES INVOLVED IN THE GLOBAL OFFERING\nSole Sponsor, Sole Representative and Sole Sponsor-Overall Coordinator\nChina International Capital Corporation\nHong Kong Securities Limited\n29/F, One International Finance Centre\nCentral\nHong Kong\nOverall Coordinators',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorSoleTable.status, 0);
    const sponsorSoleTableFacts = JSON.parse(sponsorSoleTable.stdout);
    assert.strictEqual(sponsorSoleTableFacts.sponsorGroup, 'China International Capital Corporation Hong Kong Securities Limited');

    const sponsorSoleShortTable = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'PARTIES INVOLVED IN THE GLOBAL OFFERING\nSole Sponsor\nChina Securities (International)\nCorporate Finance Company Limited\n18/F, Two Exchange Square\nCentral\nHong Kong\nSponsor-Overall Coordinator',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorSoleShortTable.status, 0);
    const sponsorSoleShortFacts = JSON.parse(sponsorSoleShortTable.stdout);
    assert.strictEqual(sponsorSoleShortFacts.sponsorGroup, 'China Securities (International) Corporate Finance Company Limited');

    const sponsorStandaloneParties = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'DIRECTORS, SUPERVISORS AND PARTIES INVOLVED IN THE GLOBAL OFFERING\nPARTIES INVOLVED\nSole Sponsor\nPing An of China Capital (Hong Kong) Company Limited\n(a licensed corporation under the SFO to engage in type 6 regulated activity)\nUnits 3601, 36/F, The Center\nOverall Coordinator',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorStandaloneParties.status, 0);
    const sponsorStandaloneFacts = JSON.parse(sponsorStandaloneParties.stdout);
    assert.strictEqual(sponsorStandaloneFacts.sponsorGroup, 'Ping An of China Capital (Hong Kong) Company Limited');

    const sponsorSuiteAddress = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'PARTIES INVOLVED IN THE GLOBAL OFFERING\nJoint Sponsors\nCITIC Securities (Hong Kong) Limited\n18/F, One Pacific Place\nHaitong International Capital Limited\nSuites 3001-3006 and 3015-3016\nOne International Finance Centre\nCentral\nHong Kong\nSponsor-Overall Coordinators',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorSuiteAddress.status, 0);
    const sponsorSuiteAddressFacts = JSON.parse(sponsorSuiteAddress.stdout);
    assert.strictEqual(sponsorSuiteAddressFacts.sponsorGroup, 'CITIC Securities (Hong Kong) Limited; Haitong International Capital Limited');

    const sponsorPluralEnd = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'DIRECTORS AND PARTIES INVOLVED IN THE GLOBAL OFFERING\nPARTIES INVOLVED IN THE GLOBAL OFFERING\nJoint Sponsors\nChina International Capital Corporation Hong Kong Securities Limited\n29th Floor, One International Finance Centre\nGuotai Junan Capital Limited\n27/F, Low Block, Grand Millennium Plaza\nSponsor-OCs, Overall Coordinators, Joint Global Coordinators',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorPluralEnd.status, 0);
    const sponsorPluralEndFacts = JSON.parse(sponsorPluralEnd.stdout);
    assert.strictEqual(sponsorPluralEndFacts.sponsorGroup, 'China International Capital Corporation Hong Kong Securities Limited; Guotai Junan Capital Limited');

    const sponsorJointOverall = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'PARTIES INVOLVED IN THE GLOBAL OFFERING\nJoint Sponsors and Overall Coordinators\nChina International Capital Corporation Hong Kong Securities Limited\n29/F, One International Finance Centre\nChina Galaxy International Securities (Hong Kong) Co., Limited\n20th Floor, Wing On Centre\nSponsor-Overall Coordinator',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorJointOverall.status, 0);
    const sponsorJointOverallFacts = JSON.parse(sponsorJointOverall.stdout);
    assert.strictEqual(sponsorJointOverallFacts.sponsorGroup, 'China International Capital Corporation Hong Kong Securities Limited; China Galaxy International Securities (Hong Kong) Co., Limited');

    const sponsorCrossPageHeader = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'DIRECTORS AND PARTIES INVOLVED IN THE GLOBAL OFFERING\nPARTIES INVOLVED IN THE GLOBAL OFFERING\nJoint Sponsors, Sponsor-OCs, Joint\nRepresentatives, Overall Coordinators,\nJoint Global Coordinators, Joint\nBookrunners, Joint Lead Managers and\nCapital Market Intermediaries\nJefferies Hong Kong Limited\n26/F, Two International Finance Centre\nMerrill Lynch (Asia Pacific) Limited\n55/F, Cheung Kong Center\nLegal Advisers to our Company',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorCrossPageHeader.status, 0);
    const sponsorCrossPageFacts = JSON.parse(sponsorCrossPageHeader.stdout);
    assert.strictEqual(sponsorCrossPageFacts.sponsorGroup, 'Jefferies Hong Kong Limited; Merrill Lynch (Asia Pacific) Limited');

    const sponsorSingleRole = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'PARTIES INVOLVED IN THE GLOBAL OFFERING\nSponsor\nChina International Capital Corporation Hong Kong Securities Limited\n29/F, One International Finance Centre\nSponsor-Overall Coordinator, Sole Overall Coordinator',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorSingleRole.status, 0);
    const sponsorSingleRoleFacts = JSON.parse(sponsorSingleRole.stdout);
    assert.strictEqual(sponsorSingleRoleFacts.sponsorGroup, 'China International Capital Corporation Hong Kong Securities Limited');

    const sponsorSarAddress = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: 'PARTIES INVOLVED IN THE GLOBAL OFFERING\nJoint Sponsors\nChina International Capital Corporation Hong Kong Securities Limited\n29/F, One International Finance Centre\nCentral\nHong Kong SAR\nCITIC Securities (Hong Kong) Limited\n18/F, One Pacific Place\nHong Kong SAR\nOverall Coordinators',
      encoding: 'utf8',
    });
    assert.strictEqual(sponsorSarAddress.status, 0);
    const sponsorSarFacts = JSON.parse(sponsorSarAddress.stdout);
    assert.strictEqual(sponsorSarFacts.sponsorGroup, 'China International Capital Corporation Hong Kong Securities Limited; CITIC Securities (Hong Kong) Limited');

    const chineseSchedule = [
      '股份代號：2259',
      '每手100股股份',
      '發售價：每股發售股份71.59港元',
      '預期時間表 2025年（附註1）',
      '香港公開發售及優先發售開始 9月19日（星期五）上午九時正',
      '截止辦理香港公開發售及優先發售申請登記 9月24日（星期三）中午十二時正',
    ].join(' ');
    const chineseParsed = spawnSync(parserPython, [prospectusScript, '--text'], { input: chineseSchedule, encoding: 'utf8' });
    assert.strictEqual(chineseParsed.status, 0);
    const chineseFacts = JSON.parse(chineseParsed.stdout);
    assert.strictEqual(chineseFacts.parserStatus, 'parsed');
    assert.strictEqual(chineseFacts.offerOpenAt, '2025-09-19T09:00:00+08:00');
    assert.strictEqual(chineseFacts.offerCloseAt, '2025-09-24T12:00:00+08:00');

    const reverseMarker = spawnSync(parserPython, [prospectusScript, '--text'], {
      input: '股份代號：2637 發售價：每股86.40港元 每手50股 開始香港公開發售 2025年10月9日 上午九時正 截止辦理香港公開發售申請登記 2025年10月14日 中午十二時正',
      encoding: 'utf8',
    });
    assert.strictEqual(reverseMarker.status, 0);
    const reverseFacts = JSON.parse(reverseMarker.stdout);
    assert.strictEqual(reverseFacts.offerOpenAt, '2025-10-09T09:00:00+08:00');
  }

  const mainWorkbook = new ExcelJS.Workbook();
  const mainSheet = mainWorkbook.addWorksheet('Main');
  mainSheet.addRow(['No.', 'Stock Code', 'Company Name', 'Offer Period', 'Listing Date', '', '', '', '', 'Offer Price']);
  mainSheet.addRow([1, '12345', '示例主板', '', new Date(Date.UTC(2026, 0, 5)), '', '', '', '', 12.3]);
  const mainRows = await parseNewListingReportWorkbook(await mainWorkbook.xlsx.writeBuffer(), { board: '主板', sourceUrl: 'https://www2.hkexnews.hk/report.xlsx' });
  assert.deepStrictEqual(mainRows[0].securityCode, '12345.HK');
  assert.deepStrictEqual(mainRows[0].listingDate, '2026-01-05');
  assert.strictEqual(mainRows[0].issuePriceFinal, 12.3);

  const gemWorkbook = new ExcelJS.Workbook();
  const gemSheet = gemWorkbook.addWorksheet('GEM');
  gemSheet.addRow(['Listing Date', 'Stock Code', 'Company Name', '', '', 'Offer Price']);
  gemSheet.addRow([new Date(Date.UTC(2026, 1, 6)), '23456', '示例GEM', '', '', 3.2]);
  const gemRows = await parseNewListingReportWorkbook(await gemWorkbook.xlsx.writeBuffer(), { board: 'GEM', sourceUrl: 'https://www2.hkexnews.hk/gem.xlsx' });
  assert.deepStrictEqual(gemRows[0].securityCode, '23456.HK');
  assert.deepStrictEqual(gemRows[0].listingDate, '2026-02-06');

  const gate = evaluateFormalGate({ candidates: [], rows: [], windows: [], dailyCoverage: {}, probe: {} });
  assert.strictEqual(gate.passed, false);
  assert.ok(gate.reasons.includes('双环境稳定工作日不足 5 个'));
  assert.ok(gate.reasons.includes(`可回测样本不足 ${MODEL_CONFIG.formal_gate.minimum_eligible_samples} 只`));
  assert.ok(gate.reasons.some(reason => reason.startsWith('正式模型验证指标未完成')));
  const formalAudit = auditFormalValidation([
    { score: 80, hardVetoes: [], firstDayReturn: 10, issuePriceFinal: 10, lotSizeShares: 100, winProbability: null },
  ], []);
  assert.strictEqual(formalAudit.implementationReady, true);
  assert.strictEqual(formalAudit.performanceChecksPassed, false);
  assert.ok(formalAudit.reason.includes('一手中签概率'));
  const concentrationAudit = auditFormalValidation([
    { score: 80, hardVetoes: [], firstDayReturn: 10, issuePriceFinal: 10, lotSizeShares: 100, winProbability: 0.1, industry: '同一行业' },
    { score: 80, hardVetoes: [], firstDayReturn: 10, issuePriceFinal: 10, lotSizeShares: 100, winProbability: 0.1, industry: '同一行业' },
  ], []);
  assert.ok(concentrationAudit.reason.includes('集中度超过阈值'));
  const diagnosticGate = evaluateFormalGate({ rows: [{ hardVetoes: ['lot_size_shares_missing'] }], windows: [], dailyCoverage: {}, probe: {} });
  assert.deepStrictEqual(diagnosticGate.vetoCounts, { lot_size_shares_missing: 1 });
  assert.ok(diagnosticGate.reasons.some(reason => reason.includes('lot_size_shares_missing=1')));
  await assert.rejects(
    () => upsertHkFormalRecommendationSnapshot({ instrumentId: 1, asOfDate: '2026-09-07', executor: async () => ({ rows: [{ gate_status: 'blocked', gate_reasons: ['fixture'] }] }) }),
    /正式建议门禁未通过/
  );
  await assert.rejects(
    () => persistHkexProbe({ targets: [{ key: 'server', ok: true, httpStatus: 200, parserStatus: 'http_ok_remote_parser_not_run' }] }, { environment: 'server', executor: async () => ({ rows: [{ source_id: 1 }] }) }),
    /探针证据不完整/
  );

  const windows = buildWalkForward([
    { listingDate: '2025-08-04', firstDayReturn: 1, fiveDayReturn: 2, score: 80 },
  ], '2025-08-04', '2025-09-01');
  assert.deepStrictEqual(windows, []);
  const calendarWindows = buildWalkForward([
    { listingDate: '2025-09-01', firstDayReturn: 1 },
    { listingDate: '2026-03-01', firstDayReturn: 1 },
    { listingDate: '2026-06-01', firstDayReturn: 1 },
    { listingDate: '2026-09-01', firstDayReturn: 1 },
  ], '2025-08-04', '2026-09-07');
  assert.deepStrictEqual(calendarWindows.map(window => [window.trainStart, window.trainEnd, window.testStart, window.testEnd]), [
    ['2025-09-01', '2026-03-01', '2026-03-01', '2026-06-01'],
    ['2025-12-01', '2026-06-01', '2026-06-01', '2026-09-01'],
  ]);
  console.log('hk-p0.test.js passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
