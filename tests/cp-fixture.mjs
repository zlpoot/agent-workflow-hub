import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// TEST ONLY: construct the canonical runtime file for an isolated scratch service.
export function runtimeArgs(args) {
  if(args.includes('--runtime-config'))return args;
  const mode=['init','serve'].includes(args[0])?args.shift():'serve';
  const values=new Map();for(let i=0;i<args.length;i+=2)values.set(args[i],args[i+1]);
  if(!values.has('--database')||!values.has('--config'))return [mode,...args];
  const runtime=join(dirname(values.get('--config')),'test-runtime.json');
  writeFileSync(runtime,JSON.stringify({schema_version:'1.0',database:values.get('--database'),trusted_config_file:values.get('--config'),port:Number(values.get('--port')??4310),...(values.has('--https-config')?{https_config_file:values.get('--https-config')}:{})}));
  return [mode,'--runtime-config',runtime];
}
