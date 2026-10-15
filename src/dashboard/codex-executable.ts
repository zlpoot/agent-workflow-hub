import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { externalPath } from '../shared/external-files.js';

/** Bounded metadata inspection only: never execute a discovered candidate or search repositories. */
export function detectCodexExecutable(localData=process.env.LOCALAPPDATA??'',path=process.env.PATH??''):string|null {
  const candidates:string[]=[];
  const installed=join(localData,'OpenAI','Codex','bin');
  if(isAbsolute(localData)&&existsSync(installed))try {
    externalPath(installed);
    for(const item of readdirSync(installed,{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.isSymbolicLink()).slice(0,64))candidates.push(join(installed,item.name,'codex.exe'));
  }catch {/* Detection failure leaves manual selection available. */}
  candidates.push(...path.split(';').filter(x=>isAbsolute(x)).slice(0,64).map(x=>join(x,'codex.exe')));
  const valid=candidates.flatMap(candidate=>{try {
    if(!existsSync(candidate))return [];
    externalPath(candidate);const stat=lstatSync(candidate);
    return stat.isFile()&&realpathSync(candidate).toLowerCase()===candidate.toLowerCase()?[{path:candidate,modified:stat.mtimeMs}]:[];
  }catch{return [];}});
  return valid.sort((a,b)=>b.modified-a.modified)[0]?.path??null;
}
