#!/usr/bin/env node
// Build a complete, READ-ONLY lexical regression suite from the live local cards.
// This is NOT a semantic refinding benchmark.
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
const args=process.argv.slice(2);
function opt(name,fallback){const i=args.indexOf(name);return i<0?fallback:args[i+1];}
const base=opt('--base','http://127.0.0.1:3000').replace(/\/$/,'');
const out=opt('--out','./cases/01b_live_titles.json');
if(!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(base))throw Error('Only local server allowed');
const cards=[];let offset=0,expected=null;
while(true){
 const url=new URL('/api/cards',base);url.searchParams.set('limit','100');url.searchParams.set('offset',String(offset));
 const res=await fetch(url);if(!res.ok) throw Error(`GET /api/cards: ${res.status}`);
 const p=await res.json();if(!Array.isArray(p.items)||!Number.isInteger(p.total))throw Error('Unexpected API response');
 if(expected!==null && expected!==p.total) throw Error('Cards changed while building fixture: repeat with stable DB');
 expected=p.total;cards.push(...p.items);offset+=p.items.length;
 if(!p.items.length||offset>=expected)break;
}
if(cards.length!==expected)throw Error(`Expected ${expected} cards, got ${cards.length}`);
const groups=new Map();
for(const card of cards){
 if(!card?.id||typeof card.title!=='string'||!card.title.trim())continue;
 const key=card.title.trim().normalize('NFKC').toLowerCase();
 const prev=groups.get(key) || [];
 prev.push(card);groups.set(key,prev);
}
const cases=[...groups.values()].map((group,i)=>({id:`LIVE-${String(i+1).padStart(4,'0')}`,category:'exact-live-title',query:group[0].title.trim(),targetCardIds:group.map(c=>c.id),targetTitle:group[0].title,goldBasis:'live-card-title',duplicateTitleCount:group.length}));
const data={schemaVersion:2,dataset:'Full live-card title search regression',phase:'01b_live_titles',type:'lexical_regression_only',status:'self-derived-from-running-API-not-refinding',gate:{minHit10:.98},cardCount:cards.length,cases};
await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(data,null,2)+'\n');
console.log(`Wrote ${cases.length} query groups from ${cards.length} cards to ${out}. DO NOT interpret as human refind rate.`);
