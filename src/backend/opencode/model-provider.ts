/**
 * OpenCode model provider — adapts the internal catalog to the Backend model
 * interface via the shared remote-server factory. Each export matches a
 * method on `Backend.models`.
 */

import { createRemoteModelProvider } from "../remote-server/model-catalog/index.js";
import {
  getOpenCodeModelCatalog,
  getOpenCodeModelInfo,
  getOpenCodeModelSelectionValue,
  resolveOpenCodeModelInput,
  getOpenCodeSettingsPresentation,
  formatOpenCodeUnavailableModel,
} from "./models/index.js";

const provider = createRemoteModelProvider({
  label: "OpenCode",
  getCatalog: (forceRefresh) => getOpenCodeModelCatalog(forceRefresh),
  getModelInfo: (id) => getOpenCodeModelInfo(id),
  resolveModelInput: (query, catalog) =>
    resolveOpenCodeModelInput(query, catalog),
  getSelectionValue: (model, catalog) =>
    getOpenCodeModelSelectionValue(model, catalog),
  formatUnavailableModel: (model) => formatOpenCodeUnavailableModel(model),
  getSettingsPresentation: (activeModel, callbackPrefix) =>
    getOpenCodeSettingsPresentation(activeModel, callbackPrefix),
});

export const resolveModel = provider.resolveModel;
export const getModelInfo = provider.getModelInfo;
export const getSettingsPresentation = provider.getSettingsPresentation;
export const getProviders = provider.getProviders;
export const getProviderModels = provider.getProviderModels;
export const listModels = provider.listModels;
export const formatModelError = provider.formatModelError;
