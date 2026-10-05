import { ensureHome, homePaths, type Home } from './core/home.js';
import { requireInstall, resolveDataDir, type DataDir, type Install } from './platform/install.js';

export interface GlobalOptions {
  json?: boolean;
  yes?: boolean;
  quiet?: boolean;
  dataDir?: string;
  home?: string;
  /** Set on the copy of the CLI started outside Claude Desktop's process tree. */
  background?: boolean;
}

// Everything is resolved lazily: `list` should not wait for PowerShell, and
// `doctor` must work even when some of it is missing.
export class Context {
  private cachedHome?: Home;
  private cachedData?: DataDir;

  constructor(readonly opts: GlobalOptions) {}

  get home(): Home {
    return (this.cachedHome ??= ensureHome(homePaths(this.opts.home)));
  }

  get data(): DataDir {
    return (this.cachedData ??= resolveDataDir(this.opts.dataDir));
  }

  get dataDir(): string {
    return this.data.dir;
  }

  get install(): Install {
    return requireInstall();
  }
}
