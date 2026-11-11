import { companionPaths } from './paths.mjs';
import { prepareStandalone } from './standalone.mjs';
const p=companionPaths(process.env.ODYSSEUS_ROOT);
const r=prepareStandalone(p,{legacyHome:process.env.COMPANION_LEGACY_HOME,previousRoot:process.env.COMPANION_PREVIOUS_ROOT});
console.log(JSON.stringify({prepared:true,home:r.home}));
