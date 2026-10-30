/** Disposable integration fixture for three simultaneous coding conversations.
 * Git remains the code authority; production and existing worktrees untouched.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'synrex-parallel-worktrees-'));
const repo = join(root, 'repo');
const git = async (cwd, ...args) => (await exec('git', args, {cwd,timeout:15_000})).stdout.trim();
try {
  await mkdir(repo);
  await git(repo,'init','-b','main');
  await git(repo,'config','user.name','Synrex P0 fixture');
  await git(repo,'config','user.email','synrex-fixture@example.invalid');
  await writeFile(join(repo,'README.md'),'common baseline\n');
  await git(repo,'add','README.md');
  await git(repo,'commit','-m','base');
  const baseline = await git(repo,'rev-parse','HEAD');
  const plans = [
    ['console','console/metrics.txt','console metrics'],
    ['memory','memory/learning.txt','memory learning'],
    ['subagent','subagent/driver.txt','subagent driver'],
  ];
  const commits=await Promise.all(plans.map(async ([name,file,contents])=>{
    const work=join(root,name);
    await git(repo,'worktree','add','--detach',work,baseline);
    const target=join(work,file);
    await mkdir(join(work,name),{recursive:true});
    await writeFile(target,contents+'\n');
    await git(work,'add',file);
    await git(work,'commit','-m',`independent ${name} work`);
    assert.equal(await git(work,'status','--porcelain'),'');
    return {name,commit:await git(work,'rev-parse','HEAD'),file,contents};
  }));
  assert.equal(await git(repo,'rev-parse','HEAD'),baseline);
  for (const task of commits) {
    await git(repo,'cherry-pick',task.commit);
    assert.equal((await readFile(join(repo,task.file),'utf8')).trim(),task.contents);
  }
  assert.equal(await git(repo,'status','--porcelain'),'');
  const head=await git(repo,'rev-parse','HEAD');
  assert.notEqual(head,baseline);
  assert.equal((await git(repo,'rev-list','--count',baseline+'..HEAD')),'3');
  assert.equal((await git(repo,'worktree','list','--porcelain')).split(/\n/).filter(x=>x.startsWith('worktree ')).length,4);
  console.log(JSON.stringify({status:'pass',baseline:baseline.slice(0,9),integrated:head.slice(0,9),
    conversations:commits.map(x=>x.name),integratedCommits:3,unmodifiedExternalRepos:true}));
} catch(error) {
  console.error('PARALLEL_WORKTREE_QA_FAILED',error);
  process.exitCode=1;
} finally {
  await rm(root,{recursive:true,force:true});
}
