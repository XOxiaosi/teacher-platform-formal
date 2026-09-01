import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient } from '@prisma/client';

/**
 * 请求级数据库上下文：把「当前请求路由到的教师库 client」传播给装配期创建的服务。
 *
 * 设计依据：reports/architecture/p7-db-routing-design.md §3.2 路径 A
 * （服务工厂从装配期注入 client 平移到请求期 getClient 解析）。
 *
 * 机制：AsyncLocalStorage —— databaseRouter 用 runWithRequestDb 包裹 next()，
 * 服务工厂的 getClient 读取当前请求上下文；无上下文（databaseRouter 未挂载）
 * 时回退装配期 client，保持单库行为与既有测试一致。
 */

export interface RequestDbContext {
  client: PrismaClient;
  dbName: string;
}

const requestDbStorage = new AsyncLocalStorage<RequestDbContext>();

/** 在请求级数据库上下文中运行 fn（databaseRouter 调用）。 */
export function runWithRequestDb<T>(context: RequestDbContext, fn: () => T): T {
  return requestDbStorage.run(context, fn);
}

/** 读取当前请求的数据库上下文（无则 undefined）。 */
export function getRequestDb(): RequestDbContext | undefined {
  return requestDbStorage.getStore();
}

/** client 提供器：请求期解析，未配置时回退装配期 client。 */
export interface ClientProvider {
  getClient(): Promise<PrismaClient>;
}

/** 创建 client 提供器：优先返回当前请求路由到的 client，否则回退 fallbackClient。 */
export function createClientProvider(fallbackClient: PrismaClient): ClientProvider {
  return {
    async getClient() {
      const store = getRequestDb();
      return store?.client ?? fallbackClient;
    },
  };
}
