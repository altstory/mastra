import { statfs } from 'node:fs/promises';
import { MastraStorageExporter } from '@mastra/observability';

export class DiskAwareStorageExporter extends MastraStorageExporter {
  private checkAt = 0;
  private paused = false;

  constructor(
    private readonly root: string,
    private readonly reserve: number,
  ) {
    super({ maxBatchWaitMs: 500 });
  }

  private async shouldWrite() {
    if (Date.now() >= this.checkAt) {
      this.checkAt = Date.now() + 10_000;
      const disk = await statfs(this.root).catch(() => undefined);
      if (disk) {
        const paused = disk.bavail * disk.bsize < this.reserve;
        if (paused !== this.paused) {
          console.warn(
            paused
              ? '[altflow backup] Trace capture paused: disk reserve reached'
              : '[altflow backup] Trace capture resumed',
          );
          this.paused = paused;
        }
      }
    }
    return !this.paused;
  }

  override async _exportTracingEvent(event: Parameters<MastraStorageExporter['_exportTracingEvent']>[0]) {
    if (await this.shouldWrite()) await super._exportTracingEvent(event);
  }

  override async onMetricEvent(event: Parameters<MastraStorageExporter['onMetricEvent']>[0]) {
    if (await this.shouldWrite()) await super.onMetricEvent(event);
  }

  override async onLogEvent(event: Parameters<MastraStorageExporter['onLogEvent']>[0]) {
    if (await this.shouldWrite()) await super.onLogEvent(event);
  }
}
