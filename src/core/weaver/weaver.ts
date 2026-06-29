import type { ExecuteParams, ExecuteResult } from "../types.js";
import { log } from "../../util/log.js";
import { Loom } from "./loom.js";

export type WeaverDeps = {
  run: (params: ExecuteParams) => Promise<ExecuteResult>;
};

export class Weaver {
  readonly loom: Loom;
  private readonly deps: WeaverDeps;

  constructor(deps: WeaverDeps, loom = new Loom()) {
    this.deps = deps;
    this.loom = loom;
  }

  runTurn(params: ExecuteParams): Promise<ExecuteResult> {
    return this.loom
      .thread(params.chatId)
      .enqueue(() => this.deps.run(params));
  }
}

let weaver: Weaver | null = null;

export function initWeaver(deps: WeaverDeps): Weaver {
  weaver = new Weaver(deps);
  log("dispatcher", "Weaver initialized");
  return weaver;
}

export function getWeaver(): Weaver {
  if (!weaver) throw new Error("Weaver not initialized");
  return weaver;
}
