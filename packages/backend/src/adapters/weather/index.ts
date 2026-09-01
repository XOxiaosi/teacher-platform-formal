import { err, internalError, ok, validationError } from '@teacher-platform/contracts';
import type { CreateWeatherAdapterOptions, WeatherAdapter, WeatherQueryInput } from './types.js';

export function createWeatherAdapter(options: CreateWeatherAdapterOptions): WeatherAdapter {
  return {
    async query(input: WeatherQueryInput) {
      if (!input.city.trim()) return err(validationError('城市不能为空', 'city'));

      try {
        return ok(await options.transport.query(input));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(internalError(`天气查询失败：${message}`));
      }
    },
  };
}

export type {
  CreateWeatherAdapterOptions,
  WeatherAdapter,
  WeatherData,
  WeatherQueryInput,
  WeatherTransport,
} from './types.js';
