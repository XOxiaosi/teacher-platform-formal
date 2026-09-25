import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { createCoreRouter } from '../../src/app/routes/core.routes.js';

// T-015 正式装配不应让旧 AI 或媒体/OCR/ASR 入口旁路新捕获链。
const prisma = new PrismaClient();
const app = express();
app.use(express.json());
app.use(createCoreRouter(prisma));

afterAll(async () => { await prisma.$disconnect(); });

describe('T-015 legacy routes are closed by default', () => {
  it('does not expose old /ai/raw-input or /media routes without explicit legacy options', async () => {
    expect((await request(app).post('/ai/raw-input').send({ text: '旧入口' })).status).toBe(404);
    expect((await request(app).post('/media/asset-1/ocr').send({})).status).toBe(404);
    expect((await request(app).post('/media/asset-1/transcription').send({})).status).toBe(404);
  });
});
