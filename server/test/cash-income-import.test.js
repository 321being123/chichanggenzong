const assert=require('assert'),crypto=require('crypto');
const {validate}=require('../scripts/importCashIncomeEvidence');
const text='official dividend fixture',contentHash=crypto.createHash('sha256').update(text).digest('hex');
const fixture={username:'daicunzai',targetDate:'2026-10-10',anchorDate:'2026-08-16',accounts:[{name:'华泰账户'},{name:'招商证券账户'}],documents:Array.from({length:75},()=>({payload:{text,announcement:{}},contentHash,sourceCode:'hkex'})),coverages:Array(38).fill({}),rates:Array(34).fill({})};
assert.strictEqual(validate(fixture),fixture);
for(const changed of [{username:'other'},{targetDate:'2026-10-11'},{accounts:[{name:'华泰账户'}]},{documents:fixture.documents.slice(1)},{rates:fixture.rates.slice(1)}])assert.throws(()=>validate({...fixture,...changed}));
assert.throws(()=>validate({...fixture,documents:fixture.documents.map((r,i)=>i===0?{...r,contentHash:'wrong'}:r)}),/哈希/);
assert.throws(()=>validate({...fixture,documents:fixture.documents.map((r,i)=>i===0?{...r,sourceCode:'unadmitted'}:r)}),/来源/);
console.log('cash income evidence import: explicit user, date, account scope, complete fact counts and source text hash passed');
