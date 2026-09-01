import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { PushAdapterMap, PushChannel, PushRecordData } from '../../../features/push/index.js';

export interface CreateEveningReviewUseCaseOptions {
  prisma: PrismaClient;
  pushAdapters: PushAdapterMap;
}

export interface SendEveningReviewInput {
  teacherId: string;
  date: Date;
  channel: PushChannel;
}

export interface EveningReviewResult {
  content: string;
  pushRecord: PushRecordData;
}

export interface EveningReviewUseCase {
  sendEveningReview(input: SendEveningReviewInput): Promise<Result<EveningReviewResult, CommonError>>;
}

export type EveningReviewFactory = (options: CreateEveningReviewUseCaseOptions) => EveningReviewUseCase;
