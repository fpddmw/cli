import { createDataRegistry } from "./catalog.js";
import { airNowHourlyObservationsConnector } from "./connectors/airnow-hourly-observations.js";
import { federalRegisterDocumentsConnector } from "./connectors/federal-register-documents.js";
import { gdeltDocSearchConnector } from "./connectors/gdelt-doc-search.js";
import {
  gdeltEventsConnector,
  gdeltGkgConnector,
  gdeltMentionsConnector,
} from "./connectors/gdelt-file-feeds.js";
import { nasaFirmsFireConnector } from "./connectors/nasa-firms-fire.js";
import { openMeteoAirQualityConnector } from "./connectors/open-meteo-air-quality.js";
import { openMeteoFloodConnector } from "./connectors/open-meteo-flood.js";
import { openMeteoHistoricalWeatherConnector } from "./connectors/open-meteo-historical-weather.js";
import { openAqAirQualityConnector } from "./connectors/openaq-air-quality.js";
import { regulationsGovCommentsConnector } from "./connectors/regulations-gov-comments.js";
import { usgsWaterInstantaneousValuesConnector } from "./connectors/usgs-water-instantaneous-values.js";

export const builtInDataRegistry = createDataRegistry([
  airNowHourlyObservationsConnector,
  federalRegisterDocumentsConnector,
  gdeltDocSearchConnector,
  gdeltEventsConnector,
  gdeltGkgConnector,
  gdeltMentionsConnector,
  nasaFirmsFireConnector,
  openMeteoAirQualityConnector,
  openMeteoFloodConnector,
  openMeteoHistoricalWeatherConnector,
  openAqAirQualityConnector,
  regulationsGovCommentsConnector,
  usgsWaterInstantaneousValuesConnector,
]);
