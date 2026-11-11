import type { RefineRequestInput } from "../request-types.js";
import type { Failure, ModelIdentity, ModelOption, OptimizerDto, Snapshot, Thinking } from "./api.js";

/** Internal, bounded ports. No editor/UI or client-controlled filesystem paths. */
export interface InputPort { capture(text: string): RefineRequestInput }
export interface ModelPort {
  list(): ModelOption[];
  resolve(model?: ModelIdentity, thinking?: Thinking): { model: ModelIdentity; thinking: Thinking } | Failure;
  optimizer(): OptimizerDto;
  configure(expectedVersion: number, model: ModelIdentity, thinking: Thinking | "inherit"): OptimizerDto | Failure;
}
export interface StoragePort { summary(): Snapshot["storage"] }
