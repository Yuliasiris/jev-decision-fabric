import {readFile, writeFile, mkdir, copyFile, mkdtemp, rm, lstat} from 'node:fs/promises';
import {resolve, dirname, join, relative, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'jev-sdk-package-check-'));
const require = createRequire(import.meta.url);
const cleanEnv = {PATH: process.env.PATH || ''};
for (const key of ['SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP'])
  if (process.env[key]) cleanEnv[key] = process.env[key];
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {cwd: root, env: cleanEnv,
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('SDK_PACKAGE_COMMAND_FAILED: ' + command +
    '\n' + result.stderr + '\n' + result.stdout);
  return result.stdout;
};
try {
  run(process.execPath, [join(root, 'scripts/build-sdk.mjs')]);
  // npm selects the real distribution files. This does not install anything,
  // contact a registry, or run package lifecycle hooks.
  const config = join(temporary, 'empty-npmrc');
  const globalConfig = join(temporary, 'empty-global-npmrc');
  await writeFile(config, '');
  await writeFile(globalConfig, '');
  const npmEnv = {...cleanEnv, NPM_CONFIG_USERCONFIG: config,
    NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: join(temporary, 'npm-cache'),
    NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_OFFLINE: 'true'};
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = JSON.parse(run(npmCommand, ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {env: npmEnv}));
  if (packed.length !== 1 || !Array.isArray(packed[0].files)) throw Error('SDK_PACKAGE_LIST_INVALID');
  const files = packed[0].files.map(entry => entry.path);
  const required = ['package.json', 'LICENSE', 'NOTICE.md', 'README.md',
    'dist/adaptive/sdk/index.mjs', 'dist/adaptive/sdk/index.d.mts',
    'dist/adaptive/src/controller.mjs',
    'dist/adaptive/contract/c0.mjs', 'dist/adaptive/contract/checkpoint-v1.mjs',
    'dist/adaptive/evaluation/index.mjs', 'dist/adaptive/evaluation/cohort.mjs',
    'dist/adaptive/evaluation/cohort.d.mts', 'dist/adaptive/mcp/work.mjs',
    'dist/adaptive/providers/index.mjs', 'dist/examples/work-sdk.mjs',
    'dist/examples/work-stdio.mjs', 'dist/examples/work-host.mjs',
    'dist/examples/work-comparison.mjs', 'dist/examples/work-parent.mjs',
    'docs/MCP_PARENT.md', 'adaptive/sdk/READY_INPUTS.md',
    'dist/examples/work-data/numbers.json', 'dist/examples/work-data/policy-a.txt',
    'dist/examples/work-data/policy-b.txt'];
  for (const path of required) if (!files.includes(path)) throw Error('SDK_PACKAGE_FILE_MISSING: ' + path);
  const consumer = join(temporary, 'consumer');
  const installed = join(consumer, 'node_modules', 'jev-decision-fabric');
  await mkdir(installed, {recursive: true});
  await writeFile(join(consumer, 'package.json'), JSON.stringify({private: true, type: 'module'}));
  for (const path of files) {
    const source = resolve(root, path);
    const local = relative(root, source);
    if (local.startsWith('..' + sep) || local === '..' || (await lstat(source)).isSymbolicLink())
      throw Error('SDK_PACKAGE_PATH_REFUSED: ' + path);
    const destination = join(installed, path);
    await mkdir(dirname(destination), {recursive: true});
    await copyFile(source, destination);
  }
  const observed = JSON.parse(run(process.execPath, ['--input-type=module', '--eval',
    `import * as sdk from 'jev-decision-fabric';
import * as controller from 'jev-decision-fabric/controller';
import * as contract from 'jev-decision-fabric/contract';
import * as checkpoint from 'jev-decision-fabric/checkpoint';
import * as evaluation from 'jev-decision-fabric/evaluation';
import * as mcp from 'jev-decision-fabric/mcp';
import * as typesafe from 'jev-decision-fabric/typesafe';
if (typeof sdk.createWork !== 'function' || typeof sdk.restoreWork !== 'function' ||
  typeof sdk.WorkRun !== 'function' || typeof controller.Controller !== 'function' ||
  typeof evaluation.runPairedComparison !== 'function' ||
  typeof evaluation.sealEvaluationCohort !== 'function' ||
  typeof evaluation.verifyEvaluationCohort !== 'function' ||
  typeof typesafe.createTypeSafeDecision !== 'function')
  throw Error('SDK_PACKAGE_EXPORT_MISSING');
console.log(JSON.stringify({sdk: Object.keys(sdk), controller: Object.keys(controller),
  contract: contract.CONTRACT_VERSION, checkpoint: checkpoint.CHECKPOINT_VERSION,
  evaluation: Object.keys(evaluation), mcp: Object.keys(mcp),
  typesafe: Object.keys(typesafe)}));`], {cwd: consumer}));
  await writeFile(join(consumer, 'app.mts'), `import {createWork, type WorkHost} from 'jev-decision-fabric';
import {Controller} from 'jev-decision-fabric/controller';
import {createTypeSafeDecision, type HostOptions} from 'jev-decision-fabric/typesafe';
import {runPairedComparison, sealEvaluationCohort, verifyEvaluationCohort, type ConditionManifest} from 'jev-decision-fabric/evaluation';
import {createWorkMcpHandler, type HostWorkService} from 'jev-decision-fabric/mcp';
export const factories = {createWork,Controller,createTypeSafeDecision,runPairedComparison,sealEvaluationCohort,verifyEvaluationCohort,createWorkMcpHandler};
export type PublicTypes = {host: WorkHost; options: HostOptions; manifest: ConditionManifest; service: HostWorkService};
`);
  run(process.execPath, [require.resolve('typescript/lib/tsc.js'), '--module', 'nodenext',
    '--target', 'esnext', '--strict', '--types', 'node', '--typeRoots', join(root, 'node_modules/@types'),
    '--skipLibCheck', '--outDir', 'compiled', 'app.mts'], {cwd: consumer});
  run(process.execPath, [join(consumer, 'compiled/app.mjs')], {cwd: consumer});
  console.log(JSON.stringify({status: 'PASS', distribution_files: files.length,
    runtime_under_node_modules: true, typescript_consumer_emit: true,
    lifecycle_hooks: false, registry_contact: false,
    install: false, provider_calls: 0, exports: observed}));
} finally {
  await rm(temporary, {recursive: true, force: true});
}
