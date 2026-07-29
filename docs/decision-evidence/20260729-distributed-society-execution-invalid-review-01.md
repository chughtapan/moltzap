# Invalid blind decision review — distributed society execution

This record preserves a procedurally invalid blind-review attempt. Its
substantive findings were neither returned to the author nor used by the valid
rerun. This file is a quarantined input for future blind reviews.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `dse-cold-20260729-01-invalid` |
| Candidate commit | `772e05efd824324e8d13e567bb384548725da966` |
| Candidate tree | `9963222e9ae2679cbf5879e2356fd2dc055b7679` |
| Candidate content digest | SHA-256 `1a301aa99a99de696a6892ee09d8b795f23cff6dd5bfeacc654ecc26eb72213a` |
| Digest scope and command | Git archive of the candidate commit: `git archive --format=tar 772e05efd824324e8d13e567bb384548725da966 \| shasum -a 256` |
| Reviewer | Codex fresh reviewer |
| Reviewer session | `/root/blind_adr_review` |
| Review dispatched | `2026-07-29T21:53:17Z` |
| Review invalidated | Before `2026-07-29T22:01:23Z`; the reviewer did not report an exact timestamp |
| Review duration | Not reported |
| Review budget | One uninterrupted fresh-agent turn, maximum 45 minutes |
| Superseded by review run | `dse-cold-20260729-02` |
| Superseded candidate commit | `772e05efd824324e8d13e567bb384548725da966` |
| Superseded candidate content digest | SHA-256 `1a301aa99a99de696a6892ee09d8b795f23cff6dd5bfeacc654ecc26eb72213a` |

## Reviewer invalidation — verbatim

> Isolation issue discovered: this reviewer context includes the outer user
> AGENTS/environment turn (including repository-law file pointers), so I cannot
> truthfully attest that I received only the candidate root plus fixed questions
> or had no inherited conversation/file pointers. I have not read any
> quarantined review artifact and the substantive candidate review is complete,
> but under the strict blind-review rule this run should be treated as
> invalid/FAIL and replaced with a fork_turns="none" fresh reviewer.

## Author interventions

The author provided no design hint, answer, or clarification. After the reviewer
declared the run invalid, the author interrupted the session and did not request
or receive its substantive findings.

## Overall result

Result: **INVALID**

The first prompt required an absolute claim that no file pointer of any kind was
present. The execution environment automatically supplied repository governance
and environment metadata, making that literal attestation impossible. The
replacement run distinguished unavoidable platform governance from prohibited
candidate-specific briefing, instructed the reviewer not to use injected paths
as discovery hints, and used a different fresh session against the unchanged
candidate.

