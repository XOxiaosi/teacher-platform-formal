import { randomBytes, scryptSync } from 'node:crypto';

/** Local acceptance only; never reset an existing account or seed production. */
export async function seedLocalInitialAccount(prisma, env = process.env) {
  const url = new URL(env.DATABASE_URL || '');
  if (env.NODE_ENV !== 'development' || env.LOCAL_SAFE_MODE !== 'true'
    || env.PLATFORM_SERVICES_ENABLED !== 'false' || url.hostname !== '127.0.0.1'
    || !url.port || ['5432', '55432'].includes(url.port)) {
    throw new Error('初始验收账号仅允许在独立本地开发数据库创建。');
  }
  const email = '123@example.test';
  if (await prisma.teacherRegistry.findUnique({ where: { email } })) return;
  const salt = randomBytes(16);
  const hash = scryptSync('123', salt, 64);
  await prisma.$transaction(async tx => {
    const teacher = await tx.teacherRegistry.create({ data: {
      email, displayName: '初始教师',
      passwordHash: `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`,
    } });
    await tx.teacherWorkspacePreference.create({ data: { teacherId: teacher.id, studioName: '初始教师工作室' } });
  });
}
