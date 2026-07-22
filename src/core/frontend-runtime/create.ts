/**
 * The typed create seam of the frontend registry.
 *
 * `registry.ts` stores create functions opaquely so routing-only
 * consumers (gateway, backend MCP scoping) never import engine types;
 * this module narrows them back to the `FrontendCreate` contract for
 * the two parties that do care: frontend `factory.ts` modules
 * (attach) and the composition roots (create).
 */

import type {
  Frontend,
  FrontendCreate,
  FrontendFactory,
} from "./capabilities.js";
import { TalonError } from "../errors.js";
import {
  attachOpaqueCreate,
  getOpaqueCreate,
  hasFrontend,
  knownIds,
  registerFrontendDescriptor,
} from "./registry.js";

/**
 * Attach the create function to an already-registered descriptor. Each
 * built-in frontend's `factory.ts` calls this; importing that module is
 * what makes the frontend creatable.
 */
export function attachFrontendCreate(id: string, create: FrontendCreate): void {
  attachOpaqueCreate(id, create);
}

/**
 * Register a complete frontend — descriptor and create together. The
 * one-call path for plugin frontends.
 */
export function registerFrontend(factory: FrontendFactory): void {
  const { create, ...descriptor } = factory;
  registerFrontendDescriptor(descriptor, create);
}

/**
 * Create a frontend instance by id. Throws when the id is unknown or
 * its factory module was never imported — both are wiring bugs worth a
 * loud, early failure.
 */
export async function createFrontendById(
  id: string,
  ...args: Parameters<FrontendCreate>
): Promise<Frontend> {
  if (!hasFrontend(id)) {
    throw new TalonError(`Unknown frontend "${id}" (known: ${knownIds()})`, {
      reason: "bad_request",
    });
  }
  const create = getOpaqueCreate(id) as FrontendCreate | undefined;
  if (!create) {
    throw new TalonError(
      `Frontend "${id}" has no factory attached — is its factory module imported?`,
      { reason: "bad_request" },
    );
  }
  return create(...args);
}
