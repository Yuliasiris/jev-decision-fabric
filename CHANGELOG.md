# Changelog

## 0.4.0-preview.4

- Correct the work continuation MCP annotation: repeated explicit calls can advance planning under the original run budget, so idempotentHint is false.
- Cover discovery and two explicit continuations with the existing SDK and test-only scripted bindings. Execution, authorization, deadlines and unknown-effect retry rules are unchanged.


## 0.4.0-preview.3

- Allow fresh read-only status of a known saved run after an earlier transport
  closure was unconfirmed. Preserve the uncertain operation and block continue
  replay; a status read does not reconcile that historical uncertainty.
- Verify this recovery after an actual owned response proxy was killed while
  a committed continue reply was withheld. This is bounded local transport
  evidence; actual host crash, live J1 and real model comparison remain open.

## 0.4.0-preview.2

- Require an independently verified pre-registered evaluation cohort before
  recommending a method from held-out gains. Preserve all registered cases,
  original splits and prior-use evidence; missing proof retains fixed execution.
- Package an ordinary parent stdio client over the existing reference host.
  Preserve client request identity and unknown outcomes across process exits.
- Use stable hash filenames for reference host request/observation records and
  retain exact legacy record readback without changing logical identities.
- Keep the existing Controller, SDK execution ports, MCP handlers and fixed
  Plugin tools unchanged. These changes do not qualify live J1, native model
  comparison, authenticated remote hosts or whole-Goal completion.

The bounded reference host also checks exact stored snapshots/results and its
exclusive writer lease, rejects overlapping mutations, preserves terminal and
expired readback, and computes actual two-source sentence differences. A ready
input pattern preserves independently completed work while another input is
missing. The offline comparison example records diagnostic arithmetic runs and
uses fixed/no-Jev when no qualified live gain is available.

## 0.4.0-preview.1

- Add a host-owned SDK over the original C0/Controller/checkpoint implementation:
  ordinary request admission, planner/worker/decision/final ports, observation
  adoption, saved snapshot and restoration.
- Add conditional host-bound MCP work start/continue/status/cancel interfaces.
  Existing Netlify fixed-question tools, OAuth and deployment remain compatible.
- Add paired single/fixed/adaptive comparison and scoped policy profile ports.
  Scripted/injected results remain diagnostic; unknown metrics remain null.
- Generate JavaScript SDK exports with Node.js built-ins and verify package
  loading beneath node_modules and normal TypeScript consumer declaration
  resolution without provider calls or dependency install.
- Grant MIT reuse rights for the distributed project-authored source/docs and
  document third-party/service/model exclusions separately in NOTICE.md.

These entries describe this source release. They do not claim live Jev/native
qualification, deployed host adoption, Plugin generic-work delivery, measured
method gains or third-party completion.

## Historical source-only publication, 2026-10-09

43 files of finite decision server source were published for inspection.
The license notice at that publication asserted no project-authored reuse
grant. The publication excluded private adaptive source and runtime artifacts.
It did not redeploy the production service or complete adaptive production.
