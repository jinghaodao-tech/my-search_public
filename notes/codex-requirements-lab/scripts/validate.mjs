import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = v => typeof v === 'string' && v.trim().length > 0;
const rootKeys = ['case_id','input','goals','requirements','hypotheses','unknowns','questions','verification','risks','warnings'];
const definitions = {
  goals: { keys:['id','statement','status','source'], enums:{ status:['confirmed','hypothesis'] } },
  requirements: { keys:['id','statement','status','kind','source','goal_ids'], enums:{ status:['confirmed','proposed'], kind:['business','functional','non_functional','constraint'] }, arrays:['goal_ids'] },
  hypotheses: { keys:['id','statement','source'] },
  unknowns: { keys:['id','statement','impact','resolution'] },
  questions: { keys:['id','question','reason','priority','unknown_ids'], enums:{ priority:['high','medium'] }, arrays:['unknown_ids'] },
  verification: { keys:['id','claim','method','metric','decision_rule','limitation','related_ids','status'], enums:{status:['planned','completed']}, arrays:['related_ids'] },
  risks: { keys:['id','description','mitigation'] }
};

export function validate(report, expectedId, expectedInput) {
  const errors=[];
  if(!isObj(report)) return ['ルートがオブジェクトでない'];
  for(const k of rootKeys) if(!(k in report)) errors.push(`${k}: 必須キーなし`);
  for(const k of Object.keys(report)) if(!rootKeys.includes(k)) errors.push(`${k}: 余分なキー`);
  if(!/^TC\d{2}$/.test(report.case_id ?? '')) errors.push('case_id: TCxx形式でない');
  if(expectedId && report.case_id !== expectedId) errors.push(`case_id: ${expectedId} ではない`);
  if(!nonEmpty(report.input)) errors.push('input: 空');
  if(expectedInput !== undefined && report.input.trim() !== expectedInput.trim()) errors.push('input: ケース原文と異なる');
  const allIds=new Set(), idsBySection={};
  for(const [section, def] of Object.entries(definitions)) {
    const arr=report[section];
    if(!Array.isArray(arr)) { errors.push(`${section}: 配列でない`); continue; }
    idsBySection[section]=new Set();
    if(['goals','unknowns','verification'].includes(section) && arr.length===0) errors.push(`${section}: 1件以上必要`);
    if(section==='questions' && arr.length>3) errors.push('questions: 3件超');
    arr.forEach((item,i)=>{
      const loc=`${section}[${i}]`;
      if(!isObj(item)) {errors.push(`${loc}: オブジェクトでない`); return;}
      for(const k of def.keys) if(!(k in item)) errors.push(`${loc}.${k}: 必須キーなし`);
      for(const k of Object.keys(item)) if(!def.keys.includes(k)) errors.push(`${loc}.${k}: 余分なキー`);
      for(const k of def.keys) {
        if(! (k in item)) continue;
        if((def.arrays??[]).includes(k)) {
          if(!Array.isArray(item[k])||item[k].some(v=>!nonEmpty(v))) errors.push(`${loc}.${k}: 文字列の配列でない`);
        } else if(def.enums?.[k]) {
          if(!def.enums[k].includes(item[k])) errors.push(`${loc}.${k}: 不正な値`);
        } else if(!nonEmpty(item[k])) errors.push(`${loc}.${k}: 空または文字列でない`);
      }
      if(nonEmpty(item.id)) {
        if(allIds.has(item.id)) errors.push(`${loc}.id: 重複 ${item.id}`);
        allIds.add(item.id); idsBySection[section].add(item.id);
      }
    });
  }
  if(!Array.isArray(report.warnings)||report.warnings.some(v=>!nonEmpty(v))) errors.push('warnings: 空でない文字列の配列ではない');
  for(const [section,key,target] of [['requirements','goal_ids','goals'],['questions','unknown_ids','unknowns']]) {
    for(const [i,row] of (Array.isArray(report[section])?report[section]:[]).entries()) {
      for(const id of (Array.isArray(row?.[key])?row[key]:[])) if(!(idsBySection[target]?.has(id))) errors.push(`${section}[${i}].${key}: 存在しない参照 ${id}`);
    }
  }
  const claimIds=new Set([...idsBySection.goals??[],...idsBySection.requirements??[],...idsBySection.hypotheses??[]]);
  for(const [i,row] of (Array.isArray(report.verification)?report.verification:[]).entries()) {
    if(row?.status==='completed') errors.push(`verification[${i}].status: この実験では未実施のためplannedのみ`);
    if(Array.isArray(row?.related_ids)) {
      if(row.related_ids.length===0) errors.push(`verification[${i}].related_ids: 空`);
      for(const id of row.related_ids) if(!claimIds.has(id)) errors.push(`verification[${i}].related_ids: 存在しない参照 ${id}`);
    }
  }
  return errors;
}

export function readAndValidate(path, expectedId, inputPath) {
  try {
    const report=JSON.parse(readFileSync(path,'utf8'));
    const input=inputPath ? readFileSync(inputPath,'utf8') : undefined;
    return validate(report,expectedId,input);
  } catch(e) {return [`読み取り/JSON失敗: ${e.message}`];}
}
