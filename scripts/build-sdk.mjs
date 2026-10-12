import {stripTypeScriptTypes, createRequire} from 'node:module';
import {readdir, readFile, writeFile, mkdir, rm, lstat} from 'node:fs/promises';
import {resolve, relative, dirname, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(root, 'dist');
const roots = ['adaptive/contract', 'adaptive/src', 'adaptive/sdk',
  'adaptive/evaluation', 'adaptive/mcp', 'adaptive/providers', 'netlify/lib', 'examples'];
const required = ['adaptive/contract/c0.mts', 'adaptive/contract/checkpoint-v1.mts',
  'adaptive/src/controller.mts', 'adaptive/sdk/index.mts', 'adaptive/evaluation/index.mts'];
const assetPaths = ['examples/work-data/numbers.json', 'examples/work-data/policy-a.txt',
  'examples/work-data/policy-b.txt', 'examples/decision_run_v1.single.json',
  'examples/music-routing-v0.json', 'examples/ops-liveness-v0.json', 'examples/roi-delta-v0.json'];
const sources = new Map();
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeDependencies = new Set(Object.keys(packageMetadata.dependencies || {}));
const require = createRequire(import.meta.url);
let typescript;
try {typescript = require('typescript');}
catch {throw Error('SDK_BUILD_TYPESCRIPT_MISSING: run npm ci --ignore-scripts with locked development dependencies');}
const sha = value => createHash('sha256').update(value).digest('hex');
const portable = value => value.split(sep).join('/');

async function collect(directory) {
  let entries;
  try { entries = await readdir(join(root, directory), {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('SDK_BUILD_SYMLINK_REFUSED: ' + portable(path));
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && entry.name.endsWith('.mts'))
      sources.set(portable(path), await readFile(join(root, path), 'utf8'));
  }
}
for (const directory of roots) await collect(directory);
for (const path of required) if (!sources.has(path)) throw Error('SDK_BUILD_SOURCE_MISSING: ' + path);

// Resolve the exact runtime import closure before touching generated output.
// Strip mode supports the erasable syntax used by this SDK; it never type-checks.
const built = new Map();
const assets = new Map();
for (const path of assetPaths) {
  try {
    if (!(await lstat(join(root, path))).isFile()) throw Error('SDK_BUILD_ASSET_NOT_FILE: ' + path);
    assets.set(path, await readFile(join(root, path)));
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
}
const importPattern = /\b(?:from\s*|import\s*\(\s*|import\s*)(['"])([^'"]+)\1/g;
for (const [path, code] of sources) {
  const stripped = stripTypeScriptTypes(code, {mode: 'strip'});
  for (const match of stripped.matchAll(importPattern)) {
    const specifier = match[2];
    if (specifier.startsWith('node:') || runtimeDependencies.has(specifier)) continue;
    if (!specifier.startsWith('./') && !specifier.startsWith('../'))
      throw Error('SDK_BUILD_EXTERNAL_IMPORT: ' + path + ' -> ' + specifier);
    const target = resolve(root, dirname(path), specifier);
    const normalized = portable(relative(root, target));
    if (normalized.startsWith('../') || !sources.has(normalized))
      throw Error('SDK_BUILD_IMPORT_OUTSIDE_SOURCE: ' + path + ' -> ' + specifier);
  }
  const rewritten = stripped.replace(importPattern, (all, quote, specifier) => {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return all;
    return all.replace(specifier, specifier.replace(/\.mts$/, '.mjs'));
  });
  built.set(path.replace(/\.mts$/, '.mjs'), rewritten);
}
try { if ((await lstat(output)).isSymbolicLink()) throw Error('SDK_BUILD_OUTPUT_SYMLINK_REFUSED'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(output, {recursive: true, force: true});
const manifest = [];
for (const [path, code] of built) {
  const destination = join(output, path);
  await mkdir(dirname(destination), {recursive: true});
  await writeFile(destination, code);
  const input = path.replace(/\.mjs$/, '.mts');
  manifest.push({source: input, source_sha256: sha(sources.get(input)),
    output: 'dist/' + path, output_sha256: sha(code)});
}
// Use the already-locked compiler for declarations; consumers do not need
// allowImportingTsExtensions or runtime type stripping in node_modules.
const declarations = [];
const entrypoints = [...new Set(Object.values(packageMetadata.exports || {}).map(entry =>
  entry.default.replace(/^\.\/dist\//, '').replace(/\.mjs$/, '.mts')))];
const program = typescript.createProgram([...entrypoints.map(path => join(root, path)),
  join(root, 'scripts/netlify-platform.d.ts')], {
  module: typescript.ModuleKind.NodeNext, target: typescript.ScriptTarget.ESNext,
  strict: true, skipLibCheck: true, types: ['node'], declaration: true,
  emitDeclarationOnly: true, allowImportingTsExtensions: true, noEmitOnError: true,
  rootDir: root, outDir: output,
});
const diagnostics = typescript.getPreEmitDiagnostics(program);
if (diagnostics.length) throw Error(typescript.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => '\n',
}));
const emitted = program.emit(undefined, (path, code) => {
  if (!path.endsWith('.d.mts') || !resolve(path).startsWith(output + sep))
    throw Error('SDK_BUILD_DECLARATION_PATH_REFUSED');
  const rewritten = code.replace(importPattern, (all, quote, specifier) =>
    all.replace(specifier, specifier.replace(/\.mts$/, '.mjs')));
  typescript.sys.writeFile(path, rewritten);
  declarations.push({output: portable(relative(root, path)), output_sha256: sha(rewritten)});
});
if (emitted.emitSkipped || emitted.diagnostics.length) throw Error('SDK_BUILD_DECLARATION_EMIT_FAILED');
manifest.sort((a,b) => a.source.localeCompare(b.source));
const assetManifest = [];
for (const [path, bytes] of assets) {
  const destination = join(output, path);
  await mkdir(dirname(destination), {recursive: true});
  await writeFile(destination, bytes);
  assetManifest.push({source: path, source_sha256: sha(bytes),
    output: 'dist/' + path, output_sha256: sha(bytes)});
}
await writeFile(join(output, 'sdk-build-manifest.json'),
  JSON.stringify({schema: 'jev.sdk-build.v1', transformation: 'node.stripTypeScriptTypes.strip',
    declaration_compiler: typescript.version, files: manifest,
    declarations: declarations.sort((a,b) => a.output.localeCompare(b.output)), assets: assetManifest}, null, 2) + '\n');
console.log(JSON.stringify({status: 'BUILT', files: manifest.length,
  declarations: declarations.length, assets: assetManifest.length, output: 'dist',
  type_checking: true, install: false, provider_calls: 0}));
