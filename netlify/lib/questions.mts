import { QUESTION_SETS as BASE, OPS_LIVENESS_V0 } from './ops-questions.mts';
import type { QuestionSpec } from './ops-questions.mts';
export type { QuestionSpec } from './ops-questions.mts';
export { OPS_LIVENESS_V0 };
export const QUESTION_SETS: Record<string,Record<string,QuestionSpec>>={...BASE};

// Domain-specific routing candidates. These are not validated racing predictions or musical judgments.
function affected(instructions:string):QuestionSpec{return {type:'choice',instructions:instructions+' Use only explicitly supplied previous assumptions, current observations, change timestamps, and dependency context. Missing evidence is unknown, never unaffected. A factor may affect several analyses. Do not infer outcomes or place bets.',criteria:{reassess:'A stated dependency or material semantic link changed; reevaluate this analysis.',retain:'The supplied dependency context establishes that this analysis remains valid.',unknown:'Dependency coverage or the new evidence is insufficient to decide.'}};}
QUESTION_SETS['roi-delta-v0']={
 pedigree:affected('Should the pedigree/context-fit assessment be revisited after this change?'),
 pace:affected('Should the pace/scenario assessment be revisited, including interactions between remaining runners?'),
 track:affected('Should the going/course-bias assessment be revisited?'),
 ability:affected('Should the prior-performance/ability comparison be revisited?'),
 condition:affected('Should the physical condition or readiness assessment be revisited?'),
 market:affected('Should the market comparison be revisited? Do not turn output confidence into a winning probability.'),
 scope:{type:'choice',instructions:'Select the smallest supported reevaluation scope. Full reanalysis is not justified by a missing observation alone; preserve unknown. Do not choose a horse or a wager.',criteria:{none:'All relevant assumptions are explicitly unchanged.',targeted:'A specific bounded subset and its dependencies changed.',broad:'Documented changes affect the global scenario or many interacting assumptions.',unknown:'Scope cannot be established.'}},
 next_evidence:{type:'choice',instructions:'What evidence work, if any, is needed before consuming the changed race information? Do not re-fetch current evidence without a reason.',criteria:{none:'Evidence is current, sufficiently complete and nonconflicting.',verify_identity_time:'Runner/race identity or observation time needs checking.',fill_missing:'A required observation is missing.',resolve_conflict:'Same-scope current sources conflict.',unknown:'Insufficient context to identify the missing evidence.'}}
};
function routeQuestion(instructions:string,criteria:Record<string,string>):QuestionSpec{return {type:'choice',instructions:instructions+' Interpret supplied symbolic observations and intent only; do not claim to have heard audio. Missing values are unknown. Results select candidates, not authorization to Apply.',criteria:{...criteria,unknown:'The supplied state is insufficient to decide.'}};}
QUESTION_SETS['music-routing-v0']={
 target:routeQuestion('Which dimension should the next bounded candidate primarily address?',{harmony:'Harmonic color or chord/voicing.',melody:'Melodic line.',rhythm:'Timing/groove.',arrangement:'Instrumentation or density.',mix:'Balance, timbre or effect routing.',multiple:'Several dimensions require separate candidates.'}),
 preserve_melody:routeQuestion('Is melodic identity explicitly to be preserved?',{preserve:'The brief or boundary explicitly preserves melody.',change_allowed:'A melodic candidate change is explicitly requested.',clarify:'The supplied statements are conflicting or materially ambiguous.'}),
 analysis:routeQuestion('Are upstream audio/MIDI analysis observations adequate for the stated candidate operation?',{usable:'The required evidence and its limits support a candidate.',needs_correction:'A specified correctable issue needs attention.',needs_measurement:'A necessary observation is missing.',unusable:'The supplied evidence explicitly fails a required condition.'}),
 engine:routeQuestion('Which kind of next processing step is justified?',{deterministic:'The bounded operation is fully specified and deterministic.',specialized_model:'A specified perception or generation task needs specialized ML.',reasoning:'Intent or design needs deeper reasoning.',compare:'Existing bounded candidates should be auditioned.',clarify:'A material intent ambiguity requires clarification.'}),
 scope:routeQuestion('What scope is actually supported by the request?',{note:'Exact note/event.',phrase:'Named phrase or measure range.',track:'Named track/role.',section:'Named section.',song:'Whole song explicitly requested.'}),
 ambiguity:routeQuestion('How should unresolved intent affect the next step?',{none:'No material ambiguity for this bounded candidate.',branch:'Several interpretations can be retained as reversible candidates.',clarify:'Candidate generation would require an unprovided consequential choice.'}),
 freshness:routeQuestion('Do the supplied source revision, analysis and candidate bindings appear consistent?',{consistent:'Bindings and times explicitly match.',stale:'A known dependency changed.',conflict:'Same-scope bindings conflict.'}),
 presentation:routeQuestion('What is the next appropriate candidate presentation, not automatic adoption?',{audition:'A playable bounded comparison is available.',prepare:'A candidate or render must still be produced.',explain_limit:'A concrete unavailable operation or evidence limit should be shown.',no_op:'The request is already satisfied for this scope.'})
};
