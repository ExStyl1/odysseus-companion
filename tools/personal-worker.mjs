// Long-lived background process: recursive scans never run in Electron's main event loop.
import { join,resolve } from 'node:path';
import { syncProfile } from './profile.mjs';
import { syncPersonal,personalPaths } from './personal-sync.mjs';
import { document } from './personal-store.mjs';
const root=resolve(process.argv[2]);
process.on('message',message=>{
 if(message?.type!=='sync'||!Number.isInteger(message.id))return;
 try{
  const paths=personalPaths(root),beforeModels=JSON.stringify(document(join(paths.desktopHome,'config.json')).llmConnections);
  const shared=syncProfile(root),result=syncPersonal(root,{protectedDesktop:message.protectedDesktop||[],settleMs:message.settleMs??2000});
  const modelsChanged=beforeModels!==JSON.stringify(document(join(paths.desktopHome,'config.json')).llmConnections);
  process.send?.({id:message.id,result,sharedChanges:shared.changes.length,modelsChanged,preferences:document(join(paths.desktopHome,'preferences.json'))});
 }catch(error){process.send?.({id:message.id,error:error instanceof Error?error.message:'Sync failed'});}
});
process.on('disconnect',()=>process.exit());

// Let a synchronous transaction finish and release its locks before a normal shutdown.
process.on('SIGTERM',()=>process.exit());
