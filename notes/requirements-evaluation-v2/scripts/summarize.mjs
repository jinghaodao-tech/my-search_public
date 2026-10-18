import {existsSync,writeFileSync} from 'node:fs';
import {rubric,ids,validReviewer,scorePath,checkCard,root} from './common.mjs';
const reviewer=process.argv[2];validReviewer(reviewer);
let rows=[];
for(const id of ids){
 const path=scorePath(reviewer,id);
 if(!existsSync(path)){rows.push({case_id:id,status:'missing_scorecard'});continue;}
 const card=JSON.parse((await import('node:fs')).readFileSync(path,'utf8'));
 const count=checkCard(card,id,reviewer);
 const complete=count.pending===0&&count.not_applicable===0; // Even NA critical/normal cannot certify. Report only conditional coverage.
 const counted=count.pass+count.fail;
 const qualityScore=counted>0?+(count.pass/counted*100).toFixed(1):null;
 const status=count.critical_failures>0?'review_required':(!complete?'unresolved':(count.fail>0?'quality_issues':'no_issues_flagged'));
 rows.push({case_id:id,status,...count,conditional_score_pct:qualityScore,complete});
}
const out={rubric_version:rubric.rubric_version,reviewer,cases:rows.length,complete:rows.every(x=>x.complete),review_required:rows.filter(x=>x.status==='review_required').length,unresolved:rows.filter(x=>x.status==='unresolved').length,results:rows,warning:'採点は人間またはAI評価者による。検出率・AI精度ではない。pass/fail の割合は条件付き参考値。'};
writeFileSync(new URL(`summary-${reviewer}.json`,root),JSON.stringify(out,null,2)+'\n');
console.log(`${reviewer}: ${rows.length}件、critical failによる要レビュー ${out.review_required}、未解決 ${out.unresolved}`);
