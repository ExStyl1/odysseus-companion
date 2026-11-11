import {readFileSync} from 'node:fs';
import {companionPaths} from './paths.mjs';import {jobQueue} from './job-queue.mjs';
try{const value=readFileSync(0,'utf8');if(value.length>50000)throw Error('Событие слишком большое');const result=jobQueue(companionPaths(process.env.ODYSSEUS_ROOT)).enqueue(JSON.parse(value));console.log(JSON.stringify({id:result.job.id,status:result.job.status,duplicate:result.duplicate}));}catch(e){console.error(e.message);process.exitCode=1;}
