/**
 * @file Exact management reply decoders for process acceptance tests.
 * Resolution requires sharness-test; production consumers receive no entry.
 */
export {
  managementReadConversationResultSchema,
  managementRegisterResultSchema,
  managementSearchConversationsResultSchema,
  managementStatusResultSchema,
} from "./harness/protocol/owner-tools.js";
