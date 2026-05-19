/**
 * Server-side re-export shim — all helpers + capability value-type
 * dependencies now live in `@moltzap/protocol/task/capabilities`.
 */
export {
  assertTmAuthorityMatchesTask,
  assertTaskReadAccessMatchesTask,
  assertConversationInTaskMatches,
} from "@moltzap/protocol/task";
