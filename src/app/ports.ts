import type { RefineRequestInput, RunModel } from "../request-types.js";
import type { Failure, ModelIdentity, ModelOption, OptimizerDto, Snapshot, Thinking } from "./api.js";

/** Captures a new original using the host's current background and preferences. */
export interface InputPort { capture(text: string, choice?: RunModel): RefineRequestInput }
export interface ModelPort {
  list(): ModelOption[];
  resolve(model?: ModelIdentity, thinking?: Thinking): RunModel | Failure;
  optimizer(): OptimizerDto;
  configure(expectedVersion: number, model: ModelIdentity, thinking: Thinking | "inherit"): OptimizerDto | Failure;
}
export interface StoragePort { summary(): Snapshot["storage"] }
