# Release scope and qualification

The MIT License covers project-authored source and documentation selected
into this distribution. Dependencies retain their own licenses. Hosted
services, account access, inference allocation, model weights, training data
and private source documents are outside this distribution.

The public source already contained the N02 finite decision server. The
generic C0, checkpoint contract and Controller are copied as one canonical
implementation into adaptive/contract and adaptive/src. The SDK, work
interface and comparison ports call that implementation. The release writer
records the selected public bytes and correspondence in the allowlist,
manifest and provenance; this file is not a private runtime handoff.

| Evidence | Scope |
|---|---|
| Source/manifest and MIT license | Published project code and reusable terms |
| SDK package import/type consumer | Actual JavaScript loads from node_modules; a normal strict TypeScript consumer compiles against declarations |
| Unit tests with scripted/injected ports | Contract behavior for those inputs |
| Local reference worker | Observed local I/O in its own example run |
| Host supplied decision callback | A connection point; live provider use needs its own receipt |
| Live provider receipt | Its same run, input, actual mode and measured/null usage |
| Save/readback and restore receipt | That host's archive/fence/effect recovery |
| Comparison qualification | Same input/source/budget, independent receipt attestation and scoring |
| Third-party adoption | Fresh public install, legitimate own connection, complete/save/restart/record comparison |

The existing Plugin delivers fixed-question decision tools. An optional MCP
work adapter is advertised only when an actual host service and transport bind
it. Its presence in source does not update that Plugin or the existing Netlify
deployment.

Local examples use a scripted planner and registered local workers. They
exercise code and actual local I/O. They are not live Jev judgment, a fresh
native model final, two deployed authenticated hosts, or an unfamiliar user's
adoption. A successful build/test/demo/README publication does not complete
the whole Jev Decision Fabric Goal.

No production endpoint, OAuth redirect/scope, flag, provider allocation or
stored run is changed by building this source. A host separately adopts its
own ports and observes their execution. It preserves the original run limits
and reconciles uncertain started effects before admitting more work.
