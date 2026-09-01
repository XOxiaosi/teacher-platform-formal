/**
 * s3-mock-server.mjs 类型声明（P11 t2：backend TS 侧测试跨包导入 S3 mock）。
 * 与 packages/ops/lib/testing/s3-mock-server.mjs 实现一一对应。
 */

export interface MockS3Server {
  url: string;
  bucket: string;
  /** 直读内存对象（测试断言用）。 */
  bucketKeys(prefix?: string): string[];
  objectCount(): number;
  close(): Promise<void>;
}

export interface MockS3ServerOptions {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  bucket?: string;
}

export function startMockS3Server(options: MockS3ServerOptions): Promise<MockS3Server>;
