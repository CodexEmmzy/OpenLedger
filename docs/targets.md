# OpenLedger scaling targets

Pick numbers before writing ledger code. Later phases measure against this table.

| Target                        | Number                                                                         | How you prove it                                 |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Sustained transfer throughput | 1,500 transfers/s on one Postgres primary                                      | k6 load test, results saved in the repo          |
| Hot-account contention        | 500 concurrent transfers out of one account, zero overdrafts                   | Concurrency test plus invariant check afterwards |
| Transfer latency              | p99 under 200 ms at target load                                                | k6 percentile output                             |
| Cached balance read latency   | p99 under 50 ms                                                                | k6 on the read endpoint                          |
| Duplicate request safety      | 1,000 retries of one idempotency key produce one transfer                      | Integration test                                 |
| Ledger invariant              | Entries per transaction sum to zero; account balance equals sum of its entries | Invariant checker job and property tests         |
| Failure recovery              | Kill the API or worker mid-transfer, no partial state                          | Chaos test script                                |

## Load sketch

5 million active users making 2 transfers a day is 10 million transfers a day: about 115/s average, about 1,200/s at a 10x peak. Reads outnumber writes 20–50x. The hard problem is correctness under contention on hot accounts, plus a read path that does not hammer the primary.

OpenLedger is done when someone can start it with one command, hit it with heavy concurrent traffic, and fail to corrupt a single balance.
