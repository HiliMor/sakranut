import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateBackupManifest, verifyBackup } from '../scripts/verify-backup.mjs';
import { shiftDate, windowFor } from '../data-lib.mjs';
import { makeStatus } from '../runtime-lib.mjs';
import { archiveProjection } from '../archive-products.mjs';
import { DESCRIPTION_SOURCE } from '../src/identification.js';

const paths=['public/snapshot.json','public/status.json','public/archive.json','public/tracks.json','public/descriptions.json',
  'history/index.json','runner-state.json','description-cache.json','tracking-cache.json'];
const manifest=()=>({schemaVersion:1,files:paths.map(path=>({path,sha256:'a'.repeat(64)}))});
async function fixture(root) {
  const snapshot=JSON.parse(await readFile(new URL('../public/data/snapshot.json',import.meta.url),'utf8'));
  const date=snapshot.dataDate, now=new Date('2026-10-03T19:30:00Z');
  const state={schemaVersion:1,outcome:'healthy',targetDate:date,dataDate:date,checkedAt:now.toISOString(),lastSuccessAt:snapshot.generatedAt};
  const periodStart=shiftDate(date,-29);
  const values={
    'public/snapshot.json':snapshot,'public/status.json':makeStatus({snapshot,runnerState:state,now}),
    'public/archive.json':{schemaVersion:1,generatedAt:now.toISOString(),latestDate:date,latestGeneratedAt:snapshot.generatedAt,availableDates:[date]},
    'public/tracks.json':{schemaVersion:1,generatedAt:now.toISOString(),dataDate:date,periodStart,seriesStart:windowFor(periodStart).seriesStart,availableDates:[date],items:[]},
    'public/descriptions.json':{schemaVersion:1,generatedAt:now.toISOString(),source:DESCRIPTION_SOURCE,items:[]},
    'history/index.json':{schemaVersion:1,availableDates:[date]},'runner-state.json':state,
    'description-cache.json':{schemaVersion:1,entries:[],retryAt:null},'tracking-cache.json':{schemaVersion:1,items:[]},
    [`history/${date}.json`]:snapshot,[`public/archive/${date}.json`]:archiveProjection(snapshot),
  };
  const files=[];
  for(const [path,value] of Object.entries(values)) {
    const bytes=JSON.stringify(value);await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),bytes);
    files.push({path,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  return {manifest:{schemaVersion:1,files},now};
}
test('a complete matched data copy validates without claiming a full server restore',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sakranut-backup-valid-'));
  try {
    const value=await fixture(root); const result=await verifyBackup({runtimeDir:root,...value});
    assert.equal(result.phase,'data_restore_verified');assert.equal(result.historyDates,1);assert.equal(result.filesVerified,11);
    assert.equal(result.fullServerRestoreVerified,false);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('a valid hash alone cannot hide a missing archive edition or extra data',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sakranut-backup-extra-'));
  try {
    const value=await fixture(root);await writeFile(join(root,'public/extra.json'),'{}');
    await assert.rejects(verifyBackup({runtimeDir:root,...value}),/Unexpected/);
    await rm(join(root,'public/extra.json'));const file=value.manifest.files.find(item=>item.path.startsWith('public/archive/'));
    await rm(join(root,file.path));value.manifest.files=value.manifest.files.filter(item=>item!==file);
    await assert.rejects(verifyBackup({runtimeDir:root,...value}));
  } finally {await rm(root,{recursive:true,force:true});}
});
test('manifest excludes secrets, lock, traversal, absolute paths and duplicates',()=>{
  assert.equal(validateBackupManifest(manifest()).files.length,9);
  for(const path of ['../secret.json','/etc/healthchecks.env','public/.env','runtime.lock','history/../../secret.json']) {
    const value=manifest();value.files.push({path,sha256:'a'.repeat(64)});assert.throws(()=>validateBackupManifest(value));
  }
  const duplicate=manifest();duplicate.files.push(duplicate.files[0]);assert.throws(()=>validateBackupManifest(duplicate));
  const missing=manifest();missing.files.pop();assert.throws(()=>validateBackupManifest(missing));
});
test('a restored file with altered bytes fails before schema validation and is not rewritten',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sakranut-backup-test-'));
  try {
    const value=manifest();
    for(const file of value.files) {
      await mkdir(join(root,file.path,'..'),{recursive:true});await writeFile(join(root,file.path),'{}');
      file.sha256=createHash('sha256').update('{}').digest('hex');
    }
    await writeFile(join(root,'public/snapshot.json'),'changed');
    await assert.rejects(verifyBackup({runtimeDir:root,manifest:value}),/checksum/);
    assert.equal(await readFile(join(root,'public/snapshot.json'),'utf8'),'changed');
  } finally {await rm(root,{recursive:true,force:true});}
});
test('links and extra files are rejected before any file body is read',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sakranut-backup-links-'));
  try {
    await symlink('/etc',join(root,'public'));await assert.rejects(verifyBackup({runtimeDir:root,manifest:manifest()}),/links/);
  } finally {await rm(root,{recursive:true,force:true});}
});
