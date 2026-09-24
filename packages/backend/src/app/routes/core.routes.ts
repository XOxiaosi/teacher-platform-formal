import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createCoreRouteDependencies } from '../composition/core-route-dependencies.js';
import type { CoreRouterOptions } from '../composition/types.js';
import { createConversationRouter } from './conversation.routes.js';
import { createTeachingTaskRouter } from './teaching-tasks.routes.js';
import { createPendingActionRouter } from './pending-action.routes.js';
import { createStudentRouter } from './students.routes.js';
import { createScheduleRouter } from './schedules.routes.js';
import { createSchedulingWebRouter } from './scheduling-web.routes.js';
import { createPaymentRouter } from './payments.routes.js';
import { createDailyReviewRouter } from './daily-review.routes.js';
import { createAiInputRouter } from './ai-input.routes.js';
import { createCaptureRouter } from './capture.routes.js';
import { createAgentRouter } from './agent.routes.js';
import { createAgendaRouter } from './agenda.routes.js';
import { createEditRouter } from './edit.routes.js';
import { createFeedbackRouter } from './feedback.routes.js';
import { createStudentRecordsRouter } from './student-records.routes.js';
import { createStudentRecordSourceRouter } from './student-record-source.routes.js';
import { createRequirementRouter } from './requirements.routes.js';
import { createProviderConfigRouter as createProviderConfigRoutes } from './provider-config.routes.js';
import { createUsageRouter } from './usage.routes.js';
import { createMediaRouter } from './media.routes.js';
import { createPrivacyRouter } from './privacy.routes.js';

export type { CoreRouterOptions };

/** 请求级数据库上下文的最小视图（dbRouter 注入；避免直接 import middleware 实现）。 */
interface RoutedDbView {
  db?: { dbName?: string };
}

export function createCoreRouter(prisma: PrismaClient, options?: CoreRouterOptions): Router {
  const router = Router();
  // P8 t20：index.ts 装配线可预构建依赖传入（wechat 等共享同一组合）；缺省内部构建（既有行为）
  const dependencies = options?.dependencies ?? createCoreRouteDependencies(prisma, options);

  if (options?.dbRouter) {
    // 前置数据库路由：解析 teacherId → databaseName → req.db（requireAuth 在前层已保证 teacherId）
    router.use(options.dbRouter);

    // S3：响应完成后释放连接池占用（dbRouter.acquire 递增 activeCount，finish/close 时 release 归零，
    // 否则 activeCount 永不归零、TTL 巡检无法回收客户端——队长预审点）
    if (options.dbPool) {
      router.use((req, res, next) => {
        const routed = req as RoutedDbView;
        const dbName = routed.db?.dbName;
        if (dbName) {
          const release = () => options.dbPool!.release(dbName);
          res.on('finish', release);
          res.on('close', release);
        }
        next();
      });
    }
  }

  if (dependencies.pendingActions) {
    router.use(createPendingActionRouter(dependencies.pendingActions));
  }

  router.use(createAgendaRouter(dependencies.agenda));
  if (dependencies.edits) {
    router.use(createEditRouter(dependencies.edits, {
      legacyPaymentEditEnabled: options?.legacyPaymentEditEnabled === true,
    }));
  }
  router.use(createConversationRouter(
    dependencies.conversations.conversations,
    dependencies.conversations.pendingActions,
  ));
  router.use(createStudentRouter(dependencies.students));
  if (dependencies.teachingTasks) {
    router.use(createTeachingTaskRouter(dependencies.teachingTasks, {
      runtimeWorker: dependencies.teachingRuntimeWorker,
    }));
  }
  router.use(createStudentRecordsRouter(dependencies.studentRecords));
  router.use(createStudentRecordSourceRouter(dependencies.studentRecords));
  router.use(createScheduleRouter(dependencies.schedules));
  router.use(createSchedulingWebRouter(dependencies.schedulingWeb.schedulingWeb));
  if (dependencies.workspaceWeb) router.use(dependencies.workspaceWeb);
  router.use(createPaymentRouter(dependencies.payments));
  router.use(createDailyReviewRouter(dependencies.dailyReview));
  router.use(createCaptureRouter(dependencies.capture));
  if (options?.legacyAiInputRoutesEnabled === true) {
    router.use(createAiInputRouter(dependencies.aiInput));
  }
  if (dependencies.agent) {
    router.use(createAgentRouter(dependencies.agent));
  }
  router.use(createFeedbackRouter(dependencies.feedback));
  router.use(createRequirementRouter(dependencies.requirements));
  // L4 装配（t91）：provider-configs/usage 路由挂载——共享库服务（装配期共享库 prisma），
  // 路由内部 requireAuth 保证 owner 隔离；authService 由 index.ts 经 CoreRouterOptions 注入
  if (dependencies.providerConfig && options?.authService) {
    router.use(createProviderConfigRoutes(dependencies.providerConfig.providerConfigService, options.authService));
  }
  if (dependencies.provider && options?.authService) {
    router.use(createUsageRouter(dependencies.provider.providerUsageService, options.authService));
  }
  // P8 S3 媒体证据链（t8）：上传/下载路由——教师库表（MediaAsset），路由内部 requireAuth
  if (options?.legacyMediaRoutesEnabled === true && dependencies.media && options?.authService) {
    router.use(createMediaRouter(dependencies.media.media, options.authService));
  }
  // P8 隐私自助化（t29）：导出/注销 API——requireAuth + owner 隔离，路由内部 requireAuth
  if (options?.privacy && options.authService) {
    router.use(createPrivacyRouter(options.privacy));
  }

  return router;
}
