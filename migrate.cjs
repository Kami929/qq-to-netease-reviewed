#!/usr/bin/env node
'use strict';
// Original implementation; workflow inspired by alex3236/ToQQMusic.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
function save(p, data) {
  fs.mkdirSync(path.dirname(path.resolve(p)), {recursive:true});
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
function norm(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, ''); }
function artists(x) { return Array.isArray(x) ? x.map(v => typeof v === 'string' ? v : v.name) : String(x || '').split(/\s+\/\s+|,|，/); }
function sourceSong(x, i) {
  const name = x.歌曲 || x.title || x.name || x.songname;
  if (!name) throw Error(`第 ${i + 1} 条缺少歌名`);
  return {position:i+1, name, artists:artists(x.歌手 || x.singer || x.artists),
    album:x.专辑 || x.album?.name || x.albumname || '',
    seconds:Number(x.秒数 ?? x.interval ?? x.seconds ?? 0),
    sourceId:String(x.id || x.mid || x.QQ链接 || i+1)};
}
function loadSource(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (file.toLowerCase().endsWith('.json')) {
    const j = JSON.parse(raw);
    const rows = Array.isArray(j) ? j : j.songs || j.req_0?.data?.songlist || j.songlist;
    if (!Array.isArray(rows) || !rows.length) throw Error('JSON中没有歌曲列表');
    return rows.map(sourceSong);
  }
  const lines = raw.split(/\r?\n/).filter(x => x.trim());
  return lines.map((line, i) => {
    const qq = /^歌曲名：(.+?)，歌手名：(.+?)，专辑名：(.*)$/.exec(line.trim());
    if (qq) return sourceSong({name:qq[1],artists:qq[2],album:{name:qq[3]}}, i);
    const at = line.lastIndexOf(' - ');
    if (at < 1) throw Error(`第 ${i+1} 行格式应为：歌曲名 - 歌手`);
    return sourceSong({name:line.slice(0,at), artists:line.slice(at+3)},i);
  });
}
function candidate(x) {
  return {id:String(x.id), name:x.name, artists:artists(x.ar || x.artists),
    album:(x.al || x.album || {}).name || '', seconds:Math.round((x.dt ?? x.duration ?? 0)/1000)};
}
function assess(s,c) {
  const flags=[];
  if(norm(s.name)!==norm(c.name)) flags.push('歌名/版本标记不同');
  const sa=s.artists.map(norm).filter(Boolean).sort(), ca=c.artists.map(norm).filter(Boolean).sort();
  if(!sa.length || JSON.stringify(sa)!==JSON.stringify(ca)) flags.push('歌手署名不同');
  if(!s.seconds || !c.seconds) flags.push('缺少时长');
  else if(Math.abs(s.seconds-c.seconds)>3) flags.push(`时长差${Math.abs(s.seconds-c.seconds)}秒`);
  if(!s.album || !c.album || norm(s.album)!==norm(c.album)) flags.push('专辑不同或缺失');
  return flags;
}
function describe(s) { return `${s.name} — ${s.artists.join(' / ')} | ${s.album} | ${s.seconds || '?'}秒`; }
function newPlan(songs, expected) {
  return {schema:1, created:new Date().toISOString(), expected:Number(expected)||songs.length,
    count:songs.length, sourceHash:crypto.createHash('sha256').update(JSON.stringify(songs)).digest('hex'),
    entries:songs.map(source=>({source,status:'pending',candidates:[],selected:null}))};
}
function validate(plan) {
  if(plan.schema!==1 || !Array.isArray(plan.entries) || plan.count!==plan.entries.length) throw Error('审核文件格式/数量错误');
  const hash=crypto.createHash('sha256').update(JSON.stringify(plan.entries.map(x=>x.source))).digest('hex');
  if(hash!==plan.sourceHash) throw Error('源清单发生变化，请重新生成审核文件');
  for(const e of plan.entries) {
    if(!['pending','approved','skipped'].includes(e.status)) throw Error('无效审核状态');
    if(e.status==='approved' && (!e.selected || !/^\d+$/.test(String(e.selected.id)))) throw Error('已确认条目缺少有效歌曲ID');
  }
}
function report(plan,file) {
  const lines=['# QQ → 网易云审核报告','',`源清单：${plan.count} 条；预期：${plan.expected} 条。`,
    plan.count!==plan.expected?'注意：源清单数量不一致，尚不能声称全量迁移。':'',
    '这里只表示人工选择状态，不表示已经加入喜欢。',''];
  for(const e of plan.entries) {
    lines.push(`## ${e.source.position}. ${e.source.name}`,`原曲：${describe(e.source)}`,`状态：${e.status}`);
    if(e.selected) lines.push(`选择：${describe(e.selected)}（ID ${e.selected.id}）`, `差异：${assess(e.source,e.selected).join('；')||'元数据一致'}`);
    lines.push('');
  }
  fs.writeFileSync(file,lines.join('\n'),'utf8');
}
function makeApi() {
  let mod;
  try { mod=require('@neteasecloudmusicapienhanced/api'); }
  catch { throw Error('缺少联网组件，请先按README安装依赖。离线 prepare/report/test 不需要安装。'); }
  return async (name,params={}) => {
    if(typeof mod[name]!=='function') throw Error(`联网组件缺少接口 ${name}`);
    let result;
    try { result=await mod[name]({...params,timestamp:Date.now()}); }
    catch { throw Error(`${name} 请求失败（网络、登录或平台限制）；未记录凭据。`); }
    const body=result.body || result;
    if(name!=='login_qr_check' && body.code!==undefined && Number(body.code)!==200) throw Error(`${name} 返回状态 ${body.code}`);
    return body;
  };
}
async function login(api,ask,dir) {
  console.log('使用网易云手机App扫码登录本次会话；登录Cookie仅保存在内存。');
  const k=await api('login_qr_key'); const key=k.data?.unikey;
  if(!key) throw Error('二维码key响应异常');
  const r=await api('login_qr_create',{key,qrimg:true});
  const data=r.data?.qrimg;
  if(!/^data:image\/png;base64,/.test(data||'')) throw Error('二维码图片响应异常');
  const imagePath=path.resolve(dir,'login-qr.png');
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(imagePath,Buffer.from(data.split(',')[1],'base64'));
  console.log(`请打开图片并用网易云音乐扫码：\n${imagePath}`);
  await ask('在手机确认登录后按回车（或Ctrl+C退出）：');
  for(let i=0;i<60;i++) {
    const c=await api('login_qr_check',{key});
    if(Number(c.code)===800) throw Error('二维码已过期，请重新运行');
    if(Number(c.code)===803 && c.cookie) {
      const status=await api('login_status',{cookie:c.cookie});
      const p=status.data?.profile;
      if(!p?.userId) throw Error('登录成功但无法确认账号，停止');
      return {cookie:c.cookie,uid:String(p.userId),nickname:p.nickname};
    }
    if(![801,802].includes(Number(c.code))) throw Error('扫码响应异常，请重新运行');
    await sleep(2000);
  }
  throw Error('登录确认超时');
}
async function getLikes(api,session) {
  const r=await api('likelist',{uid:session.uid,cookie:session.cookie});
  if(!Array.isArray(r.ids)) throw Error('喜欢列表读取失败，不能安全去重');
  return new Set(r.ids.map(String));
}
async function review(plan,file,api,ask,revisit=false) {
  validate(plan);
  for(const e of plan.entries) {
    if(!revisit && e.status!=='pending') continue;
    console.log(`\n[${e.source.position}/${plan.count}] ${describe(e.source)}`);
    let query=e.source.name+' '+e.source.artists.join(' ');
    let cached=e.candidates.length>0;
    while(true) {
      if(!cached) {
        const r=await api('cloudsearch',{keywords:query,type:1,limit:15});
        if(!r.result || (!Array.isArray(r.result.songs) && Number(r.result.songCount)!==0)) throw Error('搜索响应异常，保留当前断点');
        e.candidates=(r.result.songs||[]).map(candidate);
        e.query=query;save(file,plan);await sleep(400);
      }
      e.candidates.forEach((c,i)=>console.log(`${i+1}. ${describe(c)}\n   ${assess(e.source,c).join('；')||'元数据一致（仍需确认）'}`));
      const answer=(await ask('选择序号；s跳过；r重新输入关键词；q保存退出：')).trim();
      if(answer==='q') {save(file,plan);return;}
      if(answer==='s') {e.status='skipped';e.selected=null;save(file,plan);break;}
      if(answer==='r') {query=(await ask('搜索关键词：')).trim();if(!query) continue;cached=false;continue;}
      const index=Number(answer)-1;
      if(!/^\d+$/.test(answer)||!e.candidates[index]) {cached=true;continue;}
      e.selected=e.candidates[index];e.status='approved';save(file,plan);break;
    }
  }
}
async function applyPlan(plan,{api,session,ask,execute=false,dir,delay=sleep}) {
  validate(plan);
  const selected=[...new Map(plan.entries.filter(e=>e.status==='approved').map(e=>[String(e.selected.id),e.selected])).values()];
  if(!execute) {console.log(`预演：人工确认${selected.length}首不同歌曲；未调用写入接口。需 --execute 才能执行。`);return {dryRun:true};}
  if(!selected.length) throw Error('没有已人工确认的歌曲');
  const before=await getLikes(api,session);
  const pending=selected.filter(s=>!before.has(s.id));
  console.log(`目标账号：${session.nickname}（UID ${session.uid}）；原有喜欢${before.size}首；待新增${pending.length}首。`);
  if(plan.count!==plan.expected) console.log(`源列表仅${plan.count}/${plan.expected}条，这次是部分迁移。`);
  // Confirm identity and exact selected set before any write.
  if((await ask(`输入 ADD ${session.uid} ${pending.length} 确认加入喜欢：`)).trim()!==`ADD ${session.uid} ${pending.length}`) throw Error('未确认，未写入');
  const runDir=path.join(dir,`run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(runDir,{recursive:true});
  save(path.join(runDir,'before.json'),{uid:session.uid,ids:[...before],created:new Date().toISOString()});
  const result={uid:session.uid,sourceHash:plan.sourceHash,alreadyLiked:selected.filter(s=>before.has(s.id)).map(s=>s.id),items:[]};
  const resultPath=path.join(runDir,'result.json');save(resultPath,result);
  // Reverse original order since new likes are usually prepended; the service can change order.
  for(const song of [...pending].reverse()) {
    const entry={id:song.id,name:song.name,state:'attempting'};result.items.push(entry);save(resultPath,result);
    try {
      await api('like',{id:song.id,like:'true',cookie:session.cookie});
      let verified=false;
      for(let i=0;i<3;i++) {await delay(1200);if((await getLikes(api,session)).has(song.id)){verified=true;break;}}
      if(!verified) throw Error('服务器未能确认红心状态');
      entry.state='verified';save(resultPath,result);console.log(`已核实：${song.name}`);
    } catch {
      entry.state='unknown';save(resultPath,result);
      throw Error(`写入或核验未完成，已停止。请重跑 apply 从服务器状态恢复。记录：${resultPath}`);
    }
  }
  const after=await getLikes(api,session);
  result.finalMissing=selected.filter(s=>!after.has(s.id)).map(s=>s.id);
  result.completed=result.finalMissing.length===0;save(resultPath,result);
  if(!result.completed) throw Error(`最终复核仍有缺项，请查看 ${resultPath}`);
  console.log(`完成并复核：${pending.length}首新增，${result.alreadyLiked.length}首原已喜欢。记录：${resultPath}`);
  return result;
}
async function fetchQQ(value,expected,file) {
  let id=String(value);
  if(!/^\d+$/.test(id)) {
    let u=new URL(value);
    if(u.protocol!=='https:' || !['y.qq.com','c6.y.qq.com'].includes(u.hostname)) throw Error('仅支持QQ官方HTTPS歌单链接或数字ID');
    for(let i=0;i<8;i++) {
      const r=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(20000)});
      if(r.status>=300&&r.status<400) {
        const next=new URL(r.headers.get('location'),u);
        if(next.protocol!=='https:'||!['y.qq.com','c6.y.qq.com'].includes(next.hostname)) throw Error('短链接转到非QQ地址，停止');
        u=next;continue;
      }
      break;
    }
    id=/\/playlist\/(\d+)/.exec(u.pathname)?.[1] || u.searchParams.get('id');
    if(!/^\d+$/.test(id||'')) throw Error('未识别歌单ID，请使用网页歌单链接');
  }
  const songs=[],filtered=[];let total=null;
  for(let page=0;page<100;page++) {
    const payload={comm:{ct:24,cv:0},req_0:{module:'music.srfDissInfo.DissInfo',method:'CgiGetDiss',param:{disstid:Number(id),dirid:0,tag:false,song_begin:page*100,song_num:100,userinfo:false,orderlist:true,onlysonglist:false}}};
    const r=await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg',{method:'POST',headers:{'Content-Type':'application/json',Referer:'https://y.qq.com/'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
    if(!r.ok) throw Error(`QQ请求失败：HTTP ${r.status}`);
    const j=await r.json(), d=j.req_0?.data;
    if(j.code!==0||j.req_0?.code!==0||!d||d.code!==0||!Array.isArray(d.songlist)) throw Error('QQ歌单不可读取：可能私密或接口发生变化');
    if(total!==null&&total!==d.total_song_num) throw Error('读取期间歌单数量变化，请稍后重试');
    total=d.total_song_num;songs.push(...d.songlist);filtered.push(...(d.filtered_song||[]));
    if(!d.hasmore) break;
    if(!d.songlist.length||page===99) throw Error('分页未完成，未生成完整计划');
    await sleep(400);
  }
  if(!songs.length) throw Error('未返回歌曲，不能创建空迁移计划');
  const plan=newPlan(songs.map(sourceSong),expected||total);
  plan.qq={playlistId:id,reportedTotal:total,filtered:[...new Map(filtered.map(x=>[x.songid,x])).values()]};
  save(file,plan);report(plan,file+'.md');
  console.log(`已读取${songs.length}首；QQ报告${total}首；预期${plan.expected}首。过滤记录${plan.qq.filtered.length}条。未写入网易云。`);
}
async function main(argv=process.argv.slice(2)) {
  const cmd=argv[0]; const opt=k=>{const i=argv.indexOf('--'+k);return i<0?undefined:argv[i+1];};
  const planFile=opt('plan')||'review.json';
  if(cmd==='prepare') {
    if(!opt('source')) throw Error('需要 --source 文件路径');
    if(fs.existsSync(planFile)) throw Error('审核文件已存在；请使用新的 --plan 文件名，避免覆盖进度');
    const plan=newPlan(loadSource(opt('source')),opt('expected'));save(planFile,plan);report(plan,planFile+'.md');
    console.log(`已准备 ${plan.count}/${plan.expected} 条。下一步：node migrate.cjs review --plan "${planFile}"`);return;
  }
  if(cmd==='fetch-qq') {
    if(!opt('url')) throw Error('需要 --url QQ分享链接或ID');
    if(fs.existsSync(planFile)) throw Error('审核文件已存在，请改用新的 --plan 文件名');
    return fetchQQ(opt('url'),opt('expected'),planFile);
  }
  if(!['review','report','apply'].includes(cmd)) {
    console.log('QQ → 网易云（先审核后写入）\nprepare --source 清单.json [--expected 100] [--plan review.json]\nfetch-qq --url QQ链接或ID [--expected 100]\nreview [--plan review.json] [--revisit]\nreport [--plan review.json]\napply [--plan review.json]              仅预演\napply [--plan review.json] --execute    扫码、确认账号后写入喜欢\n离线测试：node --test tests.cjs');return;
  }
  const plan=read(planFile);validate(plan);
  if(cmd==='report') {report(plan,planFile+'.md');console.log(planFile+'.md');return;}
  if(cmd==='apply'&&!argv.includes('--execute')) return applyPlan(plan,{execute:false});
  const api=makeApi();const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  const ask=q=>rl.question(q);const dir=path.resolve(path.dirname(planFile),'migration-records');
  try {
    if(cmd==='review') {await review(plan,planFile,api,ask,argv.includes('--revisit'));report(plan,planFile+'.md');}
    else {const session=await login(api,ask,dir);await applyPlan(plan,{api,session,ask,execute:true,dir});}
  } finally {rl.close();}
}
module.exports={loadSource,sourceSong,candidate,assess,newPlan,validate,review,applyPlan,save};
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
