// 反馈闭环「完成判据」反例测试（2026-10-30 复查 P1）。
//
// 复查实测的两个误报：①applyStatus=failed 且 items=[] 仍落 applied_verified；
// ②applyStatus=applied 但真实回读为空/主状态还是 new/无版本/无事件，仍报 feedback_applied=true。
// 这里直接执行 deploy/deploy_password.py 里的判定函数与发布前闸门函数（不是搜源码字串），
// 每条都构造一个反例，确认不会报"已核验"。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');

function resolvePython() {
  const candidates = [
    process.env.PYTHON,
    process.env.IPO_PYTHON_PATH,
    path.join(root, 'venv', 'Scripts', 'python.exe'),
    path.join(root, 'venv', 'bin', 'python'),
  ].filter(Boolean);
  const found = candidates.find(item => fs.existsSync(item));
  if (!found) throw new Error('找不到可用的 Python 解释器，无法执行部署判定函数');
  return found;
}

// 一次性把全部判定结果算出来，避免每条用例都启一次解释器。
const PROBE = `
import json, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, 'deploy')
import deploy_password as d

SHA = '7b51896d11112222333344445555666677778888'

def item(fid, status='applied'):
    return {'feedbackId': fid, 'applyStatus': status}

def readback(fid, **over):
    row = {'feedbackId': fid, 'applyStatus': 'applied', 'status': 'implemented',
           'implementedVersion': '0.9.1.5', 'implementedReleaseSha': SHA,
           'revision': '2', 'eventCount': 1}
    row.update(over)
    return row

def verdict(payload, sha=SHA, version='0.9.1.5'):
    r = d.evaluate_feedback_release(payload, expected_sha=sha, expected_version=version)
    return {'status': r.get('status'), 'applied': bool(r.get('feedback_applied')),
            'reason': r.get('reason'), 'pending': r.get('pending'), 'unverified': r.get('unverified')}

out = {}

# ① 整体失败 + 空明细：以前落 applied_verified
out['failed_empty'] = verdict({'applyStatus': 'failed', 'items': [], 'applied': 0, 'failed': 0})
# ② 整体成功但没有任何明细
out['applied_no_items'] = verdict({'applyStatus': 'applied', 'items': [], 'readBack': []})
# ③ 整体成功、明细成功，但回读为空
out['applied_empty_readback'] = verdict({'applyStatus': 'applied', 'items': [item('6')], 'readBack': []})
# ④ 回读里主状态仍是 new
out['readback_status_new'] = verdict({'applyStatus': 'applied', 'items': [item('6')],
    'readBack': [readback('6', status='new')]})
# ⑤ 回读没有实施版本
out['readback_no_version'] = verdict({'applyStatus': 'applied', 'items': [item('6')],
    'readBack': [readback('6', implementedVersion=None)]})
# ⑥ 回读没有实施提交
out['readback_no_sha'] = verdict({'applyStatus': 'applied', 'items': [item('6')],
    'readBack': [readback('6', implementedReleaseSha=None)]})
# ⑦ 实施提交是别的发布
out['readback_other_sha'] = verdict({'applyStatus': 'applied', 'items': [item('6')],
    'readBack': [readback('6', implementedReleaseSha='a' * 40)]})
# ⑧ 实施版本与本次部署不一致
out['readback_other_version'] = verdict({'applyStatus': 'applied', 'items': [item('6')],
    'readBack': [readback('6', implementedVersion='0.9.1.0')]})
# ⑨ 没有修订号
out['readback_no_revision'] = verdict({'applyStatus': 'applied', 'items': [item('6')],
    'readBack': [readback('6', revision=None)]})
# ⑩ 没有发布事件留痕
out['readback_no_event'] = verdict({'applyStatus': 'applied', 'items': [item('6')],
    'readBack': [readback('6', eventCount=0)]})
# ⑪ 还有未完成明细
out['with_pending'] = verdict({'applyStatus': 'applied',
    'items': [item('6'), item('9', 'conflict')], 'readBack': [readback('6')]})
# ⑫ 全部符合预期：唯一可以报已核验的情形
out['all_good'] = verdict({'applyStatus': 'applied', 'items': [item('6')],
    'readBack': [readback('6')]})
# ⑬ 本批全是不相关项：闭环成立但不能记成"已核验实施"
out['all_skipped'] = verdict({'applyStatus': 'applied', 'items': [item('6', 'skipped')], 'readBack': []})
# ⑭ 截断短提交号仍算一致（发布脚本传的是全 SHA，回读也可能是短 SHA）
out['short_sha'] = verdict({'applyStatus': 'applied', 'items': [item('6')],
    'readBack': [readback('6', implementedReleaseSha=SHA[:8])]})

# ---- 发布前闸门：无相关反馈的证据校验 ----
now = datetime.now(timezone.utc)
def evidence(**over):
    base = {'complete': True, 'queriedAt': now.isoformat(), 'releaseSha': SHA,
            'operator': 'admin', 'candidates': []}
    base.update(over)
    return base

out['evidence_ok'] = d.verify_none_evidence(evidence(), SHA, now=now)
out['evidence_incomplete'] = d.verify_none_evidence(evidence(complete=False), SHA, now=now)
out['evidence_no_operator'] = d.verify_none_evidence(evidence(operator=''), SHA, now=now)
out['evidence_no_candidates'] = d.verify_none_evidence(evidence(candidates=None), SHA, now=now)
out['evidence_related'] = d.verify_none_evidence(evidence(candidates=[{'conclusion': 'related'}]), SHA, now=now)
out['evidence_unrelated_no_reason'] = d.verify_none_evidence(
    evidence(candidates=[{'conclusion': 'unrelated', 'reason': ''}]), SHA, now=now)
out['evidence_unrelated_ok'] = d.verify_none_evidence(
    evidence(candidates=[{'conclusion': 'unrelated', 'reason': '仅涉及前端文案，本次未改'}]), SHA, now=now)
out['evidence_stale'] = d.verify_none_evidence(
    evidence(queriedAt=(now - timedelta(hours=72)).isoformat()), SHA, now=now)
out['evidence_other_sha'] = d.verify_none_evidence(evidence(releaseSha='b' * 40), SHA, now=now)
out['evidence_bad_time'] = d.verify_none_evidence(evidence(queriedAt='昨天'), SHA, now=now)

# 闸门本体：缺依据必须直接拒绝部署
def gate(opts):
    try:
        d.verify_feedback_requirement(opts, SHA)
        return 'passed'
    except SystemExit as exc:
        return 'blocked: ' + str(exc).splitlines()[0]

out['gate_no_evidence'] = gate({'feedback_run_id': None, 'feedback_none_evidence': None})
out['gate_with_run_id'] = gate({'feedback_run_id': '4', 'feedback_none_evidence': None})
out['gate_missing_file'] = gate({'feedback_run_id': None, 'feedback_none_evidence': 'no-such-file.json'})

print(json.dumps(out, ensure_ascii=False))
`;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    failures.push(name + ' -> ' + (error && error.message));
    console.log('  ✗ ' + name + ' -> ' + (error && error.message));
  }
}

function main() {
  const run = spawnSync(resolvePython(), ['-c', PROBE], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    timeout: 60000,
  });
  if (run.status !== 0) {
    console.error('判定函数执行失败：', (run.stderr || '').slice(0, 1500));
    process.exit(1);
  }
  const r = JSON.parse(run.stdout);

  // ---- 反例：任何一环缺失或不符都不得报"已核验" ----
  check('整体失败且明细为空不得报已核验', () => {
    assert.notStrictEqual(r.failed_empty.status, 'applied_verified');
    assert.strictEqual(r.failed_empty.applied, false);
  });
  check('整体成功但明细为空不得报已核验', () => {
    assert.strictEqual(r.applied_no_items.status, 'no_items');
    assert.strictEqual(r.applied_no_items.applied, false);
  });
  check('真实回读为空不得报已核验', () => {
    assert.strictEqual(r.applied_empty_readback.status, 'readback_mismatch');
    assert.strictEqual(r.applied_empty_readback.applied, false);
  });
  check('回读主状态仍是 new 不得报已核验', () => {
    assert.strictEqual(r.readback_status_new.status, 'readback_mismatch');
    assert.strictEqual(r.readback_status_new.applied, false);
  });
  check('回读缺实施版本不得报已核验', () => {
    assert.strictEqual(r.readback_no_version.applied, false);
  });
  check('回读缺实施提交不得报已核验', () => {
    assert.strictEqual(r.readback_no_sha.applied, false);
  });
  check('回读提交与本次部署不一致不得报已核验', () => {
    assert.strictEqual(r.readback_other_sha.applied, false);
    assert.ok(String(r.readback_other_sha.reason).includes('不一致'), '原因里必须写明提交不一致');
  });
  check('回读版本与本次部署不一致不得报已核验', () => {
    assert.strictEqual(r.readback_other_version.applied, false);
  });
  check('回读缺修订号不得报已核验', () => {
    assert.strictEqual(r.readback_no_revision.applied, false);
  });
  check('回读无发布事件不得报已核验', () => {
    assert.strictEqual(r.readback_no_event.applied, false);
  });
  check('仍有未完成明细时不得报已核验', () => {
    assert.strictEqual(r.with_pending.status, 'applied_with_pending');
    assert.strictEqual(r.with_pending.applied, false);
    assert.deepStrictEqual(r.with_pending.pending, ['9']);
  });

  // ---- 正例：只有全部对得上才是 applied_verified ----
  check('全部对得上才报 applied_verified', () => {
    assert.strictEqual(r.all_good.status, 'applied_verified');
    assert.strictEqual(r.all_good.applied, true);
  });
  check('短提交号前缀一致仍算通过', () => {
    assert.strictEqual(r.short_sha.status, 'applied_verified');
  });
  check('全为不相关项单独成态，不冒充已核验实施', () => {
    assert.strictEqual(r.all_skipped.status, 'applied_verified_no_implementation');
    assert.notStrictEqual(r.all_skipped.status, 'applied_verified');
  });

  // ---- 发布前闸门 ----
  check('缺反馈核对依据必须阻止部署', () => {
    assert.ok(r.gate_no_evidence.startsWith('blocked'), '没有核对依据时部署必须被拒绝');
    assert.ok(r.gate_no_evidence.includes('缺少本批反馈核对依据'));
  });
  check('提供批次编号时放行到只读核查', () => {
    assert.strictEqual(r.gate_with_run_id, 'passed');
  });
  check('证据文件不存在必须阻止部署', () => {
    assert.ok(r.gate_missing_file.startsWith('blocked'));
  });
  check('查询不完整不得作为证据', () => {
    assert.ok(r.evidence_incomplete.length > 0);
  });
  check('缺核对人不得作为证据', () => {
    assert.ok(r.evidence_no_operator.length > 0);
  });
  check('缺候选清单不得作为证据', () => {
    assert.ok(r.evidence_no_candidates.length > 0);
  });
  check('候选结论不是 unrelated 不得作为证据', () => {
    assert.ok(r.evidence_related.some(item => item.includes('unrelated')));
  });
  check('不相关但没写理由不得作为证据', () => {
    assert.ok(r.evidence_unrelated_no_reason.some(item => item.includes('理由')));
  });
  check('证据超过时效不得使用', () => {
    assert.ok(r.evidence_stale.some(item => item.includes('小时')));
  });
  check('证据提交与本次发布不一致不得使用', () => {
    assert.ok(r.evidence_other_sha.some(item => item.includes('不一致')));
  });
  check('证据时间无法解析不得使用', () => {
    assert.ok(r.evidence_bad_time.some(item => item.includes('无法解析')));
  });
  check('空候选清单加完整查询可作为无相关反馈证据', () => {
    assert.deepStrictEqual(r.evidence_ok, []);
  });
  check('写明理由的不相关候选可作为证据', () => {
    assert.deepStrictEqual(r.evidence_unrelated_ok, []);
  });

  console.log(`\n反馈闭环判据：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项：');
    failures.forEach(item => console.log('  - ' + item));
    process.exit(1);
  }
}

main();
