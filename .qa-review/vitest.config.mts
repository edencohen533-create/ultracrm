import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({resolve:{alias:{'@':path.resolve(process.cwd(),'src')}},test:{include:['.qa-review/*.test.ts'],environment:'node',testTimeout:30000,hookTimeout:60000,fileParallelism:false}});
