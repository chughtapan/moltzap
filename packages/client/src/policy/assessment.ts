/** @file Outcome precedence and projection of explicitly publishable advice. */

import type {
  MessagePolicyAssessment,
  MessagePolicySettings,
  MessagePolicySnapshot,
  PolicyNormGuidance,
  PolicyStage,
  PolicyStageTrace,
} from "./values.js";
import { questionEdition } from "./questions.js";

type Reason = MessagePolicyAssessment["reason"];
type Answered = Extract<PolicyStageTrace, { readonly status: "answered" }>;

const judgments: Readonly<Record<Reason, MessagePolicyAssessment["judgment"]>> =
  {
    eligible: "allow",
    prohibited: "block",
    "unresolved-evidence": "hold",
    "assessment-unavailable": "hold",
    "norm-violation": "revise",
    "approval-required": "hold",
  };
const defaultFeedback: Readonly<
  Record<Reason, MessagePolicyAssessment["feedback"]>
> = {
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
  "assessment-unavailable": [
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

/** Only validated, sufficiently certain expectations can feed conformance. */
export function readNorms(
  trace: PolicyStageTrace,
): readonly PolicyNormGuidance[] {
  if (trace.status !== "answered" || trace.uncertainQuestions.length !== 0) {
    return [];
  }
  return Object.entries(trace.request.questions).flatMap(([id, question]) => {
    const expectation = readExpectation(trace.response.answers[id]?.choice);
    if (question.purpose !== "assessment" || expectation === undefined) {
      return [];
    }
    return [
      {
        ruleId: question.ruleId,
        expectation,
        subjects: readSubjects(trace, question.ruleId),
      },
    ];
  });
}

/**
 * Known prohibition wins over missing checks; norm repair precedes approval.
 * Nothing here publishes a message or interprets peer text as authorization.
 */
export function composeAssessment(
  snapshot: MessagePolicySnapshot,
  settings: MessagePolicySettings,
  trace: readonly PolicyStageTrace[],
  norms: readonly PolicyNormGuidance[],
): MessagePolicyAssessment {
  const { reason, rules } = selectReason(snapshot, trace);
  return {
    binding: snapshot.binding,
    questionEdition,
    policyDigest: snapshot.policy.digest,
    settings,
    trace,
    judgment: judgments[reason],
    reason,
    feedback: ruleFeedback(snapshot, rules, reason),
    guidance: reason === "eligible" ? projectGuidance(snapshot, norms) : [],
  };
}

function selectReason(
  snapshot: MessagePolicySnapshot,
  trace: readonly PolicyStageTrace[],
): {
  readonly reason: Reason;
  readonly rules: readonly string[];
} {
  const prohibited = [
    ...selectedRules(trace, "safety", "prohibited"),
    ...selectedRules(trace, "autonomy", "prohibited"),
  ];
  if (prohibited.length !== 0) {
    return { reason: "prohibited", rules: prohibited };
  }
  if (trace.some((entry) => entry.status === "failed")) {
    return { reason: "assessment-unavailable", rules: [] };
  }
  if (hasUncertainty(snapshot, trace)) {
    return { reason: "unresolved-evidence", rules: uncertainRules(trace) };
  }
  if (trace.some((entry) => entry.status === "unavailable")) {
    return { reason: "assessment-unavailable", rules: [] };
  }
  const violated = selectedRules(trace, "conformance", "violation");
  if (violated.length !== 0) {
    return { reason: "norm-violation", rules: violated };
  }
  return needsApproval(snapshot, trace)
    ? {
        reason: "approval-required",
        rules: selectedRules(trace, "autonomy", "approval-required"),
      }
    : { reason: "eligible", rules: [] };
}

function hasUncertainty(
  snapshot: MessagePolicySnapshot,
  trace: readonly PolicyStageTrace[],
): boolean {
  return (
    snapshot.gaps.length !== 0 ||
    trace.some(
      (entry) =>
        entry.status === "answered" && entry.uncertainQuestions.length !== 0,
    )
  );
}

function needsApproval(
  snapshot: MessagePolicySnapshot,
  trace: readonly PolicyStageTrace[],
): boolean {
  const verified =
    snapshot.authorization.kind === "verified" &&
    snapshot.authorization.binding === snapshot.binding;
  return (
    !verified &&
    selectedRules(trace, "autonomy", "approval-required").length !== 0
  );
}

function projectGuidance(
  snapshot: MessagePolicySnapshot,
  norms: readonly PolicyNormGuidance[],
): readonly PolicyNormGuidance[] {
  return norms.flatMap((norm) => {
    const instruction = snapshot.policy.rules.find(
      (rule) => rule.id === norm.ruleId,
    )?.guidance;
    return instruction === undefined ? [] : [{ ...norm, instruction }];
  });
}

function selectedRules(
  trace: readonly PolicyStageTrace[],
  stage: PolicyStage,
  choice: string,
): readonly string[] {
  return trace.flatMap((entry) => {
    if (entry.stage !== stage || entry.status !== "answered") {
      return [];
    }
    return Object.entries(entry.request.questions).flatMap(([id, question]) =>
      question.purpose === "assessment" &&
      !entry.uncertainQuestions.includes(id) &&
      entry.response.answers[id]?.choice === choice
        ? [question.ruleId]
        : [],
    );
  });
}

function ruleFeedback(
  snapshot: MessagePolicySnapshot,
  selected: readonly string[],
  reason: Reason,
): MessagePolicyAssessment["feedback"] {
  const fallback = defaultFeedback[reason];
  const feedback = snapshot.policy.rules.flatMap((rule) =>
    selected.includes(rule.id) &&
    rule.feedback !== undefined &&
    validNextAction(reason, rule.feedback.nextAction)
      ? [rule.feedback]
      : [],
  );
  return (feedback.length === 0 ? fallback : feedback).map((entry) => ({
    ...entry,
  }));
}

function uncertainRules(trace: readonly PolicyStageTrace[]): readonly string[] {
  return trace.flatMap((entry) =>
    entry.status === "answered"
      ? entry.uncertainQuestions.flatMap((id) => {
          const question = entry.request.questions[id];
          return question === undefined ? [] : [question.ruleId];
        })
      : [],
  );
}

/** A template cannot invite approval of a prohibition or suppress needed repair. */
function validNextAction(
  reason: Reason,
  action: MessagePolicyAssessment["feedback"][number]["nextAction"],
): boolean {
  if (reason === "norm-violation") {
    return action === "revise" || action === "wait" || action === "stop";
  }
  return action === defaultFeedback[reason][0]?.nextAction;
}

function readExpectation(
  choice?: string,
): PolicyNormGuidance["expectation"] | undefined {
  switch (choice) {
    case "required":
    case "permitted":
    case "wait":
    case "none":
      return choice;
    case undefined:
    default:
      return undefined;
  }
}

function readSubjects(trace: Answered, ruleId: string): readonly string[] {
  return Object.entries(trace.request.questions).flatMap(([id, question]) => {
    const selected =
      question.ruleId === ruleId && question.purpose === "subject";
    return selected &&
      question.subject !== undefined &&
      trace.response.answers[id]?.choice === "relevant"
      ? [question.subject]
      : [];
  });
}
