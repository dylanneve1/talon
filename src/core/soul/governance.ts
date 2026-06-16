/**
 * Soul Kernel — governance (the protected-node approval queue).
 *
 * Most of the soul grows autonomously; that is the point. But some facets are
 * load-bearing enough that drift must never happen silently — the reflexes that
 * the harness enforces, and any change to core identity. The mechanical compiler
 * may *propose* such mutations, but they do not take effect until a human
 * approves them. This is the concrete machinery behind "identity cannot drift
 * behind your back".
 *
 * The queue is pure data (persisted with the kernel). Proposing enqueues a
 * payload + reason; approving returns the payload to the kernel to materialize;
 * rejecting drops it. Nothing here writes to the DAG — the kernel owns that — so
 * the queue stays a simple, auditable ledger.
 */

import { randomUUID } from "node:crypto";
import { hashPayload } from "./hash.js";
import type { NodePayload } from "./types.js";

export type ProposalStatus = "pending" | "approved" | "rejected";

export interface Proposal {
  readonly id: string;
  readonly at: number;
  /** Content hash of the proposed node — stable identity for dedup. */
  readonly target: string;
  readonly payload: NodePayload;
  /** Why the compiler proposed this (templated, never model-written). */
  readonly reason: string;
  status: ProposalStatus;
  resolvedAt?: number;
}

export interface ApprovalSnapshot {
  readonly proposals: readonly Proposal[];
}

export class ApprovalQueue {
  private proposals: Proposal[] = [];

  /**
   * Enqueue a proposed protected mutation. Idempotent on payload content: a
   * pending proposal for the same node is returned rather than duplicated.
   */
  propose(payload: NodePayload, reason: string, at: number): Proposal {
    const target = hashPayload(payload);
    const existing = this.proposals.find(
      (p) => p.target === target && p.status === "pending",
    );
    if (existing) return existing;
    const proposal: Proposal = {
      id: randomUUID(),
      at,
      target,
      payload,
      reason,
      status: "pending",
    };
    this.proposals.push(proposal);
    return proposal;
  }

  pending(): Proposal[] {
    return this.proposals.filter((p) => p.status === "pending");
  }

  get(id: string): Proposal | undefined {
    return this.proposals.find((p) => p.id === id);
  }

  /**
   * Resolve a pending proposal. Returns the payload to apply when approved, or
   * undefined otherwise (rejected, missing, or already resolved).
   */
  resolve(id: string, approved: boolean, at: number): NodePayload | undefined {
    const p = this.proposals.find((x) => x.id === id && x.status === "pending");
    if (!p) return undefined;
    p.status = approved ? "approved" : "rejected";
    p.resolvedAt = at;
    return approved ? p.payload : undefined;
  }

  snapshot(): ApprovalSnapshot {
    return { proposals: this.proposals.map((p) => ({ ...p })) };
  }

  static restore(snap: ApprovalSnapshot): ApprovalQueue {
    const q = new ApprovalQueue();
    q.proposals = snap.proposals.map((p) => ({ ...p }));
    return q;
  }
}
