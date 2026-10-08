> **已过期，见 HANDOFF-CODEX.md。**（本文停留在当时的世界与版本，结论不再适用。）

# Local Mayor City Issue Awareness v0

Local Mayor now scans bounded structured Snapshot signals into a compact `CityIssue[]`. It does not use screenshots, OCR, citizen-level scans, mouse/keyboard automation, providers, or a second decision engine.

| Issue kind | Authoritative source | Observable | Actionable in Local Mayor v0 | Reliability | Alpha priority |
| --- | --- | --- | --- | --- | --- |
| `electricity_shortage` | `Snapshot.utilities.electricity` production/consumption/fulfilled consumption/status | Yes | Yes: shared Bootstrap/Local facility, connector and authoritative readback recovery | authoritative | P0 |
| `water_shortage` | `Snapshot.utilities.water` capacity/consumption/fulfilled consumption/status | Yes | Yes: shared Bootstrap/Local facility, connector and authoritative readback recovery | authoritative | P0 |
| `sewage_shortage` | `Snapshot.utilities.sewage` capacity/consumption/fulfilled consumption/status | Yes | Yes: shared Bootstrap/Local facility, connector and authoritative readback recovery | authoritative | P0 |
| `garbage_pressure` | `Snapshot.utilities.garbage.accumulationRate` | Yes | No; observation only because no bounded Local Mayor garbage repair primitive exists | structured | P1 |
| `fire_service_deficit` | `Snapshot.cityServices.fire` status/efficiency | Yes when unavailable or efficiency is below the bounded deficit threshold | No; observation only | structured | P1 |
| `healthcare_service_deficit` | `Snapshot.cityServices.healthcare` status/efficiency | Yes when unavailable or efficiency is below the bounded deficit threshold | No; observation only | structured | P1 |
| `police_service_deficit` | `Snapshot.cityServices.police` status/efficiency | Yes when unavailable or efficiency is below the bounded deficit threshold | No; observation only | structured | P1 |
| `worker_shortage` | bounded `Snapshot.warnings.topTypes/topItems` notification aggregates | Yes | No; observation only | notification | P2 |
| `abandoned_buildings` | bounded `Snapshot.warnings.topTypes/topItems` notification aggregates | Yes | No; observation only | notification | P2 |
| `finance_runway` | `Snapshot.economy.treasury/monthlyBalance` | Yes when runway is below three deficit observations | No repair action; existing finance-protection goal suppresses noncritical growth | authoritative | P2 |

Traffic congestion, happiness, complaints, high rent, profitability and detailed unemployment are not emitted by the current structured Snapshot contract. They remain unsupported/backlog rather than being inferred. The existing `traffic.status=unavailable` is preserved as unavailable.

Issues have stable keys, bounded top targets, severity, urgency, priority band, evidence class, actionable flag, first/last seen and bounded persistence. Critical utilities are immediate. Minor notification signals do not create a goal or action; repeated signals can promote severity without causing an action loop. Resolved issues disappear on the next fresh Snapshot and their old issue goal is dropped.

The highest issue is projected through the existing Local Mayor Activity card. Observable-only messages explicitly say automatic handling is unsupported.

## Service recovery v0 audit

The production Local runtime and Bootstrap now call the same bounded shared utility recovery primitive. It reuses the existing Spatial utility planner and safety facts, native-preflights every facility/network action, requires an authoritative placement entity receipt, reads connectors belonging to that exact entity, and verifies fresh capacity after attachment. Electricity, water and sewage may therefore enter `recovering`. Garbage, fire, healthcare and police remain observable-only.

`LocalServiceRecoveryIntent` is bounded to one issue, one action kind, one target domain, a created revision, at most three attempts and a four-observation cooldown. It records `observed`, `actionable`, `recovering`, `resolved`, `cooldown` or `unsupported`. Batch execution success is not recovery success: a fresh authoritative readback must show greater capacity/headroom or disappearance/reduction of the issue. An unchanged issue produces `no_material_issue_improvement` and cooldown, never a second immediate facility.
