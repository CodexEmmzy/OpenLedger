# ADR 0005: Chart of accounts and currency boundaries

## Status

Accepted

## Context

Ledger entries need a stable accounting meaning so balance projections can apply debit and credit signs consistently. Provider settlement, fee recognition, and unresolved reconciliation amounts also need explicit destinations rather than special cases in transfer code.

## Decision

Customer wallet accounts are liability accounts with a credit-normal balance. Customer accounts cannot have negative natural balances. Account currency and accounting type are immutable after creation.

The initial system chart contains one account per listed currency for each role:

| Code prefix         | Account name      | Type      | Normal side | Negative allowed                                                                                 | Purpose                                                                                |
| ------------------- | ----------------- | --------- | ----------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `provider_clearing` | Provider clearing | Asset     | Debit       | Yes                                                                                              | Tracks the net amount due to or from a payment provider while settlement is in flight. |
| `fee_income`        | Fee income        | Income    | Credit      | Yes                                                                                              | Recognizes earned fees and permits later correction or refund postings.                |
| `suspense`          | Suspense          | Liability | Credit      | Holds unresolved funds pending reconciliation and permits either-side investigation adjustments. |

The migration seeds these accounts separately for `NGN` and `USD`. System accounts allow negative balances because settlement direction and corrections can temporarily produce either sign; account entries and complete transactions must still balance.

Every Phase 1 transaction uses exactly one currency. All participating accounts must have that currency. FX is deferred: a future exchange must be represented by separate balanced currency-specific transactions linked by an explicit conversion record, never by mixing currencies in one journal transaction.

Posted transactions are immutable. A correction is recorded as a new reversal transaction that references the original and exactly negates its entries. Transaction status may move from `pending` to `posted` or `failed`; terminal statuses do not move backwards. Status changes are recorded in append-only history.

## Consequences

- Entry direction can be converted to a signed balance projection using the account type's normal side.
- The database seeds stable system account codes, while customer accounts remain separately identifiable.
- The database rejects cross-currency postings and incomplete or unbalanced posted transactions at commit.
- FX, multi-currency transactions, and broader account products require a later ADR and schema review.
