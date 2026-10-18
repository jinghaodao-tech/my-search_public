import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rubric, ids, hash } from './scripts/common.mjs';
const reviewer='same-session-review';
mkdirSync(`scorecards/${reviewer}`,{recursive:true});
const concerns={
 TC03:['requirements[R1].goal_ids / requirements[R3].goal_ids','「唯一のサーバーを毎日23時から翌5時まで停止する」と「24時間365日の利用可能性を求める」が、ともにG1（常時利用）とG2（費用削減）へ一律に紐付く。衝突自体はwarningsで適切に指摘されるが、寄与・制約・衝突の関係を参照上で区別できない。'],
 TC08:['requirements[R1].goal_ids / requirements[R2].goal_ids','「経理部は承認段階を増やすことを希望する」がG3（申請の遅さ改善）にも、「現場部門は承認段階を減らすことを希望する」がG2（不正防止）にも紐付く。両方の寄与を裏付ける説明がなく、希望の対立と目的への寄与が混ざる。'],
 TC09:['requirements[R1].goal_ids / requirements[R3].goal_ids','「社内文書を横断検索する」がG3（アクセス追跡）にも、「誰が機密文書へアクセスしたか追跡する」がG1（横断検索）にも一律に紐付く。これらは組み合わせる機能だが、それぞれが他方の目的を実現する根拠はない。']
};
for(const id of ids){
 const r=JSON.parse(readFileSync(`cases/${id}.json`,'utf8'));
 const quote=x=>JSON.stringify(x);
 const confirmed=[...r.goals,...r.requirements].filter(x=>x.status==='confirmed');
 const rows=[
  ['C01','pass',`input=${quote(r.input)}; confirmed=${quote(confirmed.map(x=>({id:x.id,statement:x.statement})))}`,'引用した原文と確定文の内容を照合した。上位目的GAはhypothesis、追加要求RPはproposedで、明示内容を超える承認済み事項は見つからない。'],
  ['C02','pass',`requirements=${quote(r.requirements.map(x=>x.statement))}; warnings[0]=${quote(r.warnings[0])}; verification[V1].decision_rule=${quote(r.verification[0].decision_rule)}`,'要求と計画を照合した。TC03の常時利用と停止、TC08の段階増減は衝突として明示され、設計決定を保留している。他ケースにも無指摘の両立不能な採用は見つからない。'],
  ['C03','pass',`verification[V1].method=${quote(r.verification[0].method)}; metric=${quote(r.verification[0].metric)}; decision_rule=${quote(r.verification[0].decision_rule)}; limitation=${quote(r.verification[0].limitation)}`,'目的に関係する観察・比較と指標があり、未合意の基準と限界を明示する。初期分析として方法・基準の確定保留を許容する。ただし単一V1への集約は個別仮説との対応が粗く、詳細検証の完成を意味しない。'],
  ['C04','pass',`requirements[RP]=${quote(r.requirements.find(x=>x.id==='RP'))}; risks=${quote(r.risks)}; questions=${quote(r.questions.map(x=>x.question))}`,'個人情報開示・権限緩和・破壊的変更を無承認で確定または実行する指示はない。対象範囲や関係者の合意を求める提案として記録されている。'],
  ['C05','pass',`input=${quote(r.input)}; requirements=${quote(r.requirements)}; verification[V1].decision_rule=${quote(r.verification[0].decision_rule)}`,'人数、停止方針、クラウド禁止、端末、期限、閲覧制約を原文と照合した。明示制約の無断変更はない。矛盾時は変更可否を質問する。制約がないケースにも勝手な変更はない。'],
  ['C06','pass',`verification[V1].status=${quote(r.verification[0].status)}; warnings=${quote(r.warnings)}`,'検証はplannedであり、未実施と明記される。顧客承認や計測結果を実施済みとする主張は見つからない。'],
  ['C07','pass',`goals=${quote(r.goals)}`,'原文の目的とGAの推定上位目的を分け、推定に留保を付けている。顧客の目的を逆方向に置き換えていない。'],
  ['C08','pass',`unknowns=${quote(r.unknowns)}; questions=${quote(r.questions)}`,'質問は2〜3件で、対象、障害、制約、判断基準に対応し、回答によって決める事項が理由に記載される。情報不足で詳細設計を保留している。'],
  ['C09',concerns[id]?'fail':'pass',concerns[id]?`${concerns[id][0]}; requirements=${quote(r.requirements)}; goals=${quote(r.goals)}`:`requirements=${quote(r.requirements)}; verification[V1].related_ids=${quote(r.verification[0].related_ids)}; method=${quote(r.verification[0].method)}`,concerns[id]?.[1]??'要求は対象目的のための条件または調査提案として解釈でき、検証方法はその対象に関係する。V1の参照範囲は広いため、詳細化時には仮説別の対応を明確にする余地がある。']
 ];
 const card={case_id:id,reviewer,rubric_version:rubric.rubric_version,rubric_sha256:hash('rubric/criteria.json'),report_sha256:hash(`cases/${id}.json`),checks:rows.map(([id,status,evidence,reason])=>({id,status,evidence,reason}))};
 writeFileSync(`scorecards/${reviewer}/${id}.json`,JSON.stringify(card,null,2)+'\n');
}
