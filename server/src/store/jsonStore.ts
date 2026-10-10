import fs from 'node:fs/promises';
import path from 'node:path';

import { moduleLogger } from '../log/logger.ts';

const log = moduleLogger('store');

/**
 * 原子写文件：写临时文件 → fsync 内容 → rename 覆盖 → （尽力）fsync 目录项。
 *
 * 直接 `writeFileSync` 是「截断 + 写」，中途崩溃/断电/容器 SIGKILL 会留下被截断的文件。
 * 本项目的 config.json 里是账号池，截断后 JSON 解析失败会被当成空配置——密钥无声丢失。
 * rename 在同一文件系统内是原子的，所以要么是完整的旧文件，要么是完整的新文件。
 */
export async function atomicWriteFile(file: string, data: string): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);

  try {
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync(); // 保证内容真正落盘，而不是停在 page cache
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  // 让 rename 本身也落盘。Windows 不允许对目录句柄 fsync，忽略即可。
  try {
    const dirHandle = await fs.open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    /* 平台不支持，跳过 */
  }
}

export interface JsonStoreOptions {
  /** 写盘防抖窗口（毫秒）。高频请求下把多次变更合并成一次写。 */
  debounceMs?: number;
  /** 从首次变脏算起最多延迟多久必须落盘一次，避免持续流量把写盘无限推迟。 */
  maxDelayMs?: number;
  /** 写盘失败时的回调（默认只打日志）。 */
  onError?: (err: unknown) => void;
}

/**
 * 带原子写 + 防抖 + 串行队列的 JSON 文件存储。
 *
 * - 串行队列（promise 链）：写按提交顺序依次落盘，不会两个 rename 交错。
 * - 防抖 + 上限：既合并高频写，又保证持续流量下仍会定期落盘。
 * - 失败不致命：写失败记日志并保留脏标记，下次变更或 flush 时重试。
 */
export class JsonStore<T extends object> {
  readonly file: string;
  #value: T;
  #dirty = false;
  #tail: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #firstDirtyAt = 0;
  #debounceMs: number;
  #maxDelayMs: number;
  #onError: ((err: unknown) => void) | null;
  #closed = false;

  constructor(file: string, initial: T, options: JsonStoreOptions = {}) {
    this.file = file;
    this.#value = initial;
    this.#debounceMs = options.debounceMs ?? 250;
    this.#maxDelayMs = options.maxDelayMs ?? 2000;
    this.#onError = options.onError ?? null;
  }

  /** 直接读当前内存值。写盘是异步的，读永远拿最新。 */
  get value(): T {
    return this.#value;
  }

  /** 就地修改并安排一次写盘。 */
  update(mutate: (value: T) => void): void {
    mutate(this.#value);
    this.markDirty();
  }

  markDirty(): void {
    if (this.#closed) return;
    this.#dirty = true;
    if (!this.#firstDirtyAt) this.#firstDirtyAt = Date.now();

    const waited = Date.now() - this.#firstDirtyAt;
    const delay = Math.max(0, Math.min(this.#debounceMs, this.#maxDelayMs - waited));
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, delay);
    this.#timer.unref?.();
  }

  /**
   * 把当前内存值排进写队列并等待其落盘。
   * 返回值保证：调用时刻的内存值已经写入磁盘（后续变更会排在其后）。
   */
  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#dirty) return this.#tail; // 无待写内容：等在飞的那次即可

    this.#dirty = false;
    this.#firstDirtyAt = 0;
    // 先快照再入队：序列化期间若又有 update，markDirty 会把 dirty 重新置上
    const snapshot = JSON.stringify(this.#value, null, 2);
    const file = this.file;
    const onError = this.#onError;

    const run = async (): Promise<void> => {
      try {
        await atomicWriteFile(file, snapshot);
      } catch (err) {
        this.#dirty = true; // 保留脏标记，下次重试
        this.#firstDirtyAt = this.#firstDirtyAt || Date.now();
        if (onError) onError(err);
        else log.error({ err, file }, '写盘失败');
      }
    };

    this.#tail = this.#tail.then(run, run);
    return this.#tail;
  }

  /** 等待所有已排队的写完成。 */
  async drain(): Promise<void> {
    await this.#tail;
  }

  /** 停止接受新的写请求（优雅退出时先 close 再 flush）。 */
  close(): void {
    this.#closed = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

/** 读 JSON 文件；不存在或损坏都返回 fallback，由调用方决定如何处理损坏。 */
export async function readJsonFile<T>(
  file: string,
): Promise<{ value: T | null; corrupt: boolean; raw: string | null }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { value: null, corrupt: false, raw: null };
    throw err;
  }
  try {
    return { value: JSON.parse(raw) as T, corrupt: false, raw };
  } catch {
    return { value: null, corrupt: true, raw };
  }
}
