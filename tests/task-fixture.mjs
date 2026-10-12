import { taskBase, actor, observation, applyGitHub } from '../dist/dashboard/tasks.js';
export const taskFixtures = (now=Date.now()) => {
  const states=['developing','verifying','awaiting_review','changes_requested','awaiting_merge','completed','unknown','blocked','blocked','ready','queued','review_passed','merging'];
  return states.map((state,i)=>{
    const task=taskBase(`fixture:task:${i+1}`,i%2?'project-beta':'project-alpha','example-org/project-alpha',i+1);
    task.fixture=true;task.workflow='local-fast';task.machine={id:i%2?'fixture-mac':'fixture-windows',name:i%2?'Mac 模拟机器':'Windows 模拟机器',platform:i%2?'macos':'windows'};
    task.executor='Codex 模拟执行器';task.source_head='a'.repeat(40);task.pr={number:i+101,state:null,draft:null,merged_at:null,merge_sha:null};
    task.issue.title=['模拟 · Codex 正在开发','模拟 · Stage 交付','模拟 · 等待 ChatGPT Review','模拟 · REQUEST_CHANGES 同 PR 修复','模拟 · PASS 等待 Watcher','模拟 · QUEUE_COMPLETED','模拟 · GitHub 权限不足','模拟 · HEAD 漂移','模拟 · Watcher 已停止','模拟 · 准备开发','模拟 · 队列等待','模拟 · PASS 等待 checks','模拟 · 正在合并'][i];
    task.state=state;task.updated_at=new Date(now).toISOString();task.observations=[observation('local_fast',now)];
    if(['developing','verifying','merging'].includes(state)){task.active_actor=actor(state==='developing'?'coding_executor':state==='verifying'?'stage':'watcher',state==='developing'?'Codex':state==='verifying'?'AWH Stage':'AWH Watcher');task.waiting_for=null;task.next_action='等待已开始的执行完成';}
    else if(state==='awaiting_review'){task.waiting_for=actor('reviewer','ChatGPT Reviewer');task.next_action='等待 ChatGPT Review';}
    else if(state==='changes_requested'){task.waiting_for=actor('coding_executor','Codex');task.next_action='修复同一 PR 的 Review 意见';}
    else if(['awaiting_merge','review_passed','completed'].includes(state)){
      task.owner_scope={status:'valid',expires_at:new Date(now+86400000).toISOString(),allow_merge:true};task.watcher={status:'WATCHING',running:true,executor_running:false,stale_lock:false};
      const r={id:100+i,state:'APPROVED',commit_id:task.source_head,user:{id:2,login:'fixture-reviewer'}};
      applyGitHub(task,{issue:{number:task.issue.number,title:task.issue.title,state:state==='completed'?'closed':'open'},pr:{...task.pr,draft:state!=='completed',state:state==='completed'?'closed':'open',merged_at:state==='completed'?new Date(now).toISOString():null,merge_commit_sha:state==='completed'?'b'.repeat(40):null,head:{sha:task.source_head,repo:{full_name:task.repository}},base:{repo:{full_name:task.repository}},user:{id:1}},reviews:[r],checks:{status:state==='review_passed'?'pending':'passed',count:1}},now);
    } else if(state==='unknown'){task.waiting_for=actor('owner','Owner');task.next_action='恢复只读权限后重新核验';task.observations.push(observation('github',now,'permission_denied'));}
    else if(state==='blocked'){task.waiting_for=actor('owner','Owner');task.next_action=i===7?'重新核验 HEAD，旧 PASS 无效':'Owner 检查停止的 Watcher';task.blockers=[i===7?'HEAD 漂移，旧 PASS 无效':'Watcher 已停止'];}
    return task;
  });
};
