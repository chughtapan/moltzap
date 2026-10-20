**Breaking:** Each row of the daemon MCP tool `firewall_decisions` says which
rules decided its outcome and why. `cause` is one of `judgment`, `uncertain`,
`unavailable`, `code`, `endpoint` or `default`. `decidedBy` lists the deciding
rules as `{ruleId, from, advice?}`: `from` is `code`, `fixed` or `editable`, as
`policy_read` lists the rule, and `advice` is the rule's own registered
feedback, or its guidance for an admission. `checkedRuleIds` replaces `ruleIds`
and still lists every rule with a finding in the checked chain. Consumers
reading `ruleIds` read `checkedRuleIds` instead. Installing English rules now
records the fixed rule ids in the English middleware's provenance, so a row
keeps its rules' origin after later edits, and the active revision of an
installation with English rules changes once. Rows for checks retained before
this release carry the new fields too, with every English rule reported as
`editable`.
