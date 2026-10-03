import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { articleSeriesUrl, buildArticle, calculateMetrics, METHOD, shiftDate, topUrl, windowFor } from '../data-lib.mjs';
import { atomicJson } from '../runtime-lib.mjs';
import { compareObservations, inspectRollover, readObservation } from '../scripts/verify-rollover.mjs';

const afterDate = '2026-10-02';
const hash = 'a'.repeat(64);
const points = date => Array.from({length:35}, (_, i) => ({date:shiftDate(windowFor(date).seriesStart, i),views:100}));
const api = series => series.map(point => ({timestamp:`${point.date.replaceAll('-','')}00`,views:point.views}));
function bundle(date = '2026-10-03') {
  const generatedAt = `${shiftDate(date,1)}T03:20:00Z`;
  const series = points(date);
  const snapshot = {schemaVersion:1,generatedAt,dataDate:date,...windowFor(date),
    source:{name:'Wikimedia Analytics API',license:'CC0 1.0',licenseUrl:'https://creativecommons.org/publicdomain/zero/1.0/',
      url:'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html',
      policyUrl:'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html',topUrl:topUrl(date)},
    method:structuredClone(METHOD),coverage:{requestedDate:date,fallbackDays:0,topListCount:1,candidateCount:1,articleCount:1,failures:[]},
    articles:[buildArticle({article:'ישראל',rank:1},api(series),date)],uncomparedArticles:[]};
  const checkedAt = `${shiftDate(date,1)}T03:22:00Z`;
  const status = {schemaVersion:1,mode:'scheduled',checkedAt,lastSuccessAt:generatedAt,dataDate:date,targetDate:date,state:'healthy',message:'Healthy',
    coverage:{candidateCount:1,articleCount:1,failuresCount:0},monitoring:{configured:true}};
  const archive = {schemaVersion:1,generatedAt:checkedAt,latestDate:date,latestGeneratedAt:generatedAt,
    availableDates:[...new Set([afterDate,date])].sort()};
  const periodStart = shiftDate(date,-29);
  const tracks = {schemaVersion:1,dataDate:date,periodStart,seriesStart:windowFor(periodStart).seriesStart,generatedAt:checkedAt,
    availableDates:archive.availableDates,items:[{title:'ישראל',sampleDates:[date],series},
      {title:'אסף רפפורט',sampleDates:[afterDate],series:structuredClone(series)}]};
  return {snapshot,status,archive,tracks,afterDate,snapshotSha256:hash,now:new Date(`${shiftDate(date,1)}T03:30:00Z`)};
}
const report = value => inspectRollover(value ?? bundle());
const later = value => ({...value,now:new Date(value.now.getTime()+3*3600000),status:{...value.status,checkedAt:new Date(Date.parse(value.status.checkedAt)+3*3600000).toISOString()}});

test('the baseline is the preceding 28-day median, not the average or the evaluated week',()=>{
  const series=points('2026-10-03'); series[0].views=1_000_000;
  series.slice(-7).forEach(point=>{point.views=5000;});
  const metrics=calculateMetrics(series);
  assert.equal(metrics.baseline,100); assert.equal(metrics.ratio,50);
  assert.equal(articleSeriesUrl('ישראל','2026-10-03').includes('2026083000'),true);
});
test('the next day is not due before its UTC day has ended',()=>{
  const value=bundle(afterDate),result=report(value);
  assert.equal(result.phase,'not_due'); assert.equal(result.readyForRepeatCheck,false);
});
test('upstream waiting with retained healthy measurements is not a failed server',()=>{
  const value=bundle(afterDate); value.now=new Date('2026-10-04T03:30:00Z');
  value.status={...value.status,checkedAt:'2026-10-04T03:22:00Z',targetDate:'2026-10-03',state:'waiting'};
  assert.equal(report(value).phase,'waiting_for_new_day'); assert.deepEqual(report(value).issues,[]);
});
test('an actual new day and a followed measured tail prepare, but do not complete, a repeat check',()=>{
  const result=report();
  assert.equal(result.phase,'new_day_observed'); assert.equal(result.readyForRepeatCheck,true);
  assert.equal(result.tracking.followedMeasured,1); assert.equal(result.tracking.examples[0].date,'2026-10-03');
  assert.equal(result.tracking.examples[0].title,'אסף רפפורט');
  assert(!Object.hasOwn(result,'stableRepeat'));
});
test('observed zero is a measured tail and absence is unknown, not zero',()=>{
  const value=bundle(); value.tracks.items[1].series.at(-1).views=0;
  assert.equal(report(value).tracking.examples[0].views,0);
  value.tracks.items[1].series.pop();
  const result=report(value); assert.equal(result.phase,'tracking_catching_up'); assert.equal(result.tracking.unknownToday,1);
  assert.deepEqual(result.tracking.examples,[]);
});
test('tracking publication may lag without converting a valid new measurement into failure',()=>{
  const value=bundle(); value.tracks=bundle(afterDate).tracks;
  const result=report(value); assert.equal(result.phase,'tracking_catching_up'); assert.deepEqual(result.issues,[]);
  value.tracks=null; assert.equal(report(value).phase,'tracking_catching_up');
});
test('the new archive must match the snapshot and retain the starting edition',()=>{
  const value=bundle(); value.archive=bundle(afterDate).archive;
  assert.equal(report(value).phase,'archive_catching_up');
  value.archive=bundle().archive; value.archive.availableDates=['2026-10-03'];
  assert.equal(report(value).archiveAligned,false);
});
test('an empty followed cohort cannot prove follow-up after departure',()=>{
  const value=bundle(); value.tracks.items.pop();
  assert.equal(report(value).phase,'new_day_observed'); assert.equal(report(value).readyForRepeatCheck,false);
  assert.equal(compareObservations(report(value),report(later(value))).stableRepeat,false);
});
test('new retrospective imports cannot be reported as a scheduled daily rollover',()=>{
  const value=bundle(); value.snapshot.collectionOrigin='retrospective';
  assert.equal(report(value).phase,'attention'); assert(report(value).issues.includes('new_day_is_retrospective'));
});
test('future days, malformed measurements and inadequate complete coverage fail validation',()=>{
  const value=bundle(); value.now=new Date('2026-10-03T18:00:00Z'); assert.throws(()=>report(value));
  const bad=bundle(); bad.snapshot.articles[0].views=-1; assert.throws(()=>report(bad));
  const coverage=bundle(); coverage.snapshot.coverage.candidateCount=2;
  coverage.snapshot.coverage.topListCount=2; coverage.snapshot.coverage.failures=[{title:'חסר',reason:'Unavailable'}];
  assert.throws(()=>report(coverage));
});
test('inconsistent status, future timestamps and stale checks require attention',()=>{
  const value=bundle(); value.status.dataDate=afterDate;
  assert.equal(report(value).phase,'attention');
  const future=bundle(); future.tracks.generatedAt='2026-10-05T03:22:00Z';
  assert(report(future).issues.includes('future_publication'));
  const stale=bundle(); stale.now=new Date('2026-10-04T12:30:00Z');
  assert.equal(report(stale).phase,'attention');
  const target=bundle(); target.status.targetDate='2026-10-04';
  assert(report(target).issues.includes('invalid_runner_target'));
});
test('seeing the same collector stamp twice, or an extra health stamp, proves no repeat',()=>{
  const first=report(),second={...first,observedAt:'2026-10-04T04:30:00Z',healthCheckedAt:'2026-10-04T04:45:00Z'};
  assert.deepEqual(compareObservations(first,second),{phase:'same_collector_check',stableRepeat:false});
});
test('only a subsequent collector check with preserved measurement bytes/times verifies a repeat',()=>{
  const value=bundle();
  assert.deepEqual(compareObservations(report(value),report(later(value))),{phase:'verified_repeat',stableRepeat:true});
});
test('changed bytes or last-success time on a same-day check cannot pass',()=>{
  const first=report(),second=report(later(bundle()));
  assert.equal(compareObservations(first,{...second,snapshotSha256:'b'.repeat(64)}).phase,'same_day_measurement_changed');
  assert.equal(compareObservations(first,{...second,lastSuccessAt:'2026-10-04T06:20:00Z'}).stableRepeat,false);
  assert.equal(compareObservations(first,{...second,generatedAt:'2026-10-04T06:20:00Z'}).stableRepeat,false);
});
test('different days cannot substitute for same-day repetition; lost archive dates remain a defect',()=>{
  const first=report(),second=report(bundle('2026-10-04'));
  second.archiveDates=['2026-10-02','2026-10-03','2026-10-04'];
  assert.equal(compareObservations(first,second).phase,'different_days');
  second.archiveDates=['2026-10-04']; assert.equal(compareObservations(first,second).phase,'archive_lost_dates');
});
test('regressing dates or collector stamps and malformed checkpoints never prove success',()=>{
  const first=report(),second=report(later(bundle()));
  assert.equal(compareObservations(second,first).phase,'regression');
  for(const bad of [{},{...first,archiveDates:null},{...first,phase:'attention'},{...first,afterDate:'2026-02-30'}]) assert.throws(()=>compareObservations(bad,second));
});
test('a diagnostic read and CLI observation leave every runtime product byte-identical',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sakranut-rollover-test-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const value=bundle(afterDate),names=['snapshot','status','archive','tracks'];
  for(const name of names) await atomicJson(join(root,'public',`${name}.json`),value[name]);
  const before=await Promise.all(names.map(name=>readFile(join(root,'public',`${name}.json`),'utf8')));
  const result=await readObservation({runtimeDir:root,afterDate,now:value.now}); assert.equal(result.phase,'not_due');
  const output=spawnSync(process.execPath,['scripts/verify-rollover.mjs','--runtime',root,'--after',afterDate],{encoding:'utf8'});
  // Wall-clock status freshness may differ; the CLI still only reads products.
  assert([0,2].includes(output.status));
  if(output.stdout.trim()) assert.equal(JSON.parse(output.stdout).schemaVersion,1);
  else assert.match(output.stderr,/Rollover observation unavailable or invalid; no files were changed\./);
  assert.deepEqual(await Promise.all(names.map(name=>readFile(join(root,'public',`${name}.json`),'utf8'))),before);
  await assert.rejects(readObservation({runtimeDir:'/',afterDate}));
  await assert.rejects(readObservation({runtimeDir:root,afterDate:'2026-02-30'}));
});
