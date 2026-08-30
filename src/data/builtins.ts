import { createDataRegistry } from "./catalog.js";
import { airNowHourlyObservationsConnector } from "./connectors/airnow-hourly-observations.js";
import { federalRegisterDocumentsConnector } from "./connectors/federal-register-documents.js";

export const builtInDataRegistry = createDataRegistry([
  airNowHourlyObservationsConnector,
  federalRegisterDocumentsConnector,
]);
