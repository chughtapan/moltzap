/**
 * Server-side re-export shim for `TaskActive` — the tag class, value
 * type, and refine helper now live in
 * `@moltzap/protocol/task/capabilities`. The shim preserves existing
 * `import ... from "../capabilities/task-active.js"` paths.
 */
export {
  TaskActive,
  type TaskActiveValue,
  refineTaskActive,
} from "@moltzap/protocol/task";
