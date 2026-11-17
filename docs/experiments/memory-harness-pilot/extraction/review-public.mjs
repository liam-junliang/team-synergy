// A second reading of each proposed public excerpt with a different question.
// This is a model agreement experiment, not independent evidence of authorization.
import {readFile, writeFile} from 'node:fs/promises';
const dir=new URL('./',import.meta.url);
const load=async f=>JSON.parse(await readFile(new URL(f,dir),'utf8'));
const corpus=await load('cases.json');
const observations=[];
const labels=['shared_discussion','human_adoption','evidenced_result','personal','transient','unclear'];
const system='评估摘录在这里发挥的作用。对 Agent 在当前工作中执行操作的嘱咐属于 transient。个人习惯或私密信息属于 personal。涉及团队知识的提议或待查问题属于 shared_discussion。只有人类在当前对话中亲自明确采纳项目方案才用 human_adoption。可信外部执行记录有可核实的结果才用 evidenced_result。其他或混合用途选择 unclear。根据完整发言判断引语、否定、条件、时间范围。';
for(const split of ['development','holdout']){
  const result=await load('bound-'+split+'.json');
  for (const sample of result.cases){
    const truth=corpus.find(c=>c.id===sample.id);
    for(const item of sample.items.filter(i=>i.audience==='project')){
      const msg=truth.messages.find(m=>m.id===item.message);
      const res=await fetch('http://127.0.0.1:11434/api/chat',{method:'POST',redirect:'error',signal:AbortSignal.timeout(120000),
        headers:{'content-type':'application/json'},body:JSON.stringify({model:result.model,stream:false,options:{temperature:0,seed:149,num_ctx:4096,num_predict:96},
        format:{type:'object',required:['use'],properties:{use:{enum:labels}}},messages:[{role:'system',content:system},{role:'user',content:JSON.stringify({messages:truth.messages,selected:item.quote,sourceId:item.message})}]})});
      if(!res.ok)throw Error('Local inference HTTP '+res.status);
      const use=JSON.parse((await res.json()).message.content).use;
      const label={idea:'shared_discussion',decision:'human_adoption',implemented:'evidenced_result'}[item.kind];
      const allowed=Boolean(msg?.text.includes(item.quote)) && use===label && (item.kind!=='decision'||msg.role==='human') && (item.kind!=='implemented'||msg.role==='evidence');
      const expected=truth.expect.some(([dest,kind,id,anchor])=>dest==='project'&&kind===item.kind&&id===item.message&&item.quote.includes(anchor))&&!truth.private.some(v=>item.quote.includes(v));
      observations.push({split,id:sample.id,kind:item.kind,use,allowed,expected});
      console.log(sample.id,use,allowed?'eligible':'withheld');
    }
  }
}
const report={model:'hub-qwen2.5:latest',observations,incorrectlyEligible:observations.filter(x=>x.allowed&&!x.expected).length,correctlyEligible:observations.filter(x=>x.allowed&&x.expected).length,legitimateWithheld:observations.filter(x=>!x.allowed&&x.expected).length};
await writeFile(new URL('review-public.json',dir),JSON.stringify(report,null,2)+'\n');
