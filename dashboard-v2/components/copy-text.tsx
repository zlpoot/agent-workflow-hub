import { useState } from 'react';
import { Button } from './ui/button';
export function CopyText({label,text}:{label:string;text:string}) {
  const [message,setMessage]=useState('');
  const copy=async()=>{try{await navigator.clipboard.writeText(text);setMessage('已复制');}catch{setMessage('复制失败，请选中文本复制。');}};
  return <div className="project-stack"><textarea aria-label={label} readOnly rows={8} value={text} onFocus={e=>e.currentTarget.select()}/><div className="flex gap-2"><Button variant="outline" onClick={()=>void copy()}>复制{label}</Button><span role="status">{message}</span></div></div>;
}
