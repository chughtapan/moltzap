/**
 * @file Type canary for the executable's final-line contract.
 *
 * `ProfileRunResult` decodes to exactly the `RunSubmission` the submitters
 * produce, so the executable encodes the value it holds without translation and
 * a consumer decoding the line sees the same closed result the submitter saw.
 */

import type { RunSubmission } from "../submit.js";
import type { ProfileRunResult } from "./result.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type FinalLineIsTheSubmission = Expect<Equal<ProfileRunResult, RunSubmission>>;

/** Compile-time assertion for the executable's stdout contract. */
export type ProfileRunResultCanaries = [FinalLineIsTheSubmission];
