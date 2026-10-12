# Audit your own numeric CSV

This consumer uses the public Jev SDK with a fixed, scripted CSV recipe. It reads your explicit local file, validates it, calculates an exact decimal total and creates an answer with the file path, SHA256, column and unit. It makes no Jev or native model calls. Your OS account supplies filesystem access; the request text and saved JSON do not grant remote access.

Use Node 22.13 or later. Obtain the public source and build its tarball using the repository [installation steps](../../README.md), which do not assume a registry publication. For example:

```sh
git clone https://github.com/Yuliasiris/jev-decision-fabric.git
cd jev-decision-fabric
npm ci --ignore-scripts
npm run build:sdk
npm pack --ignore-scripts
```

Copy `consumers/csv-audit` into your own work directory, then install that locally built public tarball there. Substitute its actual versioned filename if the public source has advanced:

```sh
cd csv-audit
npm install --ignore-scripts /absolute/path/jev-decision-fabric-0.4.0-preview.5.tgz
node index.mjs --request "Audit this CSV and total the amount column" \
  --file /absolute/path/my-ledger.csv --column amount --unit USD \
  --state /absolute/path/private-audit-state --pause-after-read
node index.mjs --operation resume --state /absolute/path/private-audit-state
node index.mjs --operation status --state /absolute/path/private-audit-state
```

The first command saves a `PAUSED` run after its registered file-read observation is accepted. Run the second command in a fresh process **within the original three-minute deadline**. It restores the same SDK snapshot and continues the audit and fresh scripted final. It preserves the run ID, original deadline, budget and read attempt. It does not dispatch the registered read again. Freshness checks may read the file again; these are not new registered worker attempts. Without `--pause-after-read`, the first command completes directly.

For example, `sample.csv` yields four rows and a total of `1289.74 USD`, with `Consulting` appearing twice. That is a sample outcome, not a claim about your file. The CLI always writes machine JSON to stdout and, unless `--json` is set, a human view of the same record to stderr. Keep them separately if useful:

```sh
node index.mjs --operation status --state /absolute/path/private-audit-state \
  > result.json 2> result.txt
```

`status` reads the original saved result without running tasks or re-reading the input file. Its `delivery: saved_original_result` is history, not a fresh audit. Repeating the same start with the same state, request, canonical file path, column and unit returns that original record. Changed start arguments are refused.

The format is deliberately explicit: UTF-8, header `item,amount` (or `item,<your --column>`), then one nonempty item and one signed decimal per line. CRLF or LF is accepted. No quoted cells, embedded commas/newlines, extra columns, whitespace around cells, exponent notation or currency symbols. Maximum 32 KiB, 1,000 data rows, 18 integer digits and six fractional digits. Duplicate item labels are reported; they remain separate rows in the sum. `--unit` labels the values and does not convert currencies or validate accounting rules. The prose request must mention audit, total, sum, 合計 or 監査; this selects only this recipe and never executes other requested actions.

Quotation delimiters in a label, unit or file path are displayed as `\uXXXX` in the answer so they cannot be mistaken for evidence quotations. The structured result and original observation retain the exact input values.

Failures preserve evidence. Invalid CSV produces a stopped/failed result, an archived invalid observation and no partial total or final answer. Correct the file and explicitly choose a **new** state directory for a new audit. If a paused run's source changed, resume is refused before SDK restoration: restore the exact original file bytes to continue the original run before its deadline, or choose a new state for new input. A corrupt saved state requires an intact private backup of the original archive; the consumer does not rebuild a snapshot from result text. No automatic retry, admission refresh, uncertain-effect clearing or stale-lock deletion is provided. A writer lock after an ungraceful process exit requires owner investigation and original-effect reconciliation; do not delete it to force a resume. Status keeps the original saved state and labels an expired unfinished run `EXPIRED_UNFINISHED`, with `resumable:false`.

Keep the state directory private. It contains your request, file content, original SDK snapshot, observations and final bytes. The SHA checks detect accidental corruption and bind this local archive; an actor who can rewrite the entire directory is within your OS trust boundary. This proves a bounded local use with graceful pause and restart, not power-loss durability, production crash recovery, a live/native planner, a second authenticated remote host or J1 qualification.
