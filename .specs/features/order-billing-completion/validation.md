# Order billing completion — validation

## Validation: PASS

Date: 2026-11-08. Verifier: independent sub-agent, author ≠ verifier.
Spec: `.specs/features/order-billing-completion/spec.md`.
Diff range: `6c475a18..965218472f5e4a5d69e799acf9ce0fadbe469d88`.
Implementation, synthetic DEV and local browser behavior are verified. This
report does not authorize production activation, real messages or payments.

## Completion and gates

T0–T7 are Complete in `tasks.md`. The frozen implementation was clean before
verification. No implementation/test source was edited by the verifier.

Independent gates against the frozen implementation:

| Gate                                                                                                                                                | Result                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Node `--test test/order-billing-completion-postgres-live.test.js`, dedicated synthetic PostgreSQL                                                   | 13 passed, 0 failed, 0 skipped               |
| Node `--test` completion-routes, payment-check-worker, billing-development-check, billing-development-transport and billing-development-interactive | 12 passed, 0 failed, 0 skipped               |
| Playwright `test/e2e/billing-chat-real.spec.js --workers=1`, `E2E_PORT=4194`                                                                        | 15 passed, 0 failed, 0 skipped; build passed |
| Additional delayed-response Playwright scenario in scratch, port 4195                                                                               | 1 passed, 0 failed, 0 skipped                |
| Scratch PostgreSQL baseline before mutation                                                                                                         | 13 passed, 0 failed, 0 skipped               |
| Discrimination sensor                                                                                                                               | 5 injected, 5 killed, 0 survived             |

Independent outcome gates total 41 distinct scenarios, excluding the repeated
scratch baseline and deliberately failing mutant runs. PostgreSQL used only the
integrator-reserved synthetic `crm-billing-completion-root-db` on port 15443.
No interactive DEV database or existing user preview was reset or stopped.

The integrator also supplied: full `npm run validate` with 2014 passed and 25
conditional opt-in skips, dedicated PostgreSQL 69/69, frontend 53/53,
prototype 8/8 and real n8n 17/17. Final format/typecheck/lint/build passed after
T7. These are integrator evidence, not a claim that the verifier independently
reran the full suite. No skipped test substitutes for a feature acceptance
criterion: the explicit independent financial/UI gates above have zero skips.
The full-suite gate preceded the small T7 change; the final build and 15 new
frontend scenarios were rerun independently after T7.

## Spec-anchored acceptance evidence

Each row compares an observable outcome with the requirement, rather than
counting a test name or a mocked call as sufficient evidence.

| ID       | Expected outcome and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Result |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| BFIN-01  | Owner/Admin only; invalid money/date/method rejected without receipt. `test/order-billing-completion-postgres-live.test.js:201` asserts rejected commands and zero receipts. HTTP boundary `test/order-billing-completion-routes.test.js:187` asserts auth/CSRF/origin/shape refusals and `calls.length === 0` at line 241.                                                                                                                                                                         | PASS   |
| BFIN-02  | Gateway 3000 + external 7000 yields 10000/0, two distinct sources, no fabricated transaction. `test/order-billing-completion-postgres-live.test.js:155` asserts received10000, balance0, payments2; lines158–180 assert both sources, author/effective day/recorded instant and one real provider transaction. Private canaries absent at line335.                                                                                                                                                  | PASS   |
| BFIN-03  | Replay/concurrency produce one effect; failed audit rolls everything back; settlement blocks send atomically. `test/order-billing-completion-postgres-live.test.js:244` asserts identical replay; line374 asserts one concurrent winner; lines410–424 assert rollback; line481 asserts blocked/PAYMENT_CONFIRMED.                                                                                                                                                                                   | PASS   |
| BFIN-04  | Full reversal retains original and private reason, recomputes balance and invalidates settlement/finance. `test/order-billing-completion-postgres-live.test.js:284` asserts replay equality, received0/balance10000, original10000 and reversing author/reason. Its database checks reject mutation/deletion and preserve history.                                                                                                                                                                  | PASS   |
| BFIN-05  | Late gateway payment remains visible for review without over-credit/negative balance; changed agreement invalidates application until explicit reconciliation. `test/order-billing-completion-postgres-live.test.js:350` asserts reviewRequired, received10000/balance0/payments2; lines503–515 assert invalidation and explicit reuse7000/balance4000.                                                                                                                                             | PASS   |
| BFIN-06  | Human request returns queued durable candidate; identifiers encrypted, no human payment claim. `test/order-billing-completion-postgres-live.test.js:526` asserts queued and replay ID, encrypted-canary absence and lookup values; line544 rejects paid result without stored payment. `test/order-billing-completion-routes.test.js:116` checks expected 202 for human consultation.                                                                                                               | PASS   |
| BFIN-07  | Provider-verified persistence precedes paid result/ACK; unpaid has no credit; malformed/underpaid response cannot ACK. `test/billing-development-check.test.js:141` asserts exact paid chain and line148 exact unpaid chain; line162 asserts failed ACK false. `test/order-billing-completion-postgres-live.test.js:579` asserts paid cannot regress under later not_paid.                                                                                                                          | PASS   |
| BFIN-08  | Six scheduled candidate checks maximum, safe bounded retry, no checkout creation; receive-only works. `test/order-billing-completion-postgres-live.test.js:554` asserts five further scheduled attempts and line561 asserts zero after sixth; lines562–577 assert six query jobs and no credit. `test/order-billing-payment-check-worker.test.js:33` asserts receive-only request1/effects0/sent; line87 covers retry safety/auth refusal.                                                          | PASS   |
| BFUI-01  | Explicit order/destination/review; opening has zero side effect. `test/e2e/billing-chat-real.spec.js:300` asserts one queued signal and preserved draft. Line329 covers direct linked order without subject; line358 asserts genuinely empty context invents no destination.                                                                                                                                                                                                                        | PASS   |
| BFUI-02  | Five real command shapes, immutable version/idempotency, separate send/payment state; unknown cannot retry blindly. `test/e2e/billing-chat-real.spec.js:377` asserts server-calculated balance; line597 existing-link reuse; line631 reviewed correction; line698 refuses unsafe retry and sends safe retry using same charge; line465 asserts same body/key after lost response.                                                                                                                   | PASS   |
| BFUI-03  | Shared totals/history/source/method/installments/receipt/link projection. `test/e2e/billing-chat-real.spec.js:416` checks real components on both entry points; line815 retains historical oversized link. `test/order-billing-chat-postgres-live.test.js:575` asserts persistent tied-ID pagination and cross-order cursor rejection; mixed ledger/history totals asserted at completion PG lines192–199.                                                                                          | PASS   |
| BFUI-04  | Reviewed external/reversal/check commands update real returned totals/history. `test/e2e/billing-chat-real.spec.js:416` checks body and updated totals; line494 sends identifiers only with no invented receipt; line902 asserts unapplied external receipt remains reversible and its reversal removes that action while retaining reason.                                                                                                                                                         | PASS   |
| BFUI-05  | Receive-only preserves query/receiving, conflicts reload versions and require new review; old response cannot replace current order. `test/e2e/billing-chat-real.spec.js:759` asserts send absent with external/check still available. Lines865–900 assert explicit re-review and new versions5/4/7 and fresh key. Supplemental `var/billing-verifier-stale-response.spec.js:942` delays order1 response, selects order2, then asserts selection2 and total200000 survive released order1 response. | PASS   |
| BFUI-06  | Draft/focus/Escape/keyboard and 1440/390/320 light/dark; zero axe violations and overflow. `test/e2e/billing-chat-real.spec.js:527` asserts both dialog axe results `[]`, width within clientWidth, readable CTA, Escape visibility and restored trigger focus; line300 asserts original draft remains.                                                                                                                                                                                             | PASS   |
| BDEV2-01 | Real n8n reserve/preflight/sink/sent/delivered, no duplicate effect on payment/context change. `scripts/billing-development-smoke.mjs:552` asserts owner-change blocked; line565 asserts payment-before-send blocked and zero sink effects. Read `var/billing-development-M5xsI8/report.json`: 17 scenarios PASS, resourcesRemoved true.                                                                                                                                                            | PASS   |
| BDEV2-02 | Safe retry uses same checkout, unknown forbids retry, late corrected predecessor stays review. `scripts/billing-development-smoke.mjs:496` asserts safe failure and zero effects, lines506–510 verify explicit retry; lines522–539 assert unknown/refused retry/one effect; line630 asserts late receipt review. Real n8n report confirms execution.                                                                                                                                                | PASS   |
| BDEV2-03 | Dedicated loopback API/UI/PG/n8n/simulator and real synthetic login/CSRF. `scripts/billing-development-interactive-smoke.mjs:90` asserts missed webhook produces zero initial credit, lines108–124 assert recovered3000 then mixed10000/0; line148 asserts one transport effect. `var/billing-interactive-smoke-result.json` PASS; integrator real-browser images `var/billing-completion-live-chat.jpg` and `var/billing-completion-live-order.jpg` show chat/order100/0.                          | PASS   |
| BDEV2-04 | Fixed owned resources, explicit reset, persistent stop/up. `test/billing-development-interactive.test.js:6` rejects reset without flag and alternate targets; line17 asserts internal network and loopback ports. `var/billing-interactive-restart-result.json` asserts database/simulator/workflow preserved and no duplicate gateway receipt. Manifest/runner read confirms fixed project and down without volume removal for stop.                                                               | PASS   |

All 18 requirements have outcome evidence. No spec-precision gap or current
unresolved acceptance failure remains. API schemas preserve nullable charge IDs
for external ledger/history entries. Read-only review confirmed encrypted notes,
candidates and receipt URLs; no real secret or PII was introduced by verification.

## Discrimination sensor

The verifier copied source/modules/fixtures to an isolated temporary directory,
used the reserved synthetic PostgreSQL, restored the scratch source between
mutations and ran the complete 13-scenario completion suite each time. Tests
failed through assertion failures, not syntax/import errors.

| Mutation                                               | Frozen source                                | Expected detector                                | Result                   |
| ------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------ | ------------------------ |
| Remove current-owner authorization                     | `apps/api/src/order-billing-runtime.js:425`  | BFIN-01/03 negative ACL assertion                | Killed: 12 pass / 1 fail |
| Remove external amount versus balance cap              | `apps/api/src/order-billing-runtime.js:569`  | BFIN-01/03 excessive amount rejection            | Killed: 12 pass / 1 fail |
| Accept paid-check result without stored payment        | `apps/api/src/order-billing-runtime.js:807`  | BFIN-06/08 expected BILLING_PAYMENT_NOT_RECORDED | Killed: 12 pass / 1 fail |
| Apply late payment even above order total              | `apps/api/src/order-billing-runtime.js:1101` | BFIN-05 preserved excess in review               | Killed: 12 pass / 1 fail |
| Omit external-receipt blocking of queued outbox intent | `apps/api/src/order-billing-runtime.js:600`  | BFIN-03 immediate blocked state                  | Killed: 12 pass / 1 fail |

Depth: expanded payment/security sensor, five behavior mutations. **5/5 killed**.
Scratch removed; real-tree porcelain matched the initial clean baseline before
writing this report. Machine result: `var/billing-completion-sensor-results.json`.
Supplemental stale-response scratch was also removed with unchanged porcelain.
Its initial invocation collected unrelated copied tests and failed discovery;
the corrected explicit single-file invocation passed. That harness failure is
not an application failure and is not counted as a passing scenario.

## Findings resolved before final verification

1. **BFUI-05:** a 409 originally retained stale versions. Final line865 E2E
   verifies reload, fresh explicit review, current order/billing/conversation
   versions and a new key.
2. **BFUI-04:** application-invalid external receipts originally lost their
   reversal action. Final line902 E2E verifies reversibility until an actual
   reversal exists, independently from credit application.
3. **BFUI-01:** real browser navigation found direct linked orders missing
   from selection when no subject existed. Final line329 E2E covers direct
   linkage; line358 retains the negative empty-context guard.

These are resolved coverage signals, not remaining blockers. Reusable lessons
L-009/L-010/L-011 were recorded through the skill's lesson script. No production activation,
provider payment or real message was performed.

## Operational limits

Real n8n evidence uses a local provider sink; it does not certify InfinitePay,
WhatsApp, EasyPanel or remote recovery. Interactive DEV remains available for
the owner to assess. The full-suite conditional external/environment gates
remain independent of this local feature verdict. No source/test was weakened,
no graph regenerated and no user resource removed by the verifier.

Completion gate: `validate_state.py order-billing-completion` passed with
zero errors. `git diff --check` passed. The only tracked changes produced by
verification are this report and the two script-owned lesson files.
