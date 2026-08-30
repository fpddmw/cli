import { createDataRegistry } from "./catalog.js";
import { airNowHourlyObservationsConnector } from "./connectors/airnow-hourly-observations.js";
import { federalRegisterDocumentsConnector } from "./connectors/federal-register-documents.js";
import { openMeteoAirQualityConnector } from "./connectors/open-meteo-air-quality.js";
import { openMeteoFloodConnector } from "./connectors/open-meteo-flood.js";
import { openMeteoHistoricalWeatherConnector } from "./connectors/open-meteo-historical-weather.js";
import { usgsWaterInstantaneousValuesConnector } from "./connectors/usgs-water-instantaneous-values.js";

export const builtInDataRegistry = createDataRegistry([
  airNowHourlyObservationsConnector,
  federalRegisterDocumentsConnector,
  openMeteoAirQualityConnector,
  openMeteoFloodConnector,
  openMeteoHistoricalWeatherConnector,
  usgsWaterInstantaneousValuesConnector,
]);
