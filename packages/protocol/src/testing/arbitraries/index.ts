/**
 * @file Public barrel for schema-derived protocol arbitraries used by tests.
 */
export { arbitraryFromSchema } from "./schema-arbitrary.js";
export {
  allRpcMethods,
  arbitraryAnyCall,
  arbitraryCallFor,
  type ArbitraryRpcCall,
} from "./rpc.js";
