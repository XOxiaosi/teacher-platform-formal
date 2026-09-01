import type { CommonError, Result } from '@teacher-platform/contracts';

export interface WeatherQueryInput {
  city: string;
}

export interface WeatherData {
  city: string;
  weather: string;
  temperatureC: number;
}

export interface WeatherTransport {
  query(input: WeatherQueryInput): Promise<WeatherData>;
}

export interface CreateWeatherAdapterOptions {
  transport: WeatherTransport;
}

export interface WeatherAdapter {
  query(input: WeatherQueryInput): Promise<Result<WeatherData, CommonError>>;
}
