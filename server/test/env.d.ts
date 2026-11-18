// Pulls in the ambient `cloudflare:test` module declaration.
import '@cloudflare/vitest-pool-workers/types';
import type { Env as WorkerEnv } from '../src/env';
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    // Test bindings from vitest.config.ts layered on top of the Worker bindings.
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_SNAPSHOT_PUBLIC_JWK: string;
    }
  }
}
