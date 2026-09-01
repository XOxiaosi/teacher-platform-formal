/**
 * 测试环境字段加密密钥注入（P8 phase-3 加密落位批1 · t10）。
 *
 * 纪律：ENCRYPTION_KEY 不进 .env 提交——测试统一在此注入测试密钥；
 * 生产密钥经 ops/保险库 env 注入（缺省 → 服务层 SAFETY_BLOCK 拒绝明文落库）。
 * 测试密钥仅测试环境使用（与 PROVIDER_KEY_ENCRYPTION_KEY 同模式）。
 */

process.env.ENCRYPTION_KEY = 'b'.repeat(64); // 32 字节 0xBB（hex）
