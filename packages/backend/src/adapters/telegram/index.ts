import { createMessageAdapter } from '../shared/index.js';
import type { CreateMessageAdapterOptions } from '../shared/index.js';

export function createTelegramAdapter(options: CreateMessageAdapterOptions) {
  return createMessageAdapter(options);
}
