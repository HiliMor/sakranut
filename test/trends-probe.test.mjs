import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTrendsProbe,selectTrendsSample,summarizeTrendsProbe,probeTrends,TRENDS_RSS } from '../scripts/probe-trends.mjs';
const now=new Date('2026-10-03T19:40:00Z');
const item=(title='ישראל',traffic='2,000+',date='Sat, 3 Oct 2026 11:40:00 -0700')=>`<item><title>${title}</title><ht:approx_traffic>${traffic}</ht:approx_traffic><pubDate>${date}</pubDate><ht:news_item><ht:news_item_title>Not a measurement</ht:news_item_title></ht:news_item></item>`;
const rss=(body=item())=>`<rss version="2.0"><channel><link>${TRENDS_RSS}</link>${body}</channel></rss>`;
test('probe projects measured metadata only, preserving a traffic bucket rather than inventing exact searches',()=>{
  assert.deepEqual(parseTrendsProbe(rss(),now),[{query:'ישראל',approxTraffic:'2,000+',providerTimestamp:'2026-10-03T18:40:00.000Z'}]);
});
test('HTML/DTD/entities, wrong geography, malformed fields and future times are rejected',()=>{
  for(const xml of ['<html>blocked</html>','<!DOCTYPE rss>'+rss(),rss().replace('geo=IL','geo=US'),rss(item('ישראל','unknown')),rss(item('ישראל','2+','bad')),rss(item('ישראל','2+','Sun, 4 Oct 2026 11:40:00 -0700'))]) assert.throws(()=>parseTrendsProbe(xml,now));
  assert.throws(()=>parseTrendsProbe(rss(item('ישראל &unknown;')),now));
});
test('one-off parser decodes titles without executing markup and rejects oversized or incomplete RSS',()=>{
  assert.equal(parseTrendsProbe(rss(item('א &amp; ב')),now)[0].query,'א & ב');
  assert.equal(parseTrendsProbe(rss(item('<![CDATA[א &amp; ב]]>')),now)[0].query,'א &amp; ב');
  assert.throws(()=>parseTrendsProbe(rss()+'x'.repeat(256*1024),now));
  assert.throws(()=>parseTrendsProbe(rss().replace('</item>',''),now));
});
test('matching is conservative lexical overlap, never a fuzzy entity or same-day causal finding',()=>{
  const items=parseTrendsProbe(rss(item('ישראל')+item('אסף רפפורט')),now);
  const summary=summarizeTrendsProbe(items,[{title:'ישראל',views:100},{title:'אסף_רפפורט',views:200},{title:'אסף',views:300}], '2026-10-02',now.toISOString());
  assert.equal(summary.titleMatches.length,2);assert.equal(summary.sampleTitles,3);assert.equal(summary.dateComparable,false);
  assert(!Object.hasOwn(summary,'cause'));assert(!Object.hasOwn(summary,'combinedScore'));
});
test('sample is deterministic, bounded and selected from measured records before feed access',async()=>{
  const snapshot=JSON.parse(await readFile(new URL('../public/data/snapshot.json',import.meta.url),'utf8'));
  const before=JSON.stringify(snapshot),sample=selectTrendsSample(snapshot);
  assert.equal(sample.length,10);assert.equal(new Set(sample.map(item=>item.title)).size,10);
  assert.deepEqual(selectTrendsSample(snapshot),sample);assert.equal(JSON.stringify(snapshot),before);
});

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'sakranut-trends-probe-'));
  await mkdir(join(root,'public'));
  const bytes=await readFile(new URL('../public/data/snapshot.json',import.meta.url));
  await writeFile(join(root,'public/snapshot.json'),bytes);
  return {root,bytes};
}

test('one public request has fixed geography, no credentials or retry, and rejects rate limits or HTML',async()=>{
  const {root,bytes}=await fixture();
  try {
    for(const response of [new Response('limited',{status:429}),new Response('blocked',{status:403}),new Response('<html>login</html>',{headers:{'content-type':'text/html'}})]) {
      let calls=0;
      await assert.rejects(probeTrends({runtimeDir:root,fetchImpl:async(url,options)=>{
        calls++;assert.equal(url,TRENDS_RSS);assert.equal(options.redirect,'error');
        assert.equal(options.headers.Authorization,undefined);assert(options.signal instanceof AbortSignal);
        return response;
      }}),/unavailable/);
      assert.equal(calls,1);
    }
    assert.deepEqual(await readFile(join(root,'public/snapshot.json')),bytes);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('stream size is bounded and an accepted response still discards news fields',async()=>{
  const {root,bytes}=await fixture();
  try {
    await assert.rejects(probeTrends({runtimeDir:root,fetchImpl:async()=>new Response('x'.repeat(256*1024+1),{headers:{'content-type':'text/xml'}})}),/size limit/);
    const result=await probeTrends({runtimeDir:root,now:()=>now,fetchImpl:async()=>new Response(rss(),{headers:{'content-type':'text/xml'}})});
    assert.equal(result.feedItems,1);assert.equal(result.dateComparable,false);
    assert(!JSON.stringify(result).includes('Not a measurement'));
    assert.deepEqual(await readFile(join(root,'public/snapshot.json')),bytes);
  } finally {await rm(root,{recursive:true,force:true});}
});
