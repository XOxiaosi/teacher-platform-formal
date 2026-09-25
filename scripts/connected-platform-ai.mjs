import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const within = (parent, child) => {
  const part = relative(parent, child);
  return !part || (!part.startsWith('..') && !isAbsolute(part));
};

/** Operator-owned opt-in, outside Git. No key contents or ambient credentials are loaded here. */
export function connectedPlatformAI(directory, projectRoot) {
  const configPath = join(directory, 'platform-ai.json');
  if (!existsSync(configPath)) return {};
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['runtimeRoot', 'apiKeyFile'].includes(key))
    || ![config.runtimeRoot, config.apiKeyFile].every(value => typeof value === 'string' && isAbsolute(value))) {
    throw new Error('平台 AI 配置只接受 DSH 目录与凭据文件的绝对路径。');
  }
  const root = realpathSync(projectRoot);
  const runtimeRoot = realpathSync(config.runtimeRoot);
  const apiKeyFile = realpathSync(config.apiKeyFile);
  if (!statSync(runtimeRoot).isDirectory() || !statSync(apiKeyFile).isFile()
    || within(root, runtimeRoot) || within(root, apiKeyFile) || within(runtimeRoot, apiKeyFile)) {
    throw new Error('DSH 与平台凭据必须位于源码树外，凭据不能存入 DSH 源码。');
  }
  return {
    DSH_RUNTIME_ENABLED: 'true', DSH_RUNTIME_ROOT: runtimeRoot,
    DSH_SESSION_ROOT: join(realpathSync(directory), 'dsh-sessions'),
    DEEPSEEK_API_KEY_FILE: apiKeyFile,
  };
}
