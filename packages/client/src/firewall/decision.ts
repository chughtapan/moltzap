/** @file Representation-neutral decisions and registered runtime advice. */

import type {
  FirewallCheck,
  MessageContext,
  MessageEvent,
  MessageMiddleware,
  MiddlewareCheck,
  NormGuidance,
  PolicyFinding,
} from "./values.js";

type Reason = FirewallCheck["reason"];

const judgments: Readonly<Record<Reason, FirewallCheck["judgment"]>> = {
  eligible: "allow",
  prohibited: "block",
  "unresolved-evidence": "hold",
  "check-unavailable": "hold",
  "norm-violation": "revise",
  "approval-required": "hold",
};

const defaultFeedback: Readonly<Record<Reason, FirewallCheck["feedback"]>> = {
  eligible: [],
  prohibited: [
    {
      nextAction: "stop",
      text: "This message is prohibited by the owner's policy.",
    },
  ],
  "unresolved-evidence": [
    {
      nextAction: "wait",
      text: "Required policy evidence is missing or uncertain. The message is held for owner review.",
    },
  ],
  "check-unavailable": [
    {
      nextAction: "wait",
      text: "A required policy check is unavailable. The message is held for owner review.",
    },
  ],
  "norm-violation": [
    {
      nextAction: "revise",
      text: "Revise the message to satisfy the owner's communication norms before making a new send attempt.",
    },
  ],
  "approval-required": [
    {
      nextAction: "seek-approval",
      text: "Owner approval is required for this exact message. The message has not been admitted.",
    },
  ],
};

/**
 * A pass cannot erase another policy's findings. Approval satisfies only its
 * own requirement; prohibition, unavailable evidence and norm repair take priority.
 */
export function composeDecision(
  event: MessageEvent,
  context: MessageContext,
  middleware: readonly MessageMiddleware[],
  checks: readonly MiddlewareCheck[],
): FirewallCheck {
  const reason = selectReason(event, context, checks);
  return {
    judgment: judgments[reason],
    reason,
    feedback: projectFeedback(middleware, checks, reason),
    guidance: reason === "eligible" ? projectGuidance(middleware, checks) : [],
    checks,
  };
}

/** Missing applicable advice receives the safe default for the final reason. */
export function projectFeedback(
  middleware: readonly MessageMiddleware[],
  checks: readonly MiddlewareCheck[],
  reason: Reason,
): FirewallCheck["feedback"] {
  const feedback = middleware.flatMap((entry) => {
    const selected =
      checks
        .find((check) => check.middlewareId === entry.id)
        ?.findings.filter((finding) => matchesReason(finding, reason))
        .map((finding) => finding.ruleId) ?? [];
    return entry.rules.flatMap((rule) =>
      selected.includes(rule.id) &&
      rule.feedback !== undefined &&
      validNextAction(reason, rule.feedback.nextAction)
        ? [{ ...rule.feedback }]
        : [],
    );
  });
  return feedback.length === 0
    ? defaultFeedback[reason].map((entry) => ({ ...entry }))
    : feedback;
}

function selectReason(
  event: MessageEvent,
  context: MessageContext,
  checks: readonly MiddlewareCheck[],
): Reason {
  const findings = checks.flatMap((check) => check.findings);
  if (findings.some((finding) => finding.outcome === "block")) {
    return "prohibited";
  }
  if (unavailableCheck(checks, findings)) {
    return "check-unavailable";
  }
  if (unresolvedCheck(context, checks, findings)) {
    return "unresolved-evidence";
  }
  if (findings.some((finding) => finding.outcome === "revise")) {
    return "norm-violation";
  }
  if (
    findings.some((finding) => finding.outcome === "approval-required") &&
    !hasApproval(event, context)
  ) {
    return "approval-required";
  }
  return "eligible";
}

function unavailableCheck(
  checks: readonly MiddlewareCheck[],
  findings: readonly PolicyFinding[],
): boolean {
  return (
    checks.some((check) => check.status === "unavailable") ||
    findings.some(
      (finding) =>
        finding.outcome === "hold" && finding.reason === "check-unavailable",
    )
  );
}

function unresolvedCheck(
  context: MessageContext,
  checks: readonly MiddlewareCheck[],
  findings: readonly PolicyFinding[],
): boolean {
  return (
    context.gaps.length !== 0 ||
    findings.some((finding) => finding.outcome === "hold") ||
    conflictingExpectations(checks)
  );
}

function hasApproval(event: MessageEvent, context: MessageContext): boolean {
  const approval = context.authorization;
  if (
    approval.kind !== "verified" ||
    approval.principal !== context.principal
  ) {
    return false;
  }
  const candidate = approval.candidate;
  const message = event.message;
  const sameRecipients =
    candidate.recipients.length === message.recipients.length &&
    candidate.recipients.every(
      (recipient, index) => recipient === message.recipients[index],
    );
  return (
    sameRecipients &&
    candidate.id === message.id &&
    candidate.text === message.text &&
    candidate.sender === message.sender
  );
}

/** Unscoped opposing expectations are unresolved, never a last-writer override. */
function conflictingExpectations(checks: readonly MiddlewareCheck[]): boolean {
  const expectations = checks.flatMap((check) => check.expectations);
  return expectations.some(
    (left) =>
      left.expectation === "required" &&
      expectations.some(
        (right) =>
          right.expectation === "wait" &&
          (left.subjects.length === 0 ||
            right.subjects.length === 0 ||
            left.subjects.some((subject) => right.subjects.includes(subject))),
      ),
  );
}

function matchesReason(finding: PolicyFinding, reason: Reason): boolean {
  const findingReasons = {
    pass: "eligible",
    "not-applicable": "eligible",
    block: "prohibited",
    revise: "norm-violation",
    "approval-required": "approval-required",
  } satisfies Record<Exclude<PolicyFinding["outcome"], "hold">, Reason>;
  if (reason === "eligible") {
    return false;
  }
  return finding.outcome === "hold"
    ? finding.reason === reason
    : findingReasons[finding.outcome] === reason;
}

function projectGuidance(
  middleware: readonly MessageMiddleware[],
  checks: readonly MiddlewareCheck[],
): readonly NormGuidance[] {
  return checks.flatMap((check) => {
    const entry = middleware.find(
      (candidate) => candidate.id === check.middlewareId,
    );
    return check.expectations.flatMap((norm) => {
      const instruction = entry?.rules.find(
        (rule) => rule.id === norm.ruleId,
      )?.guidance;
      return instruction === undefined
        ? []
        : [
            {
              ruleId: norm.ruleId,
              expectation: norm.expectation,
              subjects: [...norm.subjects],
              middlewareId: check.middlewareId,
              instruction,
            },
          ];
    });
  });
}

/** A template cannot invite approval of a prohibition or suppress needed repair. */
function validNextAction(
  reason: Reason,
  action: FirewallCheck["feedback"][number]["nextAction"],
): boolean {
  return reason === "norm-violation"
    ? action === "revise" || action === "wait" || action === "stop"
    : action === defaultFeedback[reason][0]?.nextAction;
}
