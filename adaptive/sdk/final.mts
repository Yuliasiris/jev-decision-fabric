/** Host-neutral raw-final boundary. References and quotes are checked, not paraphrase truth. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Observation, TaskRequest} from '../contract/c0.mts';

function require(ok: unknown, reason: string): asserts ok {if (!ok) throw Error('sdk_final:' + reason);}
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function exact(v: unknown, keys: string[]): asserts v is Record<string, any> {
  require(v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)), 'fields');
}
function parse(raw: string) {
  const value = JSON.parse(raw), tokens = raw.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:]/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '{') stack.push(new Set());
    else if (tokens[i] === '[') stack.push(null);
    else if (tokens[i] === '}' || tokens[i] === ']') stack.pop();
    else if (tokens[i].startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(tokens[i]), keys = stack.at(-1);
      require(keys && !keys.has(key), 'duplicate_member'); keys!.add(key);
    }
  }
  return value;
}
function quotes(s: string): string[] {
  const pairs: Record<string, string> = {'"': '"', '“': '”', '「': '」', '『': '』', '`': '`'};
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) if (pairs[s[i]]) {
    const end = s.indexOf(pairs[s[i]], i + 1);
    require(end > i + 1, 'quotation'); out.push(s.slice(i + 1, end)); i = end;
  }
  return out;
}
export function inspectFinal(raw: Uint8Array, report: TaskRequest,
  accepted: readonly Observation[], evidenceText: (observation: Observation) => readonly string[]) {
  require(raw instanceof Uint8Array && raw.byteLength > 0 && raw.byteLength <= 512 * 1024, 'size');
  const copy = Buffer.from(raw), utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(copy);
  const v = parse(utf8);
  exact(v, ['run_id', 'task_id', 'attempt_id', 'input_digest', 'answer', 'provenance', 'unresolved']);
  require(['run_id', 'task_id', 'attempt_id', 'input_digest'].every(k => v[k] === report[k as keyof TaskRequest]), 'frame');
  require(text(v.answer) && Array.isArray(v.provenance) && v.provenance.length > 0 &&
    Array.isArray(v.unresolved) && v.unresolved.every(text), 'types');
  const available = new Map(accepted.map(o => [o.id, o]));
  require(available.size === accepted.length, 'ambiguous_accepted_id');
  const reads = new Map<string, Observation>();
  for (const [task, o] of Object.entries(report.reads)) {
    require(o.run_id === report.run_id && o.task_id === task && o.status === 'completed' &&
      isDeepStrictEqual(available.get(o.id), o) && !reads.has(o.id), 'read_binding');
    reads.set(o.id, o);
  }
  const ids: string[] = [];
  for (const p of v.provenance) {
    exact(p, ['observation_id', 'claim']);
    require(text(p.observation_id) && text(p.claim) && reads.has(p.observation_id) &&
      !ids.includes(p.observation_id), 'provenance');
    ids.push(p.observation_id);
    const actual = evidenceText(reads.get(p.observation_id)!);
    require(Array.isArray(actual) && actual.every(x => typeof x === 'string'), 'evidence_text');
    require(quotes(p.claim).every(q => actual.some(t => t.includes(q))), 'fabricated_quotation');
  }
  const allText = ids.flatMap(id => evidenceText(reads.get(id)!));
  require([v.answer, ...v.unresolved].flatMap(quotes).every(q => allText.some(t => t.includes(q))), 'fabricated_quotation');
  return {native: v, projection: {answer: v.answer as string, provenance: ids, unresolved: v.unresolved as string[]},
    receipt: {raw_sha256: createHash('sha256').update(copy).digest('hex'), raw_bytes: copy.byteLength,
      accepted_read_ids: [...reads.keys()], claim_semantics_evaluated: false}};
}
