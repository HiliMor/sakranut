import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSnapshot } from '../src/ui-lib.js';
import { validateTracks, weeklyPatterns } from '../src/tracking-lib.js';
import { validTitle } from '../src/identification.js';

export const TRENDS_RSS = 'https://trends.google.com/trending/rss?geo=IL';
const MAX_BYTES = 256 * 1024;
const normalized = value => value.normalize('NFC').replaceAll('_',' ').replace(/\s+/g,' ').trim();
function decodeXml(value) {
  const text=value.trim();
  const cdata=text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) return cdata[1];
  return text.replace(/&([^;]+);/g,(_,code)=>{
    const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
    if (Object.hasOwn(named,code)) return named[code];
    const number=/^#x[0-9a-f]+$/i.test(code)?parseInt(code.slice(2),16):/^#\d+$/.test(code)?Number(code.slice(1)):NaN;
    if (!Number.isSafeInteger(number)||number<1||number>0x10ffff||(number>=0xd800&&number<=0xdfff)) throw new Error('Unsupported XML entity');
    return String.fromCodePoint(number);
  });
}
const tag=(value,name)=>{
  const matches=[...value.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`,'g'))];
  if(matches.length!==1) throw new Error('Unexpected RSS field');
  return decodeXml(matches[0][1]);
};

// Deliberately a narrow format probe, not a general XML parser or product
// integration. No DTD, entity expansion, article content, pictures or links.
export function parseTrendsProbe(xml, now=new Date()) {
  if(typeof xml!=='string'||Buffer.byteLength(xml)>MAX_BYTES||/<!DOCTYPE|<!ENTITY/i.test(xml)
    ||!xml.includes('<rss ')||!xml.includes('</rss>')) throw new Error('Unsupported RSS body');
  const channel=xml.split('<item>')[0];
  if(tag(channel,'link')!==TRENDS_RSS) throw new Error('Not the Israel RSS feed');
  const fragments=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  if(!fragments.length||fragments.length>100||fragments.length!==(xml.match(/<item>/g)||[]).length) throw new Error('Unavailable RSS items');
  return fragments.map(([,item])=>{
    const query=tag(item,'title'), approxTraffic=tag(item,'ht:approx_traffic'), timestamp=Date.parse(tag(item,'pubDate'));
    if(!validTitle(query)||!/^\d[\d,]*\+$/.test(approxTraffic)||!Number.isFinite(timestamp)||timestamp>now.getTime()+300_000) throw new Error('Invalid RSS observation');
    return {query,approxTraffic,providerTimestamp:new Date(timestamp).toISOString()};
  });
}

export function selectTrendsSample(snapshot, tracks=null) {
  validateSnapshot(snapshot);
  const popular=[...snapshot.articles].sort((a,b)=>b.views-a.views);
  const rising=[...snapshot.articles].filter(article=>article.ratio!==null).sort((a,b)=>b.ratio-a.ratio);
  const patterns=weeklyPatterns(tracks,snapshot.dataDate,{limit:2});
  const ordered=[...popular.slice(0,3),...rising.slice(0,3),...patterns.persistent,...patterns.cooled,...popular];
  const seen=new Set();
  return ordered.flatMap(article=>{
    if(seen.has(article.title)) return [];seen.add(article.title);
    return [{title:article.title,views:article.views}];
  }).slice(0,10);
}

export function summarizeTrendsProbe(items, sample, wikiDate, fetchedAt) {
  return {schemaVersion:1,sourceUrl:TRENDS_RSS,fetchedAt,referenceWikiDate:wikiDate,
    feedItems:items.length,sampleTitles:sample.length,
    titleMatches:sample.flatMap(article=>items.filter(item=>normalized(item.query)===normalized(article.title))
      .map(item=>({wikiTitle:article.title,query:item.query,providerTimestamp:item.providerTimestamp,approxTraffic:item.approxTraffic}))),
    sample:sample.map(article=>article.title),
    dateComparable:false,
    note:'Title overlap only. RSS is a rolling trend list, not a UTC daily series or a causal explanation. Absence is not zero.'};
}

export async function probeTrends({runtimeDir,fetchImpl=fetch,now=()=>new Date()}) {
  if(!isAbsolute(runtimeDir)||resolve(runtimeDir)==='/') throw new Error('Use an existing dedicated runtime');
  const snapshot=JSON.parse(await readFile(join(runtimeDir,'public/snapshot.json'),'utf8'));
  let tracks=null;
  try {tracks=validateTracks(JSON.parse(await readFile(join(runtimeDir,'public/tracks.json'),'utf8')));} catch(error) {if(error.code!=='ENOENT') throw error;}
  const sample=selectTrendsSample(snapshot,tracks); // Freeze sample before fetching.
  const response=await fetchImpl(TRENDS_RSS,{redirect:'error',headers:{
    'User-Agent':'Sakranut/0.2 source feasibility (https://github.com/HiliMor/sakranut)',
    Accept:'application/rss+xml,text/xml'},signal:AbortSignal.timeout(15_000)});
  if(!response.ok||!/(?:rss\+xml|text\/xml|application\/xml)/i.test(response.headers.get('content-type')||'')) {
    await response.body?.cancel();throw new Error('RSS unavailable; no retry or access workaround');
  }
  const reader=response.body.getReader();const chunks=[];let size=0;
  try {
    for(;;) {
      const {done,value}=await reader.read();if(done) break;
      size+=value.byteLength;if(size>MAX_BYTES) throw new Error('RSS exceeded probe size limit');chunks.push(value);
    }
  } finally {await reader.cancel();}
  const fetchedAt=now().toISOString();
  const items=parseTrendsProbe(Buffer.concat(chunks).toString('utf8'),new Date(fetchedAt));
  return {...summarizeTrendsProbe(items,sample,snapshot.dataDate,fetchedAt),responseStatus:response.status,bytes:size};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [flag,runtimeDir,...extra]=process.argv.slice(2);
  if(flag!=='--runtime'||!runtimeDir||extra.length) {console.error('Usage: probe-trends.mjs --runtime ABS_EXISTING_RUNTIME');process.exitCode=1;}
  else probeTrends({runtimeDir}).then(result=>console.log(JSON.stringify(result,null,2)))
    .catch(()=>{console.error('Trends probe unavailable or invalid. No website, runtime or schedule was changed.');process.exitCode=2;});
}
