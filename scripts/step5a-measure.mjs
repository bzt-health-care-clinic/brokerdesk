#!/usr/bin/env node
/**
 * OFFLINE ONLY. Reads private manifest, BrokerDesk reviewed-keyin.json and
 * original source files on this computer. Writes ONLY allowlisted aggregate
 * counters; private values, IDs and paths are never included in the output.
 * Requires Node 24; no npm dependency, cloud API or telemetry.
 */
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve, extname} from 'node:path';
import {measureStep5A, STEP5A_SCHEMA} from '../lib/step5a-real-coverage.mjs';

function failure(code) { return Object.assign(new Error('Private measurement failed'), {code}); }
function flags(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--input','--output','--target-sha'].includes(argv[i]) ||
        i + 1 >= argv.length || args[argv[i]]) throw failure('USAGE');
    args[argv[i]] = argv[i + 1];
  }
  if (!args['--input'] || !args['--output'] || !args['--target-sha'] ||
      !/^[a-f0-9]{40}$/i.test(args['--target-sha'])) throw failure('USAGE');
  return args;
}
function localFile(base, provided, extensions) {
  if (typeof provided !== 'string' || !provided.trim() ||
      /^(?:[a-z][a-z0-9+.-]*:\/\/|\\\\)/i.test(provided))
    throw failure('NONLOCAL_INPUT');
  const path = resolve(base, provided);
  if (!extensions.includes(extname(path).toLowerCase())) throw failure('UNSUPPORTED_LOCAL_FILE');
  return path;
}
async function assemble(manifest, base) {
  if (manifest?.schema_version !== STEP5A_SCHEMA || !Array.isArray(manifest.samples))
    throw failure('INVALID_PRIVATE_MANIFEST');
  const samples = [];
  for (const item of manifest.samples) {
    if (!Array.isArray(item?.records)) throw failure('INVALID_SOURCE_INVENTORY');
    const review = JSON.parse(await readFile(localFile(base,item.review_file,['.json']),'utf8'));
    const records = [];
    for (const record of item.records) {
      if (typeof record?.id !== 'string' || !record.id) throw failure('INVALID_SOURCE_ID');
      const original = await readFile(localFile(base,record.source_file,['.pdf','.jpg','.jpeg','.png']));
      const sourceHash = createHash('sha256').update(original).digest('hex');
      records.push({id:record.id,sourceHash,hashVerified:true,
        logicalDocuments:record.logical_documents ?? [],
        packagePages:record.package_pages ?? [],
        withdrawnSectionRanges:record.withdrawn_ranges ?? []});
    }
    samples.push({sample_id:item.sample_id,case_type:item.case_type,review,
      records,checks:item.checks});
  }
  return {schema_version:manifest.schema_version,dataset:manifest.dataset,
    target_commit:manifest.target_commit,samples};
}
async function main() {
  const args=flags(process.argv.slice(2));
  const input=resolve(args['--input']),output=resolve(args['--output']);
  if (input===output || !output.toLowerCase().endsWith('.json')) throw failure('UNSAFE_OUTPUT');
  const manifest=JSON.parse(await readFile(input,'utf8'));
  const prepared=await assemble(manifest,dirname(input));
  const result=measureStep5A(prepared,{expectedCommit:args['--target-sha']});
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{encoding:'utf8',flag:'w',mode:0o600});
  process.stdout.write('Step 5A: '+result.status+'; cases='+result.sample_count+
    '; measured='+result.totals.measured+'; proven_auto='+
    result.totals.auto_correct_with_proof+'; unmeasured_domains='+
    result.unmeasured_categories.length+'\n');
  if (result.status==='SYNTHETIC_ONLY' || result.status==='NO_REAL_SAMPLES')
    process.exitCode=2; // Explicitly NOT a real acceptance pass.
  else if (result.status==='REAL_MEASUREMENT_INCOMPLETE_OR_FAILED') process.exitCode=3;
}
main().catch(error=>{
  // Deliberately never print error.message, stack, input names, values or paths.
  const allowed = new Set(['USAGE','NONLOCAL_INPUT','UNSUPPORTED_LOCAL_FILE',
    'INVALID_PRIVATE_MANIFEST','INVALID_SOURCE_INVENTORY','INVALID_SOURCE_ID',
    'UNSAFE_OUTPUT','INVALID_SCHEMA','INVALID_DATASET','INVALID_TARGET_COMMIT',
    'MISSING_SAMPLES','INVALID_SAMPLE_ID','INVALID_SAMPLE_STRUCTURE',
    'INVALID_CHECK','DUPLICATE_CHECK','INVALID_COUNT_TRUTH',
    'MISSING_TRUTH_VALUE','INVALID_ZERO_DOMAIN','INVALID_NEEDS_REVIEW_TRUTH',
    'INVALID_PHYSICAL_PROOF','CODE_SHA_MISMATCH']);
  const code=allowed.has(error?.code)?error.code:'LOCAL_INPUT_UNREADABLE_OR_INVALID';
  process.stderr.write('Step 5A could not complete: '+code+'\n');
  process.exitCode=1;
});
