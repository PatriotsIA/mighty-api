import axios from "axios";

const NWS_BASE_URL = "https://api.weather.gov";
const WEATHER_TTL_MS = 5 * 60 * 1000;
const weatherCache = new Map<string, { expiresAt: number; data: CountyWeather }>();

const nws = axios.create({
  baseURL: NWS_BASE_URL,
  timeout: 10_000,
  headers: {
    Accept: "application/geo+json",
    "User-Agent": "(mylocalgop.com, info@mylocalgop.com)",
  },
});

type NwsValue = {
  value?: number | null;
  unitCode?: string;
};

type NwsPointResponse = {
  properties?: {
    forecast?: string;
    observationStations?: string;
    county?: string;
    timeZone?: string;
    relativeLocation?: {
      properties?: {
        city?: string;
        state?: string;
      };
    };
  };
};

type NwsForecastPeriod = {
  number?: number;
  name?: string;
  startTime?: string;
  endTime?: string;
  isDaytime?: boolean;
  temperature?: number;
  temperatureUnit?: string;
  probabilityOfPrecipitation?: NwsValue;
  windSpeed?: string;
  windDirection?: string;
  icon?: string;
  shortForecast?: string;
  detailedForecast?: string;
};

type NwsForecastResponse = {
  properties?: {
    updated?: string;
    generatedAt?: string;
    periods?: NwsForecastPeriod[];
  };
};

type NwsStationsResponse = {
  features?: Array<{
    id?: string;
  }>;
};

type NwsObservationResponse = {
  properties?: {
    timestamp?: string;
    textDescription?: string;
    icon?: string;
    temperature?: NwsValue;
    relativeHumidity?: NwsValue;
    windSpeed?: NwsValue;
    windDirection?: NwsValue;
  };
};

type NwsAlertResponse = {
  features?: Array<{
    id?: string;
    properties?: {
      event?: string;
      headline?: string;
      description?: string;
      instruction?: string | null;
      severity?: string;
      urgency?: string;
      certainty?: string;
      areaDesc?: string;
      onset?: string;
      effective?: string;
      expires?: string;
      ends?: string | null;
      senderName?: string;
    };
  }>;
  updated?: string;
};

export type CountyWeather = {
  location: {
    latitude: number;
    longitude: number;
    city?: string;
    state?: string;
    timeZone?: string;
  };
  current?: {
    observedAt?: string;
    temperature?: number;
    temperatureUnit: "F";
    description?: string;
    icon?: string;
    humidity?: number;
    windSpeed?: number;
    windDirection?: number;
  };
  forecast: Array<{
    number: number;
    name: string;
    startTime?: string;
    endTime?: string;
    isDaytime?: boolean;
    temperature?: number;
    temperatureUnit?: string;
    precipitationChance?: number;
    windSpeed?: string;
    windDirection?: string;
    icon?: string;
    shortForecast?: string;
    detailedForecast?: string;
  }>;
  alerts: Array<{
    id: string;
    event: string;
    headline?: string;
    description?: string;
    instruction?: string;
    severity?: string;
    urgency?: string;
    certainty?: string;
    area?: string;
    onset?: string;
    effective?: string;
    expires?: string;
    ends?: string;
    sender?: string;
  }>;
  updatedAt?: string;
};

function nwsPath(url: string) {
  const parsed = new URL(url);
  if (parsed.origin !== NWS_BASE_URL) {
    throw new Error("NWS response contained an unexpected URL.");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function roundCoordinate(value: number) {
  return Number(value.toFixed(4));
}

function celsiusToFahrenheit(value?: number | null) {
  return typeof value === "number" ? Math.round((value * 9) / 5 + 32) : undefined;
}

function kilometersToMiles(value?: number | null) {
  return typeof value === "number" ? Math.round(value * 0.621371) : undefined;
}

async function fetchObservation(stationsUrl?: string) {
  if (!stationsUrl) return undefined;

  const stations = await nws.get<NwsStationsResponse>(nwsPath(stationsUrl));
  const stationUrl = stations.data.features?.find((station) => station.id)?.id;
  if (!stationUrl) return undefined;

  const observation = await nws.get<NwsObservationResponse>(`${nwsPath(stationUrl)}/observations/latest`);
  return observation.data.properties;
}

export async function getCountyWeather(latitude: number, longitude: number): Promise<CountyWeather> {
  const lat = roundCoordinate(latitude);
  const lon = roundCoordinate(longitude);
  const cacheKey = `${lat},${lon}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const pointResponse = await nws.get<NwsPointResponse>(`/points/${lat},${lon}`);
  const point = pointResponse.data.properties;
  if (!point?.forecast) {
    throw new Error("NWS forecast is unavailable for this location.");
  }

  const countyZone = point.county?.split("/").pop();
  const [forecastResult, alertsResult, observationResult] = await Promise.allSettled([
    nws.get<NwsForecastResponse>(nwsPath(point.forecast)),
    countyZone
      ? nws.get<NwsAlertResponse>(`/alerts/active?zone=${encodeURIComponent(countyZone)}`)
      : nws.get<NwsAlertResponse>(`/alerts/active?point=${lat},${lon}`),
    fetchObservation(point.observationStations),
  ]);

  const forecastProperties = forecastResult.status === "fulfilled" ? forecastResult.value.data.properties : undefined;
  const forecast = (forecastProperties?.periods || []).slice(0, 8).map((period, index) => ({
    number: period.number ?? index + 1,
    name: period.name || `Forecast period ${index + 1}`,
    startTime: period.startTime,
    endTime: period.endTime,
    isDaytime: period.isDaytime,
    temperature: period.temperature,
    temperatureUnit: period.temperatureUnit,
    precipitationChance: period.probabilityOfPrecipitation?.value ?? undefined,
    windSpeed: period.windSpeed,
    windDirection: period.windDirection,
    icon: period.icon,
    shortForecast: period.shortForecast,
    detailedForecast: period.detailedForecast,
  }));

  const alertFeatures = alertsResult.status === "fulfilled" ? alertsResult.value.data.features || [] : [];
  const alerts = alertFeatures.map((feature, index) => {
    const alert = feature.properties || {};
    return {
      id: feature.id || `${cacheKey}-alert-${index}`,
      event: alert.event || "Weather alert",
      headline: alert.headline,
      description: alert.description,
      instruction: alert.instruction || undefined,
      severity: alert.severity,
      urgency: alert.urgency,
      certainty: alert.certainty,
      area: alert.areaDesc,
      onset: alert.onset,
      effective: alert.effective,
      expires: alert.expires,
      ends: alert.ends || undefined,
      sender: alert.senderName,
    };
  });

  const observation = observationResult.status === "fulfilled" ? observationResult.value : undefined;
  const firstPeriod = forecast[0];
  const current = observation
    ? {
        observedAt: observation.timestamp,
        temperature: celsiusToFahrenheit(observation.temperature?.value),
        temperatureUnit: "F" as const,
        description: observation.textDescription || firstPeriod?.shortForecast,
        icon: observation.icon || firstPeriod?.icon,
        humidity: observation.relativeHumidity?.value == null ? undefined : Math.round(observation.relativeHumidity.value),
        windSpeed: kilometersToMiles(observation.windSpeed?.value),
        windDirection: observation.windDirection?.value == null ? undefined : Math.round(observation.windDirection.value),
      }
    : firstPeriod
      ? {
          temperature: firstPeriod.temperature,
          temperatureUnit: "F" as const,
          description: firstPeriod.shortForecast,
          icon: firstPeriod.icon,
        }
      : undefined;

  if (!current && !forecast.length && !alerts.length) {
    throw new Error("NWS weather data is unavailable for this location.");
  }

  const data: CountyWeather = {
    location: {
      latitude: lat,
      longitude: lon,
      city: point.relativeLocation?.properties?.city,
      state: point.relativeLocation?.properties?.state,
      timeZone: point.timeZone,
    },
    current,
    forecast,
    alerts,
    updatedAt: forecastProperties?.updated || forecastProperties?.generatedAt,
  };

  weatherCache.set(cacheKey, { expiresAt: Date.now() + WEATHER_TTL_MS, data });
  return data;
}
