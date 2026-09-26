# Import-processing extrapolation register

This is a dated, portable summary of the owner's revised, bounded gap-fill study, created 2026-09-25. The original 120-cell live study was stopped after 14 primary attempts; its failures, partial results and unavailable usage remain in the [append-only experiment ledger](processing-follow-up-experiments.md). The original study is incomplete. This register fills missing rows with clearly labeled numerical scenarios where supported; it does not turn unattempted tests into completed measurements. Supplemental anchors are separate from these 120 cells.

## What is predictable

The scripted request schedule is predictable; autonomous model behavior and full-job latency are not established as linear. For the unchanged F1 harness, `C=N+ceil(N/U)+2`, `S=ceil(C/63)`, and `R=C+S` give tool calls, sessions and total requests. Each page still requires a read, so increasing unit size mainly removes publication calls. At N800, U10/U15/U20 require 896/870/856 requests. The independently verified full F1 matrix matches this exact schedule, including the completed U2 continuation; the initial U2 guard stop is preserved separately.

Serialized text does not scale exactly in proportion to page count. Across all seven tested unit sizes, four times as many pages produced 4.404–5.553 times as many serialized characters. A naive four-times extrapolation underestimates the N800 measurements by 9.18%–27.97%, using actual text as the denominator. In the scripted N800 fixture U15 and U20 reduce characters by 15.261% and 18.120% versus U10, but the first proposal is later: request 18 and 23 versus 13. At N200 their character savings are only 4.981% and 7.570%. These are controlled harness results, not live tokens or production timing.

The frozen two-endpoint model is `T(N,U)=T(200,U)*(N/200)^e(U)`, where `e(U)=log(T(800,U)/T(200,U))/log(4)`. A new N400 check, frozen before either measurement and without refitting, produced:

| N / U    | Frozen power prediction (characters) | Measured characters | Signed error / prediction | Requests / sessions | 25% criterion |
| -------- | ------------------------------------ | ------------------- | ------------------------- | ------------------- | ------------- |
| 400 / 10 | 172,236,675.74                       | 171,673,600         | -0.326920%                | 450 / 8             | pass          |
| 400 / 20 | 149,837,665.755                      | 149,874,480         | +0.024569%                | 429 / 7             | pass          |

Both new cells read, delivered and proposed all 400 pages exactly once, generated 400 fictional reviewable records, and left zero missing pages, duplicate reads, pending reads or accepted documents. These checks validate interpolation for this scripted fixture at U10/U20 between the original N200/N800 endpoints. They do not validate lower-length extrapolation, sizes above N800, provider tokens, clinical quality, identity resolution or live completion time. The primary criterion was absolute error divided by prediction ≤25%; signed errors above use that same denominator.

The unchanged model grid is shown below. N400/U10 and U20 now have independently verified measurements beside their earlier predictions; their forecast numbers have not been replaced. Other missing measurements remain explicitly marked. Modeled requests assume the fixed scripted schedule.

| N pages | U pages/unit | Evidence for text count      | Power-model characters | Measured characters | Modeled requests |
| ------- | ------------ | ---------------------------- | ---------------------- | ------------------- | ---------------- |
| 40      | 2            | EXTRAPOLATED                 | 38,777,735.262         | unmeasured          | 63               |
| 40      | 10           | EXTRAPOLATED                 | 11,099,238.196         | unmeasured          | 47               |
| 40      | 15           | EXTRAPOLATED                 | 12,045,848.458         | unmeasured          | 46               |
| 40      | 20           | EXTRAPOLATED                 | 11,808,879.314         | unmeasured          | 45               |
| 80      | 2            | EXTRAPOLATED                 | 82,016,725.451         | unmeasured          | 124              |
| 80      | 10           | EXTRAPOLATED                 | 25,337,832.62          | unmeasured          | 92               |
| 80      | 15           | EXTRAPOLATED                 | 25,968,631.659         | unmeasured          | 90               |
| 80      | 20           | EXTRAPOLATED                 | 25,372,828.761         | unmeasured          | 88               |
| 100     | 2            | EXTRAPOLATED                 | 104,383,551.444        | unmeasured          | 155              |
| 100     | 10           | EXTRAPOLATED                 | 33,050,120.89          | unmeasured          | 114              |
| 100     | 15           | EXTRAPOLATED                 | 33,254,317.279         | unmeasured          | 111              |
| 100     | 20           | EXTRAPOLATED                 | 32,456,418.171         | unmeasured          | 109              |
| 200     | 2            | MEASURED endpoint            | 220,776,098            | 220,776,098         | 307              |
| 200     | 10           | MEASURED endpoint            | 75,448,280             | 75,448,280          | 226              |
| 200     | 15           | MEASURED endpoint            | 71,690,186             | 71,690,186          | 220              |
| 200     | 20           | MEASURED endpoint            | 69,736,604             | 69,736,604          | 216              |
| 400     | 2            | EXTRAPOLATED (interpolation) | 466,951,782.859        | unmeasured          | 612              |
| 400     | 10           | MEASURED validation          | 172,236,675.74         | 171,673,600         | 450              |
| 400     | 15           | EXTRAPOLATED (interpolation) | 154,550,842.996        | unmeasured          | 436              |
| 400     | 20           | MEASURED validation          | 149,837,665.755        | 149,874,480         | 429              |
| 800     | 2            | MEASURED endpoint            | 987,624,881            | 987,624,881         | 1222             |
| 800     | 10           | MEASURED endpoint            | 393,189,513            | 393,189,513         | 896              |
| 800     | 15           | MEASURED endpoint            | 333,183,165            | 333,183,165         | 870              |
| 800     | 20           | MEASURED endpoint            | 321,944,643            | 321,944,643         | 856              |

## What the live tests actually found

There are 14 measured primary attempts: six strictly complete and eight incomplete. All eight dense attempts extracted some literal records; six completed, one reached its time guard despite extracting all 160 records, and one encountered a provider-window/accounting interruption. All six measured mixed-document attempts failed to complete. Failures are outcomes, not cheap successful runs. No original 200-page single-report arm ran.

| Cell                   | Strict complete | Literal correct / expected | Requests | Known tokens     | Observed stop time (min) | Stop              |
| ---------------------- | --------------- | -------------------------- | -------- | ---------------- | ------------------------ | ----------------- |
| heldout-dense-0-r1-u2  | no              | 160/160                    | 62       | 4,038,531        | 32.6468                  | time_limit        |
| heldout-dense-0-r1-u10 | yes             | 160/160                    | 122      | 3,204,946        | 42.4810                  | reading_exhausted |
| heldout-dense-0-r1-u15 | yes             | 160/160                    | 116      | 3,152,735        | 41.6441                  | reading_exhausted |
| heldout-dense-0-r1-u20 | no              | 4/160                      | 5        | 64,347 + unknown | 1.0570                   | error             |
| heldout-dense-1-r1-u10 | yes             | 160/160                    | 115      | 3,154,529        | 40.2448                  | reading_exhausted |
| heldout-dense-1-r1-u15 | yes             | 160/160                    | 142      | 3,458,740        | 45.7952                  | reading_exhausted |
| heldout-dense-1-r1-u20 | yes             | 160/160                    | 141      | 3,427,738        | 44.8102                  | reading_exhausted |
| heldout-dense-1-r1-u2  | yes             | 160/160                    | 92       | 3,479,035        | 37.5038                  | reading_exhausted |
| heldout-mixed-0-r1-u15 | no              | 0/24                       | 11       | 273,013          | 0.9035                   | no_progress       |
| heldout-mixed-0-r1-u20 | no              | 0/24                       | 11       | 273,422          | 0.9318                   | no_progress       |
| heldout-mixed-0-r1-u2  | no              | 0/24                       | 11       | 275,194          | 0.9142                   | no_progress       |
| heldout-mixed-0-r1-u10 | no              | 0/24                       | 11       | 274,241          | 0.9471                   | no_progress       |
| heldout-mixed-1-r1-u20 | no              | 18/24                      | 82       | 6,316,867        | 18.0753                  | no_progress       |
| heldout-mixed-1-r1-u2  | no              | 0/24                       | 50       | 1,767,984        | 9.5606                   | no_progress       |

Literal grading and host association are separate endpoints. Dense association had a zero denominator and is unmeasured; all dense records remained identity-pending and unselectable, with zero accepted writes. Mixed association scored 0/24 in every measured mixed cell. Mixed1/U20 returned 21 records but strict literal grading counted 18/24; mixed1/U2 returned nine records but counted 0/24. The rejected multi-page provenance formats and missing records remain failures under the original criteria, even though independent source inspection supported the returned values/dates. See the ledger for exact host-read versus delivered-read corrections and manual source-context findings.

The complete four-arm comparison on dense document 1 does not show that ever-larger units are better. U10 used 9.3275% fewer tokens than U2 but took 7.3087% longer; U15 and U20 used 0.5834% and 1.4745% fewer tokens than U2 and took 22.1081% and 19.4818% longer. This is one document/repetition, not an arm-wide ranking. Mixed0 failed with cyclic rereads in all four arms, consistent with loss of early identity/date context; the unchanged tests do not prove a remedy.

The original dense0/U20 primary remains a five-request partial attempt with 64,347 known tokens and request 5 usage unknown. Its separately authorized, preserved continuation reached 160/160 literal records but ended at a time limit: still not strictly complete. Its cumulative 146 requests and 3,502,207 known tokens include the original known 64,347; add only the 141-request, 3,437,860-token suffix when computing campaign cost. It is excluded from successful calibration and is not a fifteenth original primary cell.

## Conditional live scenarios

For each U, use only strictly complete, fully accounted dense40 cells. The frozen model is `M(N)=B+(N/40)*(M(40)-B)`; B is the first two attempted request contributions treated as a fixed allowance. Those requests may include a first read, so B is not pure setup. Average available same-U predictions. At N40 this is simply the mean of the available complete same-U anchors:

| U   | Complete calibration cells                     | Conditional tokens | Conditional requests | Duration scenario (min) |
| --- | ---------------------------------------------- | ------------------ | -------------------- | ----------------------- |
| 2   | heldout-dense-1-r1-u2                          | 3,479,035          | 92                   | 37.5038                 |
| 10  | heldout-dense-0-r1-u10, heldout-dense-1-r1-u10 | 3,179,737.5        | 118.5                | 41.3629                 |
| 15  | heldout-dense-0-r1-u15, heldout-dense-1-r1-u15 | 3,305,737.5        | 129                  | 43.7196                 |
| 20  | heldout-dense-1-r1-u20                         | 3,427,738          | 141                  | 44.8102                 |

These numbers are **EXTRAPOLATED conditional scenarios** for unexecuted repeats. Fractional requests are means, not possible completed request counts. U2 and U20 each have only one eligible anchor; U10/U15 have two. The identical value is copied into each unexecuted repeat. There is no invented repeat noise, confidence interval or success probability. Conditioning on completed runs excludes observed failures and therefore must not be read as expected cost for an arbitrary import. Duration scenarios are not reliable latency forecasts, and unexecuted quality, identity, cache behavior, retries and completion probability are NOT_ESTIMABLE.

Every cell also retains its original STRUCTURAL_MODEL token estimate, generated before live work for the original stop-rule calculation. It is separate from both measured usage and the empirical scenario. Successful dense actual-to-structural ratios range from 0.2790 to 0.9029; the old structural numbers are not validated live forecasts. Failed mixed runs cannot calibrate successful completion, and no successful original single-report family anchor exists in this snapshot.

## Original 120-cell register

There are exactly **14 MEASURED**, **32 EXTRAPOLATED** and **74 NOT_ESTIMABLE** rows. All 106 unmeasured rows are unattempted. Every row retains its structural model. MEASURED means an attempted run with its original completion/failure status shown above; it does not mean the study passed. EXTRAPOLATED means a conditional cost scenario, not a quality or completion forecast. NOT_ESTIMABLE means empirical successful-completion cost is unsupported; it does not erase the separate structural estimate. Known actual tokens exclude missing usage rather than assigning it zero.

| Order (0-based) | Cell                    | Evidence class | Known actual tokens | Conditional empirical tokens | Original structural tokens |
| --------------- | ----------------------- | -------------- | ------------------- | ---------------------------- | -------------------------- |
| 0               | heldout-dense-0-r1-u2   | MEASURED       | 4,038,531           | measured attempt; see above  | 12,469,942                 |
| 1               | heldout-dense-0-r1-u10  | MEASURED       | 3,204,946           | measured attempt; see above  | 3,796,283                  |
| 2               | heldout-dense-0-r1-u15  | MEASURED       | 3,152,735           | measured attempt; see above  | 3,942,232                  |
| 3               | heldout-dense-0-r1-u20  | MEASURED       | 64,347 + unknown    | measured attempt; see above  | 3,796,283                  |
| 4               | heldout-dense-1-r1-u10  | MEASURED       | 3,154,529           | measured attempt; see above  | 3,796,283                  |
| 5               | heldout-dense-1-r1-u15  | MEASURED       | 3,458,740           | measured attempt; see above  | 3,942,232                  |
| 6               | heldout-dense-1-r1-u20  | MEASURED       | 3,427,738           | measured attempt; see above  | 3,796,283                  |
| 7               | heldout-dense-1-r1-u2   | MEASURED       | 3,479,035           | measured attempt; see above  | 12,469,942                 |
| 8               | heldout-mixed-0-r1-u15  | MEASURED       | 273,013             | measured attempt; see above  | 3,608,365                  |
| 9               | heldout-mixed-0-r1-u20  | MEASURED       | 273,422             | measured attempt; see above  | 3,467,966                  |
| 10              | heldout-mixed-0-r1-u2   | MEASURED       | 275,194             | measured attempt; see above  | 12,425,198                 |
| 11              | heldout-mixed-0-r1-u10  | MEASURED       | 274,241             | measured attempt; see above  | 3,751,539                  |
| 12              | heldout-mixed-1-r1-u20  | MEASURED       | 6,316,867           | measured attempt; see above  | 3,467,966                  |
| 13              | heldout-mixed-1-r1-u2   | MEASURED       | 1,767,984           | measured attempt; see above  | 12,425,198                 |
| 14              | heldout-mixed-1-r1-u10  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,751,539                  |
| 15              | heldout-mixed-1-r1-u15  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,608,365                  |
| 16              | heldout-single-0-r1-u2  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 59,470,547                 |
| 17              | heldout-single-0-r1-u10 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,919,928                 |
| 18              | heldout-single-0-r1-u15 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,318,959                 |
| 19              | heldout-single-0-r1-u20 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 20,973,813                 |
| 20              | heldout-single-1-r1-u10 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,919,928                 |
| 21              | heldout-single-1-r1-u15 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,318,959                 |
| 22              | heldout-single-1-r1-u20 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 20,973,813                 |
| 23              | heldout-single-1-r1-u2  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 59,470,547                 |
| 24              | heldout-dense-0-r2-u10  | EXTRAPOLATED   | unattempted         | 3,179,737.5                  | 3,796,283                  |
| 25              | heldout-dense-0-r2-u15  | EXTRAPOLATED   | unattempted         | 3,305,737.5                  | 3,942,232                  |
| 26              | heldout-dense-0-r2-u20  | EXTRAPOLATED   | unattempted         | 3,427,738                    | 3,796,283                  |
| 27              | heldout-dense-0-r2-u2   | EXTRAPOLATED   | unattempted         | 3,479,035                    | 12,469,942                 |
| 28              | heldout-dense-1-r2-u15  | EXTRAPOLATED   | unattempted         | 3,305,737.5                  | 3,942,232                  |
| 29              | heldout-dense-1-r2-u20  | EXTRAPOLATED   | unattempted         | 3,427,738                    | 3,796,283                  |
| 30              | heldout-dense-1-r2-u2   | EXTRAPOLATED   | unattempted         | 3,479,035                    | 12,469,942                 |
| 31              | heldout-dense-1-r2-u10  | EXTRAPOLATED   | unattempted         | 3,179,737.5                  | 3,796,283                  |
| 32              | heldout-mixed-0-r2-u20  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,467,966                  |
| 33              | heldout-mixed-0-r2-u2   | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 12,425,198                 |
| 34              | heldout-mixed-0-r2-u10  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,751,539                  |
| 35              | heldout-mixed-0-r2-u15  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,608,365                  |
| 36              | heldout-mixed-1-r2-u2   | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 12,425,198                 |
| 37              | heldout-mixed-1-r2-u10  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,751,539                  |
| 38              | heldout-mixed-1-r2-u15  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,608,365                  |
| 39              | heldout-mixed-1-r2-u20  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,467,966                  |
| 40              | heldout-single-0-r2-u10 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,919,928                 |
| 41              | heldout-single-0-r2-u15 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,318,959                 |
| 42              | heldout-single-0-r2-u20 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 20,973,813                 |
| 43              | heldout-single-0-r2-u2  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 59,470,547                 |
| 44              | heldout-single-1-r2-u15 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,318,959                 |
| 45              | heldout-single-1-r2-u20 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 20,973,813                 |
| 46              | heldout-single-1-r2-u2  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 59,470,547                 |
| 47              | heldout-single-1-r2-u10 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,919,928                 |
| 48              | heldout-dense-0-r3-u15  | EXTRAPOLATED   | unattempted         | 3,305,737.5                  | 3,942,232                  |
| 49              | heldout-dense-0-r3-u20  | EXTRAPOLATED   | unattempted         | 3,427,738                    | 3,796,283                  |
| 50              | heldout-dense-0-r3-u2   | EXTRAPOLATED   | unattempted         | 3,479,035                    | 12,469,942                 |
| 51              | heldout-dense-0-r3-u10  | EXTRAPOLATED   | unattempted         | 3,179,737.5                  | 3,796,283                  |
| 52              | heldout-dense-1-r3-u20  | EXTRAPOLATED   | unattempted         | 3,427,738                    | 3,796,283                  |
| 53              | heldout-dense-1-r3-u2   | EXTRAPOLATED   | unattempted         | 3,479,035                    | 12,469,942                 |
| 54              | heldout-dense-1-r3-u10  | EXTRAPOLATED   | unattempted         | 3,179,737.5                  | 3,796,283                  |
| 55              | heldout-dense-1-r3-u15  | EXTRAPOLATED   | unattempted         | 3,305,737.5                  | 3,942,232                  |
| 56              | heldout-mixed-0-r3-u2   | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 12,425,198                 |
| 57              | heldout-mixed-0-r3-u10  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,751,539                  |
| 58              | heldout-mixed-0-r3-u15  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,608,365                  |
| 59              | heldout-mixed-0-r3-u20  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,467,966                  |
| 60              | heldout-mixed-1-r3-u10  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,751,539                  |
| 61              | heldout-mixed-1-r3-u15  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,608,365                  |
| 62              | heldout-mixed-1-r3-u20  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,467,966                  |
| 63              | heldout-mixed-1-r3-u2   | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 12,425,198                 |
| 64              | heldout-single-0-r3-u15 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,318,959                 |
| 65              | heldout-single-0-r3-u20 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 20,973,813                 |
| 66              | heldout-single-0-r3-u2  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 59,470,547                 |
| 67              | heldout-single-0-r3-u10 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,919,928                 |
| 68              | heldout-single-1-r3-u20 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 20,973,813                 |
| 69              | heldout-single-1-r3-u2  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 59,470,547                 |
| 70              | heldout-single-1-r3-u10 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,919,928                 |
| 71              | heldout-single-1-r3-u15 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,318,959                 |
| 72              | heldout-dense-0-r4-u20  | EXTRAPOLATED   | unattempted         | 3,427,738                    | 3,796,283                  |
| 73              | heldout-dense-0-r4-u2   | EXTRAPOLATED   | unattempted         | 3,479,035                    | 12,469,942                 |
| 74              | heldout-dense-0-r4-u10  | EXTRAPOLATED   | unattempted         | 3,179,737.5                  | 3,796,283                  |
| 75              | heldout-dense-0-r4-u15  | EXTRAPOLATED   | unattempted         | 3,305,737.5                  | 3,942,232                  |
| 76              | heldout-dense-1-r4-u2   | EXTRAPOLATED   | unattempted         | 3,479,035                    | 12,469,942                 |
| 77              | heldout-dense-1-r4-u10  | EXTRAPOLATED   | unattempted         | 3,179,737.5                  | 3,796,283                  |
| 78              | heldout-dense-1-r4-u15  | EXTRAPOLATED   | unattempted         | 3,305,737.5                  | 3,942,232                  |
| 79              | heldout-dense-1-r4-u20  | EXTRAPOLATED   | unattempted         | 3,427,738                    | 3,796,283                  |
| 80              | heldout-mixed-0-r4-u10  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,751,539                  |
| 81              | heldout-mixed-0-r4-u15  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,608,365                  |
| 82              | heldout-mixed-0-r4-u20  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,467,966                  |
| 83              | heldout-mixed-0-r4-u2   | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 12,425,198                 |
| 84              | heldout-mixed-1-r4-u15  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,608,365                  |
| 85              | heldout-mixed-1-r4-u20  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,467,966                  |
| 86              | heldout-mixed-1-r4-u2   | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 12,425,198                 |
| 87              | heldout-mixed-1-r4-u10  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,751,539                  |
| 88              | heldout-single-0-r4-u20 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 20,973,813                 |
| 89              | heldout-single-0-r4-u2  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 59,470,547                 |
| 90              | heldout-single-0-r4-u10 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,919,928                 |
| 91              | heldout-single-0-r4-u15 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,318,959                 |
| 92              | heldout-single-1-r4-u2  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 59,470,547                 |
| 93              | heldout-single-1-r4-u10 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,919,928                 |
| 94              | heldout-single-1-r4-u15 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,318,959                 |
| 95              | heldout-single-1-r4-u20 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 20,973,813                 |
| 96              | heldout-dense-0-r5-u2   | EXTRAPOLATED   | unattempted         | 3,479,035                    | 12,469,942                 |
| 97              | heldout-dense-0-r5-u10  | EXTRAPOLATED   | unattempted         | 3,179,737.5                  | 3,796,283                  |
| 98              | heldout-dense-0-r5-u15  | EXTRAPOLATED   | unattempted         | 3,305,737.5                  | 3,942,232                  |
| 99              | heldout-dense-0-r5-u20  | EXTRAPOLATED   | unattempted         | 3,427,738                    | 3,796,283                  |
| 100             | heldout-dense-1-r5-u10  | EXTRAPOLATED   | unattempted         | 3,179,737.5                  | 3,796,283                  |
| 101             | heldout-dense-1-r5-u15  | EXTRAPOLATED   | unattempted         | 3,305,737.5                  | 3,942,232                  |
| 102             | heldout-dense-1-r5-u20  | EXTRAPOLATED   | unattempted         | 3,427,738                    | 3,796,283                  |
| 103             | heldout-dense-1-r5-u2   | EXTRAPOLATED   | unattempted         | 3,479,035                    | 12,469,942                 |
| 104             | heldout-mixed-0-r5-u15  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,608,365                  |
| 105             | heldout-mixed-0-r5-u20  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,467,966                  |
| 106             | heldout-mixed-0-r5-u2   | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 12,425,198                 |
| 107             | heldout-mixed-0-r5-u10  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,751,539                  |
| 108             | heldout-mixed-1-r5-u20  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,467,966                  |
| 109             | heldout-mixed-1-r5-u2   | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 12,425,198                 |
| 110             | heldout-mixed-1-r5-u10  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,751,539                  |
| 111             | heldout-mixed-1-r5-u15  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 3,608,365                  |
| 112             | heldout-single-0-r5-u2  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 59,470,547                 |
| 113             | heldout-single-0-r5-u10 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,919,928                 |
| 114             | heldout-single-0-r5-u15 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,318,959                 |
| 115             | heldout-single-0-r5-u20 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 20,973,813                 |
| 116             | heldout-single-1-r5-u10 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,919,928                 |
| 117             | heldout-single-1-r5-u15 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 21,318,959                 |
| 118             | heldout-single-1-r5-u20 | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 20,973,813                 |
| 119             | heldout-single-1-r5-u2  | NOT_ESTIMABLE  | unattempted         | NOT_ESTIMABLE                | 59,470,547                 |

The original five-repeat, six-document paired confidence intervals, quality noninferiority gates, long-report comparison and all-120-gated finalization diagnostic remain unmet/deferred. No default unit size or production change is selected from this register. Its supported decision is that larger units reduce deterministic overhead, while live quality/context retention and latency require separate evidence.

## Supplemental bounded anchors — snapshot before authentication recovery

The owner authorized approximately 90 minutes of additional live work: dense20/U10 (30-minute dispatch allowance), single20/U10 (15 minutes), then single80/U10 (45 minutes). These fictional inputs and predictions were frozen separately; they are not replacements for original matrix cells. The dense20 prediction was 1,601,608.5 total tokens and 60.25 requests. Its 20.7589-minute duration is a conditional scenario only. The single80 rule must freeze a prediction from eligible single20 calibration before single80 dispatch, or explicitly record NOT_ESTIMABLE if calibration fails.

At this snapshot, dense20's first request returned HTTP 401 with upstream invalid_api_key; the run stopped after approximately 2.987 seconds, with no reads, proposals or accepted writes. Usage was absent and remains unknown. This is an authentication failure, not a 90-minute timeout or a failed numerical prediction. Single20 and single80 were unattempted. No full-job model-error percentage is computed from this interrupted attempt. Any independently reviewed same-run recovery and its cumulative costs/results must be recorded separately; this snapshot does not claim execution completion or a positive final review.

## Reproduction and evidence

The external generation command is `node generate.ts MODEL_BUNDLE INTERPOLATION_BUNDLE OUTPUT.md`. It reads the frozen `original-120-register-v2.json`, `model-report.json` and independently verified interpolation `summary.json`, checks row counts/uniqueness/structural preservation, and renders the portable counts above. It performs no provider calls, OCR, repository mutations or model refitting. Original model reconstruction is `node rebuild.ts LIVE_BUNDLE F1_BUNDLE NEW_OUTPUT_DIR`; its frozen input receipts and script hashes are recorded in the [experiment ledger](processing-follow-up-experiments.md#f2-prospective-extrapolation-models-and-independent-supplemental-clearance). Raw artifacts remain outside Git.

Input SHA-256 values:

- Original 120-cell register v2: `d72ba84f5f773c814325fb8a9b616fa4393b37ed598780aeb4df576c38d55d1e`.
- Original model report: `ac0ee7ef3d1ee1e11a5cc0fb8368db011e5dc0b41ff7bc724c8c39268c52c49e`.
- N400 interpolation summary: `c0d809a2c8178c5b177d529b1d9165107c18364cc80b5f5ad14f3878d9fc938f`.
- This draft generator: `bc3cfaff4cc2a4949cbaa1b9547533c643b2354a6ef0dec9b4c409f236cc3323`.

The 14 original result receipts are:

| Primary cell           | Result SHA-256                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| heldout-dense-0-r1-u2  | `3558d9c034c66cd7b54ce33c5699290ac072663ca93829794c48b78e93d4db2b` |
| heldout-dense-0-r1-u10 | `4d7e2f0bd115058ef4c232aa2b287c862da6ec2ea7f9181e2892203442ae938f` |
| heldout-dense-0-r1-u15 | `53a5cead09cd8c5879eae7d810e74ee656f264b8042bd319d70324332b6cc922` |
| heldout-dense-0-r1-u20 | `95b50606a54c20f3e1621c765c4fef0ef1075b47e9fdbd84a43acd84a33415d4` |
| heldout-dense-1-r1-u10 | `cff98a975fa6b087647b7c562ec0b37b3eb8b87f75660a46b8657142f815941f` |
| heldout-dense-1-r1-u15 | `4fdf4481dc2035ca5c66f8d8decac1756053cfbcc766454d8e80ba7d398d881e` |
| heldout-dense-1-r1-u20 | `b124aafae2b838be9ef8ea9e5b79d6ca45111182fc11a485c0758b23b6127f5b` |
| heldout-dense-1-r1-u2  | `d42f16980d2b720bf291b9c66e77ec5849ac6d76b02254580f09b81e95d292ec` |
| heldout-mixed-0-r1-u15 | `3b6c946be159ab7032109aa70749a29057065c6bd913f47d75de8f38e39392b1` |
| heldout-mixed-0-r1-u20 | `82965dca3ee9f53f66f6ed1ba60190f4c2c150ad35fbf1e09799304469ef691c` |
| heldout-mixed-0-r1-u2  | `e98e01f1bfbfc8dfd15418b4f0c00b9fafa08785ec73410654df65fb4d7953d5` |
| heldout-mixed-0-r1-u10 | `56a04293227bd5a728946bebb2839136a1d6f400a24cbece37d730bc67e02ce7` |
| heldout-mixed-1-r1-u20 | `4194ba99ee68fc40f85828cd3094aaee6ef45a6329cb2d85ae540c558ff3023a` |
| heldout-mixed-1-r1-u2  | `b499c853b6e169e76139aea83d3c82852d321a640fc953c23013be0e68413da5` |

Independent verification of this synthesized register is pending; the underlying original results and the N400 validation have their separate verification entries in the experiment ledger. A later review should check all row labels/numbers against the pinned register and reconcile supplemental outcomes without rewriting earlier recordings.

### Independent verification — portable extrapolation register

**Agree with the register's numbers and qualifications; this is not final execution completion.** I independently compared all120 portable matrix rows with the original frozen run plan, re-opened and hash-checked all14 actual primary receipts, and checked completion, literal grades, request counts, duration and reported usage against those receipts. The draft reviewed has SHA-256 `4b7451f1d1f6a2716c438a8200a66e7f50ceba5f0ff029fe0e1f43d50bf6dbf1`.

The register contains exactly14 measured attempts,32 conditional extrapolated dense rows and74 rows without an empirical completion estimate. Six of the14 are strictly complete. The known primary token subtotal is33,161,322; the original U20 missing usage remains explicitly unknown. All120 original structural token estimates remain unchanged. Every unexecuted row is still unattempted, and every extrapolated dense token/request/duration scenario equals the appropriate mean of the eligible same-unit completed receipts; no fabricated repeat noise or quality result is inserted.

I independently recomputed all24 scripted grid predictions from the original200/800 endpoints and checked the exact request/session formulas. The two new400-page power predictions and their residuals reproduce from those endpoints: U10−0.3269198%, U20+0.0245694%, both within the predeclared25%criterion. The text correctly limits this evidence to interior interpolation for the fixed scripted schedule and distinguishes it from live inference tokens, latency and quality. It preserves each forecast beside the new measurement instead of replacing a prediction with its outcome.

The narrative preserves the difference between literal extraction and host identity/association, failed-job stop time versus successful latency, original primary U20 versus its separate cumulative supplement, and an attempted run versus a successful run. The unknown first supplemental401 is not assigned a numerical model-error percentage, and unattempted single anchors are not presented as complete. I found no personal filesystem paths in the portable output. The original120 confidence/noninferiority study and finalization remain unmet/deferred.

Independent reconstruction is retained as `verify-register.mjs` and `register-verification.json` outside Git. This clears publication of this explicitly dated pre-recovery register snapshot. Later supplemental results, accounting and forecast eligibility must be appended and independently checked before the revised90-minute execution scope can receive its final review.

## Supplemental outcome addendum — 2026-09-26

All three bounded anchors now have independently verified terminal outcomes. This append-only addendum supersedes the earlier in-progress snapshot without replacing its frozen predictions or original 120-row register.

- **Dense20/U10:** the reviewed same-state Resume recovered all 80 observations and read all twenty pages once. There are sixty cumulative attempts: the original usage-unknown401 plus fifty-nine measured successful responses. Known usage is 1,474,365 tokens; cumulative active time is 21.331044 minutes. Application reading is complete, but a fully accounted primary result and full-job prediction validation remain unavailable. All eighty host records still require identity confirmation. The productive suffix is descriptively 7.9447% below the frozen token scenario and 2.5163% above its duration scenario; excluding the original unknown charge does not satisfy the full-job validation gate.
- **Single20/U10:** no_progress after 55.781138 seconds and 270,396 measured tokens; zero complete documents and zero of six expected facts. The host read ten times over three distinct pages; nine receipts reached the model. Neither the fifteen-minute allowance nor token guard caused the stop. This failed calibration correctly froze single80's completion forecast as NOT_ESTIMABLE with null numerical predictions before its dispatch.
- **Single80/U10:** no_progress after 4.247130 minutes and 1,255,684 measured tokens; zero correct complete documents and zero of six facts inside the required document. A selectable partial document was produced, and a separate observation retained one of the six facts, but neither satisfies the frozen complete-document endpoint. Twenty-four host reads visited ten pages, with twenty-three returned receipts; seventy pages remained unread. The forty-five-minute allowance and token cap did not trigger.

These results leave the register's seventy-four unsupported empirical completion rows unsupported: no successful single-family calibration was obtained, and mixed failures cannot predict successful completion either. The thirty-two dense estimates remain conditional scenarios, not verified repeated outcomes. The separately verified N400 results support the stated scripted interpolation only. The evidence rejects assuming a universal linear full-document scaling law; it does not justify invented quality, completion probability or successful-job latency.

The anchors consumed 26.507860 active minutes, one hundred attempts and 3,000,445 known tokens. Including prior campaign/setup evidence gives 1,239 attempts and 39,760,689 known tokens; seven request identities have unknown usage, so this is a lower bound. Original and partial recordings, failed criteria, forecast files and independent verifications remain in the [result ledger](processing-follow-up-experiments.md#bounded-anchors--all-terminal-outcomes-and-independent-verification). No extra tests were run to exhaust the ninety-minute allowance. All live processes have stopped. Final independent execution review is separate from these scientific outcomes.

## Final execution review — 2026-09-26

The independent reviewer gives the revised bounded follow-up **9/10 for completeness and 9/10 for extendedness**, with a positive execution disposition. All declared supplemental attempts, their negative outcomes and the accounting are recorded and verified; no further live or OCR run is required for this scope. The [full final review](processing-follow-up-experiments.md#final-independent-review--bounded-follow-up-closure) preserves the seven unknown-usage requests, unsupported single-report forecasts and incomplete original 120-cell study. This completes the revised execution/review request, not scientific qualification or production adoption. The recurring follow-up is being stopped as requested.

## Rereading-remedy investigation addendum — 2026-09-26

The separately authorized four-hour investigation adds measured20- and40-page attempts with a source-retention prototype; it does not alter the original120-cell register. Both read every page once and retained all six clinical findings. The20-page attempt failed its one-complete-document endpoint; the40-page attempt failed its separately predeclared all-pages-in-proposal endpoint (7/40 full pages,33 administrative pages omitted from emitted payloads, originals preserved). Independent review disclosed four additional evaluator false positives without changing either grade.

The held-out80-page arm remains unattempted, so there is no qualified eighty/200-page successful-import forecast. The measured40/20 ratios are2.8682× tokens,1.9167× requests and1.4453× duration; these are descriptive and cannot establish linear scaling or quality. No unexecuted row becomes a measurement or pass. Full findings, preserved failures and independent accounting appear in the [four-hour synthesis](processing-follow-up-experiments.md#four-hour-investigation-synthesis--2026-09-26). Final scope review is pending; no production adoption follows.

## Four-hour investigation closure

The [final independent review](processing-follow-up-experiments.md#four-hour-investigation-final-independent-closure) is positive for bounded execution: completeness **9/10**, extendedness **8/10**. All actual20/40-page remedy outcomes and accounting are verified. The80-page holdout remains unattempted because its fixed prerequisite failed; no successful long-report cost or quality forecast is validated. Existing matrix statuses and unknown usage remain unchanged. Both timers are being stopped; this is execution closure, not scientific or production qualification.
