# License and third-party notice

Project-authored source and documentation distributed in this repository are
available under the MIT License in LICENSE. This includes the existing finite
decision server and the added adaptive contract, controller, SDK, interface and
comparison code that is selected into this release. The published file
allowlist and source manifest identify the distributed bytes.

This grant applies to the project's code and documentation. It grants no
access to a hosted service, account, inference allowance, model weights,
training data, source documents, private conversations or character packs.
Those are not included in the distribution. A host uses its own legitimate
connections and source permissions. No provider service or dependency is
relicensed by this project.

The original generic C0, checkpoint contract and Controller are reused as one
canonical implementation under adaptive/contract/ and adaptive/src/. Host
adapters call that controller; they do not introduce another controller or
semantic writer. New SDK and comparison code has its own public source
correspondence recorded by the release writer. Historical publication records
remain historical; the earlier source-only release did not grant reuse rights.

## Third-party dependencies

This source retains @netlify/blobs 11.1.0 and @netlify/functions 4.2.5 for the
existing Netlify server. Their installed package metadata declares MIT.
THIRD_PARTY_DEPENDENCIES.json records each locked dependency's version,
integrity and declared license metadata. The generic SDK/controller itself
uses Node.js built-ins and host-supplied ports.

Dependency source and binaries are not vendored. Installing dependencies
obtains separate upstream packages under their own terms. This inventory is
metadata, not a grant over those packages. It is retained separately from the
project's MIT license.

The TypeSafe Jev service is accessed through a host's existing authorized
connection. No model weights, training data, vendor documentation text,
research PDFs or source packs are distributed. The public question definitions
and execution code are project-authored files, not a release of the Jev service.
No R4 code is copied here; R4 components retain their own licenses.

The one package lacking lock license metadata, callsite 1.0.0, declares MIT in
its installed Readme.md License section. Its lock metadata is unchanged; the
additional observation is recorded in THIRD_PARTY_DEPENDENCIES.json.

Locked license metadata counts:

| Declaration | Packages |
|---|---:|
| (MIT OR CC0-1.0) | 1 |
| 0BSD | 1 |
| Apache 2 | 1 |
| Apache-2.0 | 27 |
| BSD-2-Clause | 9 |
| BSD-3-Clause | 5 |
| BlueOak-1.0.0 | 8 |
| CC-BY-3.0 | 1 |
| CC0-1.0 | 1 |
| ISC | 31 |
| MIT | 411 |
| MPL-2.0 | 1 |
| UNSPECIFIED | 1 |
