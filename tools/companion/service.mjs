import { createPlatform } from './platform.mjs';
import { companionPaths } from './paths.mjs';
import { prepareStandalone } from './standalone.mjs';
const paths=companionPaths(process.env.ODYSSEUS_ROOT);
Object.assign(process.env,paths.env);
if(process.env.ODYSSEUS_COMPANION_STANDALONE==='1')prepareStandalone(paths,{legacyHome:process.env.COMPANION_LEGACY_HOME,previousRoot:process.env.COMPANION_PREVIOUS_ROOT});
const platform=await createPlatform(paths);
process.send?.({ready:true});
process.on('message',async message=>{
  try {const result=await platform.dispatch(message.mode,message.input);process.send?.({id:message.id,result});}
  catch(error){process.send?.({id:message.id,error:String(error.message).slice(0,500)});}
});
let closing;
async function close(){if(closing)return;closing=true;await platform.close();process.exit(0);}
process.on('disconnect',close);process.on('SIGTERM',close);process.on('SIGINT',close);
