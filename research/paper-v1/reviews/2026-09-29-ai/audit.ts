// 要求から直接書いた参照式。candidate、生成suite、応答fixtureは評価に使わない。
import { resolve } from 'node:path';
import { loadStudyInputs, validateLoadedStudy } from '../../../../src/paper-study-inputs';
import { createStudyReviewTemplate } from '../../../../src/paper-study-review';
import { encodeInput, WasmError } from '../../../../src/wasm-contract';
const root = resolve(import.meta.dir, '../../../..');
const loaded = await loadStudyInputs(resolve(root, 'research/paper-v1/study-draft.json'));
const validation = validateLoadedStudy(loaded);
if (validation.diagnostics.length) throw new Error(validation.diagnostics.join('; '));
const refs: Record<string, (x: Record<string, unknown>) => boolean> = {
  logic: x => x.a === true && (x.b === true || x.c === false),
  contact: x => x.email !== null && x.email !== undefined && x.tier === 'premium',
  boundary: x => x.level === 'high',
  unsupported: x => (x.email as string).endsWith('@example.com'),
};
const results = loaded.tasks.map(t => {
  if (!t.value) throw new Error(t.taskId);
  const {source, oracle} = t.value;
  const cases = oracle.cases.map(c => {
    let actual: unknown;
    try { encodeInput(source.contract, c.input); actual = {kind:'value',value:refs[t.taskId]!(c.input)}; }
    catch(e) { if (!(e instanceof WasmError) || e.code !== 'INVALID_INPUT') throw e; actual = {kind:'error',code:'INVALID_INPUT'}; }
    return {id:c.id,expected:c.expected,actual,match:JSON.stringify(actual)===JSON.stringify(c.expected)};
  });
  return {taskId:t.taskId,cases};
});
const contact = loaded.tasks.find(t=>t.taskId==='contact')!.value!;
const unsupported = loaded.tasks.find(t=>t.taskId==='unsupported')!.value!;
const logic = loaded.tasks.find(t=>t.taskId==='logic')!.value!;
const truthTable = [false,true].flatMap(a=>[false,true].flatMap(b=>[false,true].map(c=>({input:{a,b,c},expected:refs.logic!({a,b,c}),inOracle:logic.oracle.cases.some(x=>x.input.a===a&&x.input.b===b&&x.input.c===c)}))));
const notes: Record<string,string[]> = {
 logic:['有効boolean入力8通りのうち4通りのみ。残り4通りと各必須fieldの欠損・null・型不正を追加する。'],
 contact:['空文字列+premium=true、null+premium=falseがOracleにない。email状態×tierを網羅し、不正型・不正enum・必須tier欠損を追加する。','JSON Oracleでは明示undefinedを表せない。欠損と明示undefinedの区別はhost契約の別試験として記録する。'],
 boundary:['有効enum3値は網羅。欠損・null・非文字列・未知fieldの拒否を追加する。','highというカテゴリ一致課題であり、数値の境界比較の実証とは呼べない。契約外入力はunresolvedではなくINVALID_INPUTであることを文面で区別する。'],
 unsupported:['要求上の2期待値は正しいがsource例と同一であり独立な評価入力がない。別local-part、空文字列、suffix後の追記等を追加する。','要求は現行文字列ABIでは表現不能。生成結果unresolvedを期待する課題別の判断を明示する。Oracleのbool結果だけで未解決検出の成功を判定しない。'],
};
const record = createStudyReviewTemplate(loaded);
for (const t of record.tasks) {
 t.reviewer='codex-current-thread-ai'; t.independent=false;
 t.reviewedAt=new Date().toISOString();
 t.recordReference='research/paper-v1/reviews/2026-09-29-ai/REVIEW.md';
 t.checks={requirements:'pass',expressibility:'pass',unresolved:t.taskId==='boundary'||t.taskId==='unsupported'?'fail':'pass',inputBoundaries:'fail',taskOverlap:t.taskId==='unsupported'?'fail':'pass'};
 t.findings=notes[t.taskId]!.map(note=>({check:'inputBoundaries' as const,note}));
 if(t.checks.unresolved==='fail') t.findings.push({check:'unresolved',note:notes[t.taskId]![1]!});
 if(t.checks.taskOverlap==='fail') t.findings.push({check:'taskOverlap',note:notes[t.taskId]![0]!});
}
const output = {reviewType:'AI-assisted; not independent human review',studyHash:validation.studyHash,inputHashes:validation.hashes,results,truthTable,contactBoundaries:[{input:{email:'',tier:'premium'},expected:true},{input:{email:null,tier:'premium'},expected:false}].map(c=>({...c,encoded:encodeInput(contact.source.contract,c.input)})),unsupportedEncoding:['a@example.com','a@other.com'].map(email=>({email,encoded:encodeInput(unsupported.source.contract,{email})}))};
if(results.some(t=>t.cases.some(c=>!c.match))) throw new Error('Oracle expectation mismatch');
await Bun.write(resolve(import.meta.dir,'audit-results.json'),JSON.stringify(output,null,2)+'\n');
await Bun.write(resolve(import.meta.dir,'review-record.json'),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({cases:results.reduce((n,t)=>n+t.cases.length,0),mismatches:0,logicCovered:truthTable.filter(x=>x.inOracle).length,logicTotal:8}));
