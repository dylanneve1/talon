/**
 * Claude model discovery — queries the SDK for available models.
 *
 * Split by responsibility:
 *   - `parsing`   — model-identity parsing, display names, alias generation
 *   - `convert`   — SDK ModelInfo → registry ModelInfo[] (variants, fallbacks)
 *   - `discovery` — SDK subprocess probing + registration (registerClaudeModels,
 *                   registerClaudeModelsStatic)
 *   - `static`    — CLAUDE_MODELS_STATIC fallback list
 *
 * Re-exports the same public surface the old single-file module exposed.
 */

export {
  registerClaudeModels,
  registerClaudeModelsStatic,
} from "./discovery.js";
export { CLAUDE_MODELS_STATIC } from "./static.js";
