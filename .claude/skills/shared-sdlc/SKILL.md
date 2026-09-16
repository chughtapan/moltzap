---
name: shared-sdlc
description: Plan, review, or hand off Social Harness and MoltZap work using the shared developer workflow.
---

Read `README.md` in `DOCS_INTERNAL_ROOT` first for the everyday workflow, record
choice, handoff and done criteria. Resolve scope with `.records/config.json`,
then load only its overview and the public contracts relevant to the task.

If the private checkout is unavailable, continue work whose public contract is
sufficient and state which internal context is unverified. Keep one concise work
record, prepare a coherent candidate before changing an ADR, and distinguish
implementation, merge and deployment. Use existing task authorization for routine
work rather than asking for another approval at each step.

For filing, use `workflow/reference/records.md`. For decision review or admission,
use `workflow/reference/provenance.md`: missing binding evidence blocks approval;
require independent review and explicit human approval of the exact decision and
review packet, then verify the landing receipt. Never fabricate human approval.
All these paths are relative to `DOCS_INTERNAL_ROOT`, not the code checkout.

Optional gstack or Google skills can help; their absence does not block this
workflow. Do not add a second review pipeline for routine changes.
