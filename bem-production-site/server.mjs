import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startSparkDraw} from './sparkdraw-service.mjs';
export {createSparkDrawService} from './sparkdraw-service.mjs';
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))startSparkDraw().catch(()=>{console.error('SparkDraw startup verification failed; inspect RPC and deployed bindings.');process.exitCode=1;});
