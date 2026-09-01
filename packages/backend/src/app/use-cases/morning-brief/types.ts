import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { WeatherAdapter } from '../../../adapters/weather/index.js';
import type { PushAdapterMap, PushChannel, PushRecordData } from '../../../features/push/index.js';

export interface CreateMorningBriefUseCaseOptions {
  prisma: PrismaClient;
  weather: WeatherAdapter;
  pushAdapters: PushAdapterMap;
}

export interface SendMorningBriefInput {
  teacherId: string;
  date: Date;
  city: string;
  channel: PushChannel;
}

export interface MorningBriefResult {
  content: string;
  pushRecord: PushRecordData;
}

export interface MorningBriefUseCase {
  sendMorningBrief(input: SendMorningBriefInput): Promise<Result<MorningBriefResult, CommonError>>;
}

export type MorningBriefFactory = (options: CreateMorningBriefUseCaseOptions) => MorningBriefUseCase;
