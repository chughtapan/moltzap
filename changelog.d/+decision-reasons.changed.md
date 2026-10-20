Each row of the daemon MCP tool `firewall_decisions` says which rules decided
its outcome and why: `cause` is one of `judgment`, `uncertain`, `unavailable`,
`code`, `endpoint` or `default`, and `decidedBy` lists the deciding rules as
`{ruleId, advice?}`, where `advice` is the rule's own registered feedback, or
its guidance for an admission. `checkedRuleIds` replaces `ruleIds` and still
lists every rule with a finding in the checked chain. Rows for checks retained
before this release carry the new fields too. Consumers reading `ruleIds` read
`checkedRuleIds` instead.
