import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = fileURLToPath(new URL('../..', import.meta.url));
const projectRoot = resolve(backendRoot, '../..');

function source(relativePath: string): string {
  const path = resolve(projectRoot, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const targetFiles = [
  'packages/contracts/src/presentation.ts',
  'packages/backend/src/app/presentation/presentation-builder.ts',
  'packages/backend/src/app/presentation/presentation-envelope.ts',
  'packages/backend/src/app/presentation/tool-result-presenters.ts',
  'packages/backend/src/app/presentation/index.ts',
] as const;

const contractsIndex = source('packages/contracts/src/index.ts');
const frontendPackage = source('packages/frontend/package.json');
const agentConverse = source('packages/backend/src/app/use-cases/agent-converse/agent-converse-use-case.ts');
const conversationResponse = source('packages/backend/src/app/routes/conversation-response.ts');
const frontendApi = source('packages/frontend/src/api/conversations.ts');
const frontendPlaceholder = source('packages/frontend/src/app/App.tsx');
const previewHtml = source('packages/frontend/preview.html');
const previewMain = source('packages/frontend/src/preview/main.tsx');
const previewRuntime = source('packages/frontend/src/preview/PreviewApp.tsx');

function presentationBackendSource(): string {
  return targetFiles
    .filter((file) => file.includes('/backend/'))
    .map(source)
    .join('\n');
}

describe('A2 PresentationDocument结构边界', () => {
  it.each(targetFiles)('%s存在', (file) => {
    expect(existsSync(resolve(projectRoot, file))).toBe(true);
  });

  it('contracts从唯一presentation模块导出共享协议', () => {
    expect(contractsIndex).toContain("export * from './presentation.js'");
  });

  it('frontend显式依赖共享contracts而非复制协议', () => {
    const packageJson = JSON.parse(frontendPackage) as { dependencies?: Record<string, string> };
    expect(packageJson.dependencies?.['@teacher-platform/contracts']).toBe('*');
  });

  it('Agent final turn接入builder与版本信封', () => {
    expect(agentConverse).toContain('presentationBuilder');
    expect(agentConverse).toContain('createAssistantPresentationEnvelope');
  });

  it('Conversation响应读取信封并为历史Assistant提供fallback', () => {
    expect(conversationResponse).toContain('readAssistantPresentationEnvelope');
    expect(conversationResponse).toContain('buildFallbackPresentation');
  });

  it('前端Assistant DTO加法接收presentation', () => {
    expect(frontendApi).toMatch(/AssistantTurnDto[\s\S]*presentation\??:\s*PresentationDocument/);
  });

  it('正式认证壳不加载已退役 renderer，认证前不挂载 workspace', () => {
    expect(frontendPlaceholder).toContain('TeacherProvider');
    expect(frontendPlaceholder).toContain('LoginPage');
    expect(frontendPlaceholder).toContain('ConnectedWorkspace');
    expect(frontendPlaceholder).toContain("auth.status === 'anon'");
    expect(frontendPlaceholder).toMatch(/if \(auth\.status === 'anon'\)[\s\S]*?return <LoginPage[\s\S]*?return <ConnectedWorkspace/);
    expect(frontendPlaceholder).not.toMatch(/PresentationDocumentView|TurnList|fetch\s*\(/);
  });

  it('独立 preview 只挂载 PreviewApp，不调用 API 或认证壳', () => {
    expect(previewHtml).toContain('/src/preview/main.tsx');
    expect(previewMain).toContain("import { PreviewApp } from './PreviewApp'");
    expect(previewRuntime).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
    expect(previewRuntime).not.toMatch(/TeacherProvider|useAuth|\.\.\/api\//);
  });

  it('共享协议不携带Web route、actionToken或任意payload字段', () => {
    const protocol = source('packages/contracts/src/presentation.ts');
    expect({
      exists: protocol.length > 0,
      hasDocument: protocol.includes('PresentationDocument'),
      hasForbiddenField: /\b(?:route|actionToken|payload)\??\s*:/.test(protocol),
    }).toEqual({ exists: true, hasDocument: true, hasForbiddenField: false });
  });

  it('presentation应用模块不依赖Prisma、Express、React或微信', () => {
    const applicationSource = presentationBackendSource();
    expect({
      exists: applicationSource.trim().length > 0,
      hasForbiddenDependency: /@prisma|PrismaClient|express|react|wechat/i.test(applicationSource),
    }).toEqual({ exists: true, hasForbiddenDependency: false });
  });
});
