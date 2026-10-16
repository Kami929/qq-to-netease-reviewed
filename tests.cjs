const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const m=require('./migrate.cjs');
const s={position:1,name:'Example',artists:['Singer'],album:'Album',seconds:200,sourceId:'qq1'};
const c={id:'123',name:'Example',artists:['Singer'],album:'Album',seconds:200};
function plan(){const p=m.newPlan([s],1);p.entries[0].status='approved';p.entries[0].selected=c;return p;}
function dir(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'qq2netease-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('伴奏、歌手、时长差异必须提示',()=>{
 assert.equal(m.assess(s,c).length,0);
 assert.ok(m.assess(s,{...c,name:'Example (伴奏)'}).includes('歌名/版本标记不同'));
 assert.ok(m.assess(s,{...c,artists:['Other']}).includes('歌手署名不同'));
 assert.ok(m.assess(s,{...c,seconds:80}).some(x=>x.startsWith('时长差')));
});
test('支持此前导出的中文JSON和QQ复制文本',t=>{
 const d=dir(t);const j=path.join(d,'songs.json');
 fs.writeFileSync(j,JSON.stringify([{歌曲:'歌',歌手:'甲 / 乙',专辑:'专辑',秒数:123}]));
 assert.deepEqual(m.loadSource(j)[0].artists,['甲','乙']);
 const txt=path.join(d,'songs.txt');fs.writeFileSync(txt,'\uFEFF歌曲名：歌，歌手名：甲，专辑名：专辑\n');
 assert.equal(m.loadSource(txt)[0].album,'专辑');
});
test('源数据被修改后拒绝使用旧审核',()=>{const p=plan();p.entries[0].source={...s,name:'Changed'};assert.throws(()=>m.validate(p),/源清单/);});
test('默认apply完全离线，不读取账号、不写入',async()=>{
 const r=await m.applyPlan(plan(),{execute:false,api:()=>assert.fail('不应调用接口')});assert.equal(r.dryRun,true);
});
test('拒绝最终确认不会写入',async t=>{
 let writes=0;const api=async name=>{if(name==='like')writes++;return {ids:[]};};
 await assert.rejects(m.applyPlan(plan(),{api,session:{uid:'1',nickname:'test'},ask:async()=>'',execute:true,dir:dir(t)}),/未确认/);
 assert.equal(writes,0);
});
test('保留已有喜欢、合并相同目标ID并核验新增',async t=>{
 const p=plan();p.entries.push({source:{...s,position:2,sourceId:'qq2'},status:'approved',selected:c,candidates:[]});
 p.count=2;p.expected=2;p.sourceHash=m.newPlan(p.entries.map(x=>x.source),2).sourceHash;
 const liked=new Set(['999']);let writes=0;
 const api=async(name,args)=>{if(name==='like'){assert.equal(args.like,'true');liked.add(args.id);writes++;return {code:200};}return {ids:[...liked]};};
 const r=await m.applyPlan(p,{api,session:{uid:'1',nickname:'test'},ask:async()=>'ADD 1 1',execute:true,dir:dir(t),delay:async()=>{}});
 assert.equal(writes,1);assert.ok(liked.has('999'));assert.equal(r.completed,true);
});
test('服务器已存在则不重复写入，支持断点恢复',async t=>{
 let writes=0;const api=async name=>{if(name==='like')writes++;return {ids:['123','999']};};
 const r=await m.applyPlan(plan(),{api,session:{uid:'1',nickname:'test'},ask:async()=>'ADD 1 0',execute:true,dir:dir(t),delay:async()=>{}});
 assert.equal(writes,0);assert.deepEqual(r.alreadyLiked,['123']);
});
test('写入超时后记录unknown并停止，不盲目重试',async t=>{
 const d=dir(t);let writes=0;
 const api=async name=>{if(name==='like'){writes++;throw Error('timeout');}return {ids:[]};};
 await assert.rejects(m.applyPlan(plan(),{api,session:{uid:'1',nickname:'test'},ask:async()=>'ADD 1 1',execute:true,dir:d,delay:async()=>{}}),/已停止/);
 assert.equal(writes,1);const r=JSON.parse(fs.readFileSync(path.join(d,fs.readdirSync(d)[0],'result.json')));assert.equal(r.items[0].state,'unknown');
});
test('接口返回成功但喜欢列表不包含目标时不能报告成功',async t=>{
 let writes=0;const api=async name=>{if(name==='like'){writes++;return {code:200};}return {ids:[]};};
 await assert.rejects(m.applyPlan(plan(),{api,session:{uid:'1',nickname:'test'},ask:async()=>'ADD 1 1',execute:true,dir:dir(t),delay:async()=>{}}),/已停止/);
 assert.equal(writes,1);
});
test('review选择后只保存计划，不写入收藏',async t=>{
 const p=m.newPlan([s],1);const f=path.join(dir(t),'review.json');
 const api=async name=>{assert.equal(name,'cloudsearch');return {result:{songs:[{id:123,name:'Example',ar:[{name:'Singer'}],al:{name:'Album'},dt:200000}]}};};
 await m.review(p,f,api,async()=>'1');assert.equal(JSON.parse(fs.readFileSync(f)).entries[0].status,'approved');
});
