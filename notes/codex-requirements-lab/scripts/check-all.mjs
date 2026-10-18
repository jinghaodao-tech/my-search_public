import { readAndValidate } from './validate.mjs';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
const results=[];
for(let i=1;i<=10;i++) {
  const id=`TC${String(i).padStart(2,'0')}`;
  const errs=readAndValidate(`output/${id}/report.json`,id,`cases/${id}.txt`);
  results.push({case_id:id,ok:errs.length===0,errors:errs});
  console.log(`${id}: ${errs.length===0?'OK':'NG ('+errs.length+'件)'}`);
  for(const err of errs) console.log('  - '+err);
}
if(!existsSync('output')) mkdirSync('output',{recursive:true});
writeFileSync('output/structure-results.json',JSON.stringify({results,passed:results.filter(x=>x.ok).length,total:results.length,semantic_evaluation:false},null,2)+'\n');
const passed=results.filter(x=>x.ok).length;
console.log(`構造検証: ${passed}/${results.length} 成功。意味的妥当性は未検証。`);
if(passed!==results.length) process.exitCode=1;
