import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/**
 * 后台任务共享模块（P8 隐私自助化 t29 从 admin-jobs 提取；admin 引用同步）。
 *
 * - 内存 job 表：Map<jobId, {status: pending|running|succeeded|failed, result?, error?, owner?}>——
 *   与 pending-action「提交→轮询」同心智；重启即清（阶段一可接受）。
 * - runSpawnJob：spawn ops 脚本（npm -w @teacher-platform/ops ...），
 *   shell:false 直接执行（消除 DEP0190 命令注入面，参数不经 shell 解释）；
 *   Windows 下 npm 是 .cmd 批处理，spawn 直接调会 EINVAL——解析为显式可执行路径
 *   node <npm-cli.js>（与 npm.cmd shim 内部执行等价），见 resolveSpawnCommand。
 *   stdout 尾行 JSON 汇总解析为 result；非零退出 → failed + stderr 尾；超时强杀 → failed。
 * - owner 隔离：create(kind, owner?) 记录归属者；隐私自助化（导出/注销）轮询/下载前校验 owner，
 *   防止跨教师探测他人任务。
 * - 惰性 sweep：创建 job 时清理超龄（>1h）记录，防内存增长。
 */

export type BackgroundJobKind = string;
export type BackgroundJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface BackgroundJob {
  jobId: string;
  kind: BackgroundJobKind;
  status: BackgroundJobStatus;
  /** 任务归属者（teacherId/admin actor；无归属者=系统级任务）。隐私任务必须 owner 隔离。 */
  owner?: string;
  result?: unknown;
  error?: string;
  createdAt: number; // performance.now()（单调时钟，非业务时间）
}

export interface BackgroundJobStore {
  create(kind: BackgroundJobKind, owner?: string): string;
  get(jobId: string): BackgroundJob | undefined;
  markRunning(jobId: string): void;
  markSucceeded(jobId: string, result: unknown): void;
  markFailed(jobId: string, error: string): void;
}

const JOB_TTL_MS = 60 * 60 * 1000;

export interface CreateJobStoreOptions {
  /** jobId 前缀（默认 job_；admin 沿用 adminjob_ 保持既有契约/测试断言不变）。 */
  jobIdPrefix?: string;
}

export function createJobStore(options: CreateJobStoreOptions = {}): BackgroundJobStore {
  const jobIdPrefix = options.jobIdPrefix ?? 'job_';
  const jobs = new Map<string, BackgroundJob>();

  function sweep(): void {
    const now = performance.now();
    for (const [jobId, job] of jobs) {
      if (now - job.createdAt > JOB_TTL_MS) jobs.delete(jobId);
    }
  }

  return {
    create(kind, owner) {
      sweep();
      const jobId = `${jobIdPrefix}${randomBytes(8).toString('hex')}`;
      jobs.set(jobId, { jobId, kind, status: 'pending', createdAt: performance.now(), ...(owner ? { owner } : {}) });
      return jobId;
    },

    get(jobId) {
      return jobs.get(jobId);
    },

    markRunning(jobId) {
      const job = jobs.get(jobId);
      if (job) job.status = 'running';
    },

    markSucceeded(jobId, result) {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'succeeded';
        job.result = result;
      }
    },

    markFailed(jobId, error) {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'failed';
        job.error = error;
      }
    },
  };
}

export interface SpawnJobOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 超时（ms），默认 5 分钟；超时强杀 → failed */
  timeoutMs?: number;
}

/** 解析结果：可直接 spawn 的（command, args）对。 */
export interface ResolvedSpawnCommand {
  command: string;
  args: string[];
}

/**
 * Windows 下 npm/npx 是 .cmd 批处理（shell:false 直接 spawn 会 EINVAL——libuv 不执行批处理），
 * 且 shell:true 已被 Node 24 DEP0190 弃用（参数不转义直接拼接，命令注入面）。
 * 解析为显式可执行路径：`node <npm-cli.js>`——与 npm.cmd shim 内部执行（node npm-cli.js %*）完全等价，
 * 参数经 argv 直传，不经任何 shell 解释（跨平台同形：Linux 上 npm 本身可直接 spawn，无需解析）。
 */
export function resolveSpawnCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): ResolvedSpawnCommand {
  if (platform !== 'win32' || (command !== 'npm' && command !== 'npx')) {
    return { command, args };
  }
  const npmCliJs = resolveNpmCliJs(env, execPath);
  if (npmCliJs) {
    return { command: execPath, args: [npmCliJs, ...args] };
  }
  // 兜底：找不到 npm-cli.js 时退回 npm.cmd（极端环境仍可能 EINVAL，由 spawn error 事件兜底标记 failed）
  return { command: 'npm.cmd', args };
}

/** 定位 npm-cli.js：优先 npm 自身执行环境（npm_execpath），再 PATH 上 npm.cmd 同级 node_modules/npm/bin/npm-cli.js。 */
export function resolveNpmCliJs(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string | undefined {
  const candidates: string[] = [];

  // 1) npm 自身运行环境：npm run dev/start 时 npm_execpath 指向正在使用的 npm-cli.js
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && /npm-cli\.(js|cjs|mjs)$/i.test(npmExecPath) && existsSync(npmExecPath)) {
    candidates.push(npmExecPath);
  }

  // 2) PATH 上 npm.cmd 的同级 node_modules/npm/bin/npm-cli.js（标准 Windows npm 安装布局，
  //    与 npm.cmd shim 的 %~dp0\node_modules\npm\bin\npm-cli.js 一致）
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const npmCmd = join(dir, 'npm.cmd');
    if (!existsSync(npmCmd)) continue;
    const cli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(cli)) candidates.push(cli);
    break; // 第一个含 npm.cmd 的 PATH 目录即权威（与 shell 的 where/which 解析一致）
  }

  // 3) node 同目录 bundled npm（标准安装布局：node 与 npm.cmd 同目录）
  const bundled = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundled)) candidates.push(bundled);

  return candidates[0];
}

/** 运行后台任务：markRunning → spawn → 成功解析尾行 JSON 汇总 / 失败记 stderr 尾。不抛错。 */
export function runSpawnJob(store: BackgroundJobStore, jobId: string, options: SpawnJobOptions): Promise<void> {
  return new Promise((resolveDone) => {
    store.markRunning(jobId);
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    // shell:false——参数经 argv 直传，不经 shell 解释（消 DEP0190 注入面）；
    // Windows 下 command 先经 resolveSpawnCommand 解析为 node <npm-cli.js>。
    const resolved = resolveSpawnCommand(options.command, options.args);
    let child: ReturnType<typeof spawn>;
    try {
      // Windows 上 .cmd 直接 spawn 会同步抛 EINVAL（非 error 事件）——统一 try/catch 兜底
      child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      store.markFailed(jobId, `后台任务启动失败：${error instanceof Error ? error.message : String(error)}`);
      resolveDone();
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      store.markFailed(jobId, `后台任务超时（>${timeoutMs}ms）`);
      resolveDone();
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      store.markFailed(jobId, `后台任务启动失败：${error.message}`);
      resolveDone();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        // 解析 stdout 尾行 JSON 汇总（ops 脚本输出 {tool:..., ...} 一行）
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        let result: unknown = { stdoutTail: lines.slice(-2) };
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          try {
            result = JSON.parse(lines[i]);
            break;
          } catch {
            // 非 JSON 行（进度输出）跳过
          }
        }
        store.markSucceeded(jobId, result);
      } else {
        const outTail = stdout.trim().split(/\r?\n/).slice(-10).join(' | ');
        const errTail = stderr.trim().split(/\r?\n/).slice(-20).join(' | ');
        store.markFailed(jobId, `后台任务退出码 ${code ?? 'unknown'}${errTail ? `：stderr: ${errTail}` : ''}${outTail ? ` | stdout: ${outTail}` : ''}`);
      }
      resolveDone();
    });
  });
}
