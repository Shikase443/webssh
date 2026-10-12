import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Destination { id: string; name: string; host: string; port: number; username: string; password?: string }
export interface Data { destinations: Destination[]; hosts: Record<string, string>; scrollback: number }

// Serialize updates, then atomically replace the private JSON file.
export class Store {
  data: Data = { destinations: [], hosts: {}, scrollback: 10000 };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      this.data = JSON.parse(await readFile(path.join(this.directory, 'config.json'), 'utf8'));
      if (!Array.isArray(this.data.destinations) || !this.data.hosts || !Number.isInteger(this.data.scrollback)) throw new Error('Invalid configuration');
      await chmod(path.join(this.directory, 'config.json'), 0o600);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      await this.change(() => {});
    }
  }
  change(edit: (data: Data) => void) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      edit(next);
      const file = path.join(this.directory, 'config.json');
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, file);
      this.data = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  publicDestinations() {
    return this.data.destinations.map(({ password, ...destination }) => ({ ...destination, hasPassword: password !== undefined }));
  }
}

export function destination(body: any): Omit<Destination, 'id'> {
  const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
  if (!text(body.name, 128) || !text(body.host, 253) || !text(body.username, 128)) throw new Error('接続名・ホスト・ユーザー名を確認してください');
  const port = Number(body.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ポートは1〜65535で指定してください');
  return { name: body.name.trim(), host: body.host.trim(), username: body.username.trim(), port };
}
