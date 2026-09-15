import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(`${root}/package.json`);
const url = new URL(process.env.DATABASE_URL || '');
if (url.hostname !== '127.0.0.1' || !url.port || ['5432', '55432'].includes(url.port) || process.env.LOCAL_SAFE_MODE !== 'true' || process.env.PLATFORM_SERVICES_ENABLED !== 'false') throw new Error('拒绝非独立本地验收环境。');
const { PrismaClient } = require('@prisma/client');
const { createAuthService } = require(`${root}/packages/backend/dist/features/auth/index.js`);
const { createDatabaseTrustedClock } = require(`${root}/packages/backend/dist/shared/trusted-clock/index.js`);
const { createStudentService } = require(`${root}/packages/backend/dist/features/students/index.js`);
const { createPaymentService } = require(`${root}/packages/backend/dist/features/payments/index.js`);
const prisma = new PrismaClient();
const unwrap = (result) => { if (!result.ok) throw new Error(result.error.code); return result.value; };
try {
  const clock = createDatabaseTrustedClock(prisma); const now = unwrap(await clock.now());
  const auth = createAuthService({ prisma, clock });
  for (const key of ['a', 'b']) {
    const email = `${key}@example.test`;
    if (await prisma.teacherRegistry.findUnique({ where: { email } })) continue;
    const token = randomBytes(32).toString('base64url');
    await prisma.teacherInvitation.create({ data: { email, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAtTs: new Date(now.getTime() + 3600000) } });
    const session = unwrap(await auth.acceptInvitation({ token, password: '12345678', displayName: key === 'a' ? '刘老师' : '验收教师 B' }));
    const teacherId = session.teacher.id;
    await prisma.teacherWorkspacePreference.create({ data: { teacherId, studioName: key === 'a' ? '小思教师工作室' : '教师 B 工作室' } });
    for (const name of key === 'a' ? ['王浩然', '李雨桐', '张思远'] : ['隔离验收学生']) {
      const student = unwrap(await createStudentService(prisma).createStudent({ teacherId, name, grade: '初二', source: '本地合成验收' }));
      unwrap(await createPaymentService(prisma).createPayment({ teacherId, studentId: student.id, clientRequestId: `seed:${student.id}`, amount: 1000, lessonCount: 10, paidAt: now, note: '合成验收登记，无实际付款' }));
    }
  }
  console.log('本地合成验收账号已就绪；已有账号与资料保持不变。');
} finally { await prisma.$disconnect(); }
