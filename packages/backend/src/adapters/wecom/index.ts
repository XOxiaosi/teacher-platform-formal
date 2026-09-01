import { createMessageAdapter } from '../shared/index.js';
import type { CreateMessageAdapterOptions } from '../shared/index.js';

export function createWecomAdapter(options: CreateMessageAdapterOptions) {
  return createMessageAdapter(options);
}
