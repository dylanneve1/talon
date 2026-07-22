/**
 * Side-effect barrel: attaches the create function for every built-in
 * frontend to its registry descriptor. The composition roots (app.ts,
 * cli/chat.ts) import this once; adding a frontend is strictly
 * additive — drop a `factory.ts` under the new frontend dir and import
 * it here. Factory modules are dependency-light: each one dynamically
 * imports its implementation only when the frontend is actually
 * created.
 */

import "./telegram/factory.js";
import "./discord/factory.js";
import "./teams/factory.js";
import "./native/factory.js";
import "./terminal/factory.js";
