import fs from 'node:fs';
import path from 'node:path';

type Arm = {top50:string[];error:string|null};
type Row = {id:string;group_id:string;gold_ids:string[];bm25:Arm;fts5Rrf:Arm};
const [inputArg,outputArg]=process.argv.slice(2);
if(!inputArg||!outputArg)throw new Error('Usage: npx tsx scripts/analyze_tomt_rank_fusion.ts <paired-top50-development.json> <new-output.json>');
const inputPath=path.resolve(inputArg),outputPath=path.resolve(outputArg);
if(fs.existsSync(outputPath))throw new Error(`Refusing to overwrite ${outputPath}`);
const source=JSON.parse(fs.readFileSync(inputPath,'utf8')) as {dataset:{split:string;sourceSha256:string};perQuery:Row[]};
if(!/^development\b/i.test(source.dataset.split)||!source.perQuery.length)throw new Error('Only a recorded development comparison is accepted; holdout data is prohibited.');
const rows=source.perQuery;
const weights=[{bm25:1,fts:0.1},{bm25:1,fts:0.25},{bm25:1,fts:0.5},{bm25:1,fts:1},{bm25:2,fts:1},{bm25:4,fts:1},{bm25:8,fts:1},{bm25:16,fts:1}];
const metrics=(ids:string[],goldIds:string[])=>{
  const gold=new Set(goldIds),rank=ids.findIndex(id=>gold.has(id)),top10=ids.slice(0,10);
  const dcg=top10.reduce((sum,id,index)=>sum+(gold.has(id)?1/Math.log2(index+2):0),0);
  const ideal=Array.from({length:Math.min(gold.size,10)},(_,index)=>1/Math.log2(index+2)).reduce((a,b)=>a+b,0);
  return {hit1:rank===0,hit10:rank>=0&&rank<10,mrr10:rank>=0&&rank<10?1/(rank+1):0,ndcg10:ideal?dcg/ideal:0};
};
const base=rows.map(row=>metrics(row.bm25.top50,row.gold_ids));
const groupIndices=new Map<string,number[]>();
rows.forEach((row,index)=>{const indices=groupIndices.get(row.group_id)??[];indices.push(index);groupIndices.set(row.group_id,indices);});
const groups=[...groupIndices.values()];
let seed=0x7a1c91e3;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};
const compareRows=weights.map(weight=>{
  const perQuery=rows.map(row=>{
    const gold=new Set(row.gold_ids),scores=new Map<string,{score:number;bm25Rank:number;ftsRank:number}>();
    row.bm25.top50.forEach((id,index)=>scores.set(id,{score:weight.bm25/(60+index+1),bm25Rank:index+1,ftsRank:Infinity}));
    row.fts5Rrf.top50.forEach((id,index)=>{
      const current=scores.get(id);
      if(current){current.score+=weight.fts/(60+index+1);current.ftsRank=index+1;}
      else scores.set(id,{score:weight.fts/(60+index+1),bm25Rank:Infinity,ftsRank:index+1});
    });
    const fused=[...scores.entries()].sort((a,b)=>b[1].score-a[1].score||a[1].bm25Rank-b[1].bm25Rank||a[1].ftsRank-b[1].ftsRank||a[0].localeCompare(b[0])).map(([id])=>id);
    return metrics(fused,row.gold_ids);
  });
  const both=perQuery.filter((item,index)=>item.hit10&&base[index]!.hit10).length;
  const bm25Only=base.filter((item,index)=>item.hit10&&!perQuery[index]!.hit10).length;
  const ftsOnly=perQuery.filter((item,index)=>item.hit10&&!base[index]!.hit10).length;
  const neither=rows.length-both-bm25Only-ftsOnly;
  const bootstrap:number[]=[];
  for(let iteration=0;iteration<10000;iteration++){
    let delta=0,sampledQueries=0;
    for(let draw=0;draw<groups.length;draw++){
      const group=groups[Math.floor(random()*groups.length)]!;
      for(const index of group){delta+=Number(perQuery[index]!.hit10)-Number(base[index]!.hit10);sampledQueries++;}
    }
    bootstrap.push(delta/sampledQueries);
  }
  bootstrap.sort((a,b)=>a-b);
  const mean=(key:'mrr10'|'ndcg10')=>perQuery.reduce((sum,item)=>sum+item[key],0)/perQuery.length;
  return {weights:weight,hit1:perQuery.filter(item=>item.hit1).length,hit10:perQuery.filter(item=>item.hit10).length,
    mrr10:mean('mrr10'),ndcg10:mean('ndcg10'),paired:{both,bm25Only,ftsOnly,neither,netHit10Difference:(ftsOnly-bm25Only)/rows.length,
      groupClusterBootstrap95CI:[bootstrap[Math.floor(.025*(bootstrap.length-1))]!,bootstrap[Math.floor(.975*(bootstrap.length-1))]!],replicates:bootstrap.length},
    perQuery:perQuery.map((metric,index)=>({id:rows[index]!.id,group_id:rows[index]!.group_id,hit10:metric.hit10,baselineHit10:base[index]!.hit10,mrr10:metric.mrr10,ndcg10:metric.ndcg10})),
  };
});
const result={audit:'exploratory post-hoc rank fusion on reused Books development data; no independent validation claim',
  inputPath,sourceDatasetSha256:source.dataset.sourceSha256,queries:rows.length,groups:groups.length,rrfConstant:60,
  candidatePool:'union of the two recorded top-50 lists; documents outside both top-50 lists are unobservable and omitted',
  baseline:{hit1:base.filter(item=>item.hit1).length,hit10:base.filter(item=>item.hit10).length,
    mrr10:base.reduce((sum,item)=>sum+item.mrr10,0)/base.length,ndcg10:base.reduce((sum,item)=>sum+item.ndcg10,0)/base.length},
  candidates:compareRows,independentEvaluation:'NOT_EVALUABLE: the development split has been repeatedly used and must not certify generalization.'};
fs.mkdirSync(path.dirname(outputPath),{recursive:true});
fs.writeFileSync(outputPath,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({outputPath,baseline:result.baseline,candidates:compareRows.map(({weights:weight,hit1,hit10,mrr10,ndcg10,paired})=>({weight,hit1,hit10,mrr10,ndcg10,paired}))},null,2));
