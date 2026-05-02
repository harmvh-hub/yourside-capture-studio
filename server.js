'use strict';
/**
 * YourSide Capture Studio — v2.7
 * Fixes: clip playback, clip list/markers, waveform, clip delete
 * New: export from list, 16:9/9:16 export with crop, recording names
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { DatabaseSync }    = require('node:sqlite');

const VERSION = '2.7';
const PORT           = process.env.PORT           || 3000;
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings');
const EXPORTS_DIR    = process.env.EXPORTS_DIR    || path.join(__dirname, 'exports');
const DATA_DIR       = process.env.DATA_DIR       || path.join(__dirname, 'data');
const PUBLIC_DIR     = path.join(__dirname, 'public');
const DB_PATH        = path.join(DATA_DIR, 'studio.db');

[RECORDINGS_DIR, EXPORTS_DIR, DATA_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, user_id TEXT NOT NULL,
    srt_url TEXT DEFAULT '', srt_mode TEXT DEFAULT 'caller',
    srt_latency TEXT DEFAULT '200', srt_passphrase TEXT DEFAULT '',
    srt_streamid TEXT DEFAULT '', video_bitrate TEXT DEFAULT '4000',
    audio_bitrate TEXT DEFAULT '128', created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
    project_id TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT,
    recording_id TEXT NOT NULL, in_point REAL NOT NULL, out_point REAL NOT NULL,
    export_file TEXT, notes TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO settings VALUES ('storage_hours','4');
  INSERT OR IGNORE INTO settings VALUES ('dropbox_token','');
  INSERT OR IGNORE INTO settings VALUES ('fb_token','');
  INSERT OR IGNORE INTO settings VALUES ('fb_page_id','');
`);

// Migrate: add columns if upgrading
const pcols = db.prepare("PRAGMA table_info(projects)").all().map(c=>c.name);
const pnew  = {srt_url:"TEXT DEFAULT ''",srt_mode:"TEXT DEFAULT 'caller'",srt_latency:"TEXT DEFAULT '200'",srt_passphrase:"TEXT DEFAULT ''",srt_streamid:"TEXT DEFAULT ''",video_bitrate:"TEXT DEFAULT '4000'",audio_bitrate:"TEXT DEFAULT '128'"};
for(const [c,d] of Object.entries(pnew)) if(!pcols.includes(c)) db.exec(`ALTER TABLE projects ADD COLUMN ${c} ${d}`);

if(db.prepare('SELECT COUNT(*) as c FROM users').get().c===0){
  db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (?,?,?,'admin')").run(uuid(),'admin',hashPw('admin'));
  console.log('  ✓ Default admin: admin / admin');
}

// ── Runtime ───────────────────────────────────────────────────────────────────
const sessions = new Map(); // recId -> {proc,hlsDir,mp4File,startTime,projectId,status,hlsReady,lastTimecode}

// ── Helpers ───────────────────────────────────────────────────────────────────
function uuid(){ return crypto.randomUUID(); }
function hashPw(pw){ return crypto.createHash('sha256').update(pw+'yourside_salt_v2').digest('hex'); }
function mime(ext){ return({'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.mp4':'video/mp4','.m3u8':'application/vnd.apple.mpegurl','.ts':'video/mp2t','.ico':'image/x-icon','.png':'image/png','.svg':'image/svg+xml'})[ext]||'application/octet-stream'; }
function jres(res,status,obj){ res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(obj)); }
function parseBody(req){ return new Promise((ok,fail)=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{ok(JSON.parse(d||'{}'));}catch{ok({});} }); req.on('error',fail); }); }
function getCookies(req){ return Object.fromEntries((req.headers.cookie||'').split(';').map(c=>c.trim().split('=').map(s=>{try{return decodeURIComponent(s);}catch{return s;}})).filter(p=>p.length===2)); }
function getUser(req){ const t=getCookies(req).session||(req.headers.authorization||'').replace('Bearer ','').trim(); if(!t)return null; return db.prepare("SELECT s.user_id,s.token,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>datetime('now')").get(t)||null; }
function getSetting(k){ const r=db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r?r.value:''; }
function buildSrtUrl(p){ if(!p.srt_url)return''; const ps=[`mode=${p.srt_mode||'caller'}`,`latency=${p.srt_latency||200}`]; if(p.srt_passphrase)ps.push(`passphrase=${encodeURIComponent(p.srt_passphrase)}`); if(p.srt_streamid)ps.push(`streamid=${encodeURIComponent(p.srt_streamid)}`); return p.srt_url+(p.srt_url.includes('?')?'&':'?')+ps.join('&'); }

function probeDuration(fp){ return new Promise(ok=>{ execFile('ffprobe',['-v','quiet','-print_format','json','-show_format',fp],(err,out)=>{ if(err)return ok(null); try{ok(parseFloat(JSON.parse(out).format.duration)||null);}catch{ok(null);} }); }); }

function probeVideo(fp){ return new Promise(ok=>{ execFile('ffprobe',['-v','quiet','-print_format','json','-show_streams','-select_streams','v:0',fp],(err,out)=>{ if(err)return ok(null); try{ const s=JSON.parse(out).streams[0]; const[fn,fd]=(s.r_frame_rate||'25/1').split('/'); ok({width:s.width,height:s.height,fps:(fd?parseFloat(fn)/parseFloat(fd):parseFloat(fn))||25}); }catch{ok(null);} }); }); }

function probeWaveform(fp,n=200){ return new Promise(ok=>{
  execFile('ffprobe',['-v','quiet','-print_format','json','-show_format',fp],(err,out)=>{
    let dur=60; try{dur=parseFloat(JSON.parse(out).format.duration)||60;}catch{}
    const chunk=Math.max(800,Math.round(dur*8000/n));
    const proc=spawn('ffmpeg',['-i',fp,'-vn','-af',
      `aresample=8000,asetnsamples=n=${chunk}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`,
      '-f','null','-']);
    let buf='';
    proc.stderr.on('data',d=>buf+=d.toString());
    proc.on('close',()=>{
      const vals=[];
      for(const m of buf.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/g)){
        const v=parseFloat(m[1]); vals.push(isFinite(v)?v:-80);
      }
      if(!vals.length)return ok(null);
      const lo=Math.min(...vals),hi=Math.max(...vals),rng=hi-lo||1;
      ok(vals.map(v=>Math.round(((v-lo)/rng)*1000)/1000));
    });
    proc.on('error',()=>ok(null));
  });
});}

function finaliseMp4(hlsDir, mp4File){ return new Promise((ok,fail)=>{
  const m3u8=path.join(hlsDir,'stream.m3u8');
  if(!fs.existsSync(m3u8))return fail(new Error('m3u8 not found'));
  const segs=fs.readFileSync(m3u8,'utf8').split('\n').filter(l=>l.trim()&&!l.startsWith('#')).map(l=>path.join(hlsDir,l.trim()));
  if(!segs.length)return fail(new Error('no segments'));
  const cl=path.join(hlsDir,'concat.txt');
  fs.writeFileSync(cl,segs.map(s=>`file '${s}'`).join('\n'));
  // aresample=async=1:first_pts=0 locks audio to video clock from the very first frame
  // This prevents the base recording from having any A/V offset baked in
  const p=spawn('ffmpeg',[
    '-y','-f','concat','-safe','0','-i',cl,
    '-c:v','libx264','-preset','fast','-crf','22',
    '-c:a','aac','-b:a','128k','-ac','2','-ar','48000',
    '-af','aresample=async=1:first_pts=0',
    '-movflags','+faststart',
    mp4File
  ]);
  p.on('close',c=>c===0?ok():fail(new Error(`ffmpeg exit ${c}`)));
  p.on('error',fail);
});}

function waitHls(hlsDir,ms=15000){ return new Promise((ok,fail)=>{ const t=Date.now(); const chk=()=>{ const m=path.join(hlsDir,'stream.m3u8'); if(fs.existsSync(m)&&fs.readFileSync(m,'utf8').split('\n').filter(l=>l.trim()&&!l.startsWith('#')).length>0)return ok(); if(Date.now()-t>ms)return fail(new Error('HLS timeout')); setTimeout(chk,500); }; chk(); }); }

function enforceStorage(){ const maxMs=parseFloat(getSetting('storage_hours')||'4')*3600000; const prot=new Set(db.prepare('SELECT DISTINCT recording_id FROM clips').all().map(c=>c.recording_id)); const files=fs.existsSync(RECORDINGS_DIR)?fs.readdirSync(RECORDINGS_DIR).filter(f=>f.endsWith('.mp4')).map(f=>({id:f.replace('.mp4',''),fp:path.join(RECORDINGS_DIR,f),age:Date.now()-fs.statSync(path.join(RECORDINGS_DIR,f)).mtimeMs})).sort((a,b)=>b.age-a.age):[]; for(const r of files){ if(r.age<maxMs)break; if(prot.has(r.id))continue; try{ fs.unlinkSync(r.fp); const d=path.join(RECORDINGS_DIR,r.id); if(fs.existsSync(d))fs.rmSync(d,{recursive:true,force:true}); sessions.delete(r.id); db.prepare('DELETE FROM recordings WHERE id=?').run(r.id); }catch(e){} } }
setInterval(enforceStorage,15*60*1000);

// ── HTTP ──────────────────────────────────────────────────────────────────────
const server = http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://localhost:${PORT}`);
  const p=url.pathname;

  if(req.method==='OPTIONS'){ res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE','Access-Control-Allow-Headers':'Content-Type,Authorization'}); return res.end(); }

  // Public
  if(req.method==='GET'&&p==='/api/version') return jres(res,200,{version:VERSION});

  // Static
  if(req.method==='GET'&&!p.startsWith('/api/')&&!p.startsWith('/stream/')&&!p.startsWith('/hls/')&&!p.startsWith('/exports/')){
    let fp=p==='/'?path.join(PUBLIC_DIR,'index.html'):path.join(PUBLIC_DIR,p);
    fp=path.normalize(fp); if(!fp.startsWith(PUBLIC_DIR))return jres(res,403,{error:'Forbidden'});
    if(!fs.existsSync(fp))fp=path.join(PUBLIC_DIR,'index.html');
    res.writeHead(200,{'Content-Type':mime(path.extname(fp))}); return fs.createReadStream(fp).pipe(res);
  }

  // HLS
  if(req.method==='GET'&&p.startsWith('/hls/')){
    const u=getUser(req); if(!u)return jres(res,401,{error:'Unauthorised'});
    const parts=p.replace('/hls/','').split('/'); const id=parts[0],file=parts[1];
    const s=sessions.get(id); if(!s)return jres(res,404,{error:'Session not found'});
    const fp=path.join(s.hlsDir,file); if(!fs.existsSync(fp))return jres(res,404,{error:'Segment not found'});
    res.writeHead(200,{'Content-Type':mime(path.extname(fp)),'Cache-Control':'no-cache','Access-Control-Allow-Origin':'*'});
    return fs.createReadStream(fp).pipe(res);
  }

  // MP4 stream
  if(req.method==='GET'&&p.startsWith('/stream/')){
    const u=getUser(req); if(!u)return jres(res,401,{error:'Unauthorised'});
    const id=path.basename(p); const fp=path.join(RECORDINGS_DIR,`${id}.mp4`);
    if(!fs.existsSync(fp))return jres(res,404,{error:'Not found'});
    const stat=fs.statSync(fp); const range=req.headers.range;
    if(range){ const[s,e]=range.replace(/bytes=/,'').split('-'); const start=parseInt(s,10),end=e?parseInt(e,10):stat.size-1;
      res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Content-Type':'video/mp4','Access-Control-Allow-Origin':'*'});
      return fs.createReadStream(fp,{start,end}).pipe(res); }
    res.writeHead(200,{'Content-Length':stat.size,'Content-Type':'video/mp4','Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*'});
    return fs.createReadStream(fp).pipe(res);
  }

  // Export download
  if(req.method==='GET'&&p.startsWith('/exports/')){
    const u=getUser(req); if(!u)return jres(res,401,{error:'Unauthorised'});
    const fp=path.join(EXPORTS_DIR,path.basename(p)); if(!fs.existsSync(fp))return jres(res,404,{error:'Not found'});
    const stat=fs.statSync(fp);
    res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':stat.size,'Content-Disposition':`attachment; filename="${path.basename(fp)}"`, 'Access-Control-Allow-Origin':'*'});
    return fs.createReadStream(fp).pipe(res);
  }

  // Auth
  if(req.method==='POST'&&p==='/api/auth/login'){
    const{username,password}=await parseBody(req);
    const user=db.prepare('SELECT * FROM users WHERE username=? AND password_hash=?').get(username,hashPw(password||''));
    if(!user)return jres(res,401,{error:'Invalid credentials'});
    const token=crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,datetime('now','+30 days'))").run(token,user.id);
    res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':`session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict`,'Access-Control-Allow-Origin':'*'});
    return res.end(JSON.stringify({token,username:user.username,role:user.role}));
  }
  if(req.method==='POST'&&p==='/api/auth/logout'){
    const t=getCookies(req).session||(req.headers.authorization||'').replace('Bearer ','').trim();
    if(t)db.prepare('DELETE FROM sessions WHERE token=?').run(t);
    res.writeHead(200,{'Set-Cookie':'session=; HttpOnly; Path=/; Max-Age=0','Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true}));
  }
  if(req.method==='GET'&&p==='/api/auth/me'){
    const u=getUser(req); if(!u)return jres(res,401,{error:'Not logged in'}); return jres(res,200,u);
  }
  if(req.method==='POST'&&p==='/api/auth/change-password'){
    const u=getUser(req); if(!u)return jres(res,401,{error:'Unauthorised'});
    const{currentPassword,newPassword}=await parseBody(req);
    if(!currentPassword||!newPassword)return jres(res,400,{error:'Missing fields'});
    if(newPassword.length<4)return jres(res,400,{error:'Min 4 characters'});
    const dbU=db.prepare('SELECT * FROM users WHERE id=? AND password_hash=?').get(u.user_id,hashPw(currentPassword));
    if(!dbU)return jres(res,401,{error:'Current password incorrect'});
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPw(newPassword),u.user_id);
    return jres(res,200,{ok:true});
  }

  // All remaining require auth
  const au=getUser(req); if(!au)return jres(res,401,{error:'Unauthorised'});

  // Users
  if(req.method==='GET'&&p==='/api/users'){ if(au.role!=='admin')return jres(res,403,{error:'Admin only'}); return jres(res,200,{users:db.prepare('SELECT id,username,role,created_at FROM users').all()}); }
  if(req.method==='POST'&&p==='/api/users'){ if(au.role!=='admin')return jres(res,403,{error:'Admin only'}); const{username,password,role}=await parseBody(req); if(!username||!password)return jres(res,400,{error:'Missing fields'}); try{ const id=uuid(); db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (?,?,?,?)").run(id,username,hashPw(password),role||'editor'); return jres(res,200,{id,username,role:role||'editor'}); }catch{ return jres(res,400,{error:'Username exists'}); } }
  if(req.method==='PUT'&&p.startsWith('/api/users/')){ if(au.role!=='admin')return jres(res,403,{error:'Admin only'}); const id=p.replace('/api/users/',''); const{username,password,role}=await parseBody(req); if(password){ if(password.length<4)return jres(res,400,{error:'Min 4 chars'}); if(username){db.prepare('UPDATE users SET username=?,password_hash=?,role=? WHERE id=?').run(username,hashPw(password),role,id);}else{db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPw(password),id);} }else if(username){db.prepare('UPDATE users SET username=?,role=? WHERE id=?').run(username,role,id);} return jres(res,200,{ok:true}); }
  if(req.method==='DELETE'&&p.startsWith('/api/users/')){ if(au.role!=='admin')return jres(res,403,{error:'Admin only'}); const id=p.replace('/api/users/',''); db.prepare('DELETE FROM users WHERE id=?').run(id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); return jres(res,200,{deleted:true}); }

  // Projects
  if(req.method==='GET'&&p==='/api/projects'){ const rows=au.role==='admin'?db.prepare('SELECT p.*,u.username FROM projects p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC').all():db.prepare('SELECT p.*,u.username FROM projects p JOIN users u ON u.id=p.user_id WHERE p.user_id=? ORDER BY p.created_at DESC').all(au.user_id); return jres(res,200,{projects:rows}); }
  if(req.method==='POST'&&p==='/api/projects'){ const b=await parseBody(req); if(!b.name)return jres(res,400,{error:'Name required'}); const id=uuid(); db.prepare('INSERT INTO projects (id,name,description,user_id,srt_url,srt_mode,srt_latency,srt_passphrase,srt_streamid,video_bitrate,audio_bitrate) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,b.name,b.description||'',au.user_id,b.srt_url||'',b.srt_mode||'caller',b.srt_latency||'200',b.srt_passphrase||'',b.srt_streamid||'',b.video_bitrate||'4000',b.audio_bitrate||'128'); return jres(res,200,{id,name:b.name}); }
  if(req.method==='PUT'&&p.startsWith('/api/projects/')){ const id=p.replace('/api/projects/',''); const b=await parseBody(req); db.prepare('UPDATE projects SET name=?,description=?,srt_url=?,srt_mode=?,srt_latency=?,srt_passphrase=?,srt_streamid=?,video_bitrate=?,audio_bitrate=? WHERE id=?').run(b.name,b.description||'',b.srt_url||'',b.srt_mode||'caller',b.srt_latency||'200',b.srt_passphrase||'',b.srt_streamid||'',b.video_bitrate||'4000',b.audio_bitrate||'128',id); return jres(res,200,{ok:true}); }
  if(req.method==='DELETE'&&p.startsWith('/api/projects/')){ db.prepare('DELETE FROM projects WHERE id=?').run(p.replace('/api/projects/','')); return jres(res,200,{deleted:true}); }

  // Recordings (with name support)
  if(req.method==='GET'&&p==='/api/recordings'){
    const mp4s=fs.existsSync(RECORDINGS_DIR)?fs.readdirSync(RECORDINGS_DIR).filter(f=>f.endsWith('.mp4')):[];
    const results=mp4s.map(f=>{ const id=f.replace('.mp4',''),fp=path.join(RECORDINGS_DIR,f),stat=fs.statSync(fp),s=sessions.get(id),rec=db.prepare('SELECT * FROM recordings WHERE id=?').get(id); return{id,name:rec?rec.name:'',size:stat.size,created:stat.birthtime,status:s?s.status:'ready',live:false,projectId:s?s.projectId:null}; });
    for(const[id,s]of sessions.entries()){ if(s.status==='recording'&&!results.find(r=>r.id===id)){ const rec=db.prepare('SELECT * FROM recordings WHERE id=?').get(id); results.push({id,name:rec?rec.name:'',size:0,created:new Date(s.startTime),status:'recording',live:true,projectId:s.projectId}); } }
    return jres(res,200,{recordings:results.sort((a,b)=>new Date(b.created)-new Date(a.created))});
  }
  if(req.method==='PUT'&&p.startsWith('/api/recordings/')){ const id=p.replace('/api/recordings/',''); const{name}=await parseBody(req); db.prepare("INSERT INTO recordings (id,name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name").run(id,name||''); return jres(res,200,{ok:true}); }

  // Clips
  if(req.method==='GET'&&p==='/api/clips'){ const pid=url.searchParams.get('project_id'),rid=url.searchParams.get('recording_id'); let q='SELECT * FROM clips'; const args=[]; if(rid){q+=' WHERE recording_id=?';args.push(rid);}else if(pid){q+=' WHERE project_id=?';args.push(pid);} q+=' ORDER BY created_at DESC'; return jres(res,200,{clips:db.prepare(q).all(...args)}); }
  if(req.method==='POST'&&p==='/api/clips'){ const{name,project_id,recording_id,in_point,out_point,notes}=await parseBody(req); if(!name||!recording_id||in_point==null||out_point==null)return jres(res,400,{error:'Missing fields'}); const id=uuid(); db.prepare('INSERT INTO clips (id,name,project_id,recording_id,in_point,out_point,notes) VALUES (?,?,?,?,?,?,?)').run(id,name,project_id||null,recording_id,in_point,out_point,notes||''); return jres(res,200,{id,name}); }
  if(req.method==='PUT'&&p.startsWith('/api/clips/')){ const id=p.replace('/api/clips/',''); const{name,project_id,in_point,out_point,notes,export_file}=await parseBody(req); db.prepare("UPDATE clips SET name=?,project_id=?,in_point=?,out_point=?,notes=?,export_file=?,updated_at=datetime('now') WHERE id=?").run(name,project_id||null,in_point,out_point,notes||'',export_file||null,id); return jres(res,200,{ok:true}); }
  if(req.method==='DELETE'&&p.startsWith('/api/clips/')){ db.prepare('DELETE FROM clips WHERE id=?').run(p.replace('/api/clips/','')); return jres(res,200,{deleted:true}); }

  // Settings
  if(req.method==='GET'&&p==='/api/settings') return jres(res,200,Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r=>[r.key,r.value])));
  if(req.method==='POST'&&p==='/api/settings'){ if(au.role!=='admin')return jres(res,403,{error:'Admin only'}); const b=await parseBody(req); if(b.storage_hours)b.storage_hours=String(Math.min(8,Math.max(0.5,parseFloat(b.storage_hours)||4))); const stmt=db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"); for(const[k,v]of Object.entries(b))stmt.run(k,String(v)); return jres(res,200,{ok:true}); }

  // Probe
  if(req.method==='GET'&&p.startsWith('/api/probe/')){
    const id=p.replace('/api/probe/',''); const s=sessions.get(id);
    if(s&&s.status==='recording'){ let hlsDur=0; try{ const m=path.join(s.hlsDir,'stream.m3u8'); if(fs.existsSync(m)){for(const x of fs.readFileSync(m,'utf8').matchAll(/#EXTINF:([\d.]+)/g))hlsDur+=parseFloat(x[1]);} }catch{} return jres(res,200,{duration:hlsDur||(Date.now()-s.startTime)/1000,live:true,hlsReady:s.hlsReady||false,timecode:s.lastTimecode||null,width:0,height:0}); }
    const fp=path.join(RECORDINGS_DIR,`${id}.mp4`); if(!fs.existsSync(fp))return jres(res,404,{error:'Not found'});
    const info=await probeVideo(fp);
    return jres(res,200,{duration:await probeDuration(fp),live:false,hlsReady:true,width:info?info.width:1920,height:info?info.height:1080});
  }

  // Waveform
  if(req.method==='GET'&&p.startsWith('/api/waveform/')){
    const id=p.replace('/api/waveform/','');
    const fp=path.join(RECORDINGS_DIR,`${id}.mp4`);
    if(!fs.existsSync(fp))return jres(res,404,{error:'Not found'});
    return jres(res,200,{waveform:(await probeWaveform(fp))||[]});
  }

  // Start recording
  if(req.method==='POST'&&p==='/api/record/start'){
    const{projectId,name}=await parseBody(req); if(!projectId)return jres(res,400,{error:'projectId required'});
    const proj=db.prepare('SELECT * FROM projects WHERE id=?').get(projectId); if(!proj)return jres(res,404,{error:'Project not found'});
    const srtUrl=buildSrtUrl(proj); if(!srtUrl)return jres(res,400,{error:'No SRT URL configured for this project'});
    const id=uuid(); const hlsDir=path.join(RECORDINGS_DIR,id); fs.mkdirSync(hlsDir,{recursive:true});
    // Register recording with name
    db.prepare('INSERT INTO recordings (id,name,project_id) VALUES (?,?,?)').run(id,name||'',projectId);
    const proc=spawn('ffmpeg',['-y','-fflags','+discardcorrupt+genpts','-analyzeduration','10000000','-probesize','10000000','-i',srtUrl,'-sn','-c:v','libx264','-preset','ultrafast','-b:v',`${proj.video_bitrate||4000}k`,'-c:a','aac','-b:a',`${proj.audio_bitrate||128}k`,'-f','hls','-hls_time','2','-hls_list_size','0','-hls_flags','append_list','-hls_segment_filename',path.join(hlsDir,'seg%05d.ts'),path.join(hlsDir,'stream.m3u8')],{stdio:['ignore','pipe','pipe']});
    const mp4File=path.join(RECORDINGS_DIR,`${id}.mp4`);
    sessions.set(id,{proc,hlsDir,mp4File,startTime:Date.now(),projectId,status:'recording',hlsReady:false,lastTimecode:null});
    proc.stderr.on('data',d=>{ const t=d.toString(),s=sessions.get(id); if(!s)return; s.lastLog=t.trim().split('\n').pop(); const tc=t.match(/timecode[=: ]+(\d{2}:\d{2}:\d{2}[;:]\d{2})/i); if(tc)s.lastTimecode=tc[1]; });
    proc.on('error',err=>{ const s=sessions.get(id); if(s){s.status='error';s.error=err.message;} });
    proc.on('close',async code=>{ const s=sessions.get(id); if(!s)return; if(s.status==='stopping'){s.status='finalising'; try{await finaliseMp4(hlsDir,mp4File);s.status='ready';}catch(e){s.status='error';s.error=e.message;} }else{s.status=code===0?'ready':'error';} s.proc=null; });
    try{ await waitHls(hlsDir,30000); const s=sessions.get(id); if(s)s.hlsReady=true; return jres(res,200,{id,status:'recording',hlsUrl:`/hls/${id}/stream.m3u8`,hlsReady:true}); }
    catch(e){ const s=sessions.get(id); if(s){s.status='error';s.error='Stream did not start';} return jres(res,500,{error:'Stream did not start. Check SRT URL and source.'}); }
  }

  // Stop recording
  if(req.method==='POST'&&p.startsWith('/api/record/stop/')){ const id=p.replace('/api/record/stop/',''); const s=sessions.get(id); if(!s||!s.proc)return jres(res,404,{error:'Not found'}); s.status='stopping'; s.proc.kill('SIGTERM'); return jres(res,200,{id,status:'finalising'}); }

  // Rename recording
  if(req.method==='POST'&&p.startsWith('/api/record/rename/')){ const id=p.replace('/api/record/rename/',''); const{name}=await parseBody(req); db.prepare("INSERT INTO recordings (id,name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name").run(id,name||''); return jres(res,200,{ok:true}); }

  // Export
  if(req.method==='POST'&&p==='/api/export'){
    const{id,inPoint,outPoint,clipId,aspectRatio}=await parseBody(req);
    if(!id||inPoint==null||outPoint==null)return jres(res,400,{error:'Missing fields'});
    if(inPoint>=outPoint)return jres(res,400,{error:'inPoint must be < outPoint'});
    const s=sessions.get(id); const duration=outPoint-inPoint;
    const inputFile=(s&&s.status==='recording')
      ? path.join(s.hlsDir,'stream.m3u8')
      : path.join(RECORDINGS_DIR,`${id}.mp4`);
    if(!fs.existsSync(inputFile))return jres(res,404,{error:'Recording not found'});

    const exportId = uuid();
    const exportFile = path.join(EXPORTS_DIR,`clip_${exportId}.mp4`);
    const tmpFile   = path.join(EXPORTS_DIR,`tmp_${exportId}.mp4`);

    // Probe source dimensions for crop calculations
    const even = n => Math.floor(n/2)*2;
    const info = await probeVideo(inputFile) || {width:1920,height:1080};
    const sw = info.width, sh = info.height;

    // Build aspect ratio video filter (applied in pass 2)
    let vf = '';
    if(aspectRatio==='9:16'){
      const cw = even(Math.floor(sh * 9/16));
      const cx = even(Math.floor((sw - cw) / 2));
      vf = `crop=${cw}:${sh}:${cx}:0,scale=1080:1920`;
    } else if(aspectRatio==='1:1'){
      const sq = even(Math.min(sw,sh));
      const cx = even(Math.floor((sw-sq)/2));
      const cy = even(Math.floor((sh-sq)/2));
      vf = `crop=${sq}:${sq}:${cx}:${cy},scale=1080:1080`;
    } else if(aspectRatio==='16:9'){
      vf = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black`;
    }

    const isLiveHls = inputFile.endsWith('.m3u8');
    sessions.set(`export_${exportId}`,{status:'exporting',progress:0,file:exportFile,clipId:clipId||null,proc:null});
    const sess = sessions.get(`export_${exportId}`);

    // ── EXPORT STRATEGY ──────────────────────────────────────────────────────
    //
    // FINISHED MP4 — two-pass:
    //   Pass 1: stream-copy to extract the clip with timestamps reset to 0.
    //           -c copy is reliable from a clean MP4 — no codec delay, no sync gap.
    //           -avoid_negative_ts make_zero ensures both streams start at t=0.
    //   Pass 2: re-encode from the clean temp clip for aspect ratio conversion.
    //           Input is provably synced so no further tricks needed.
    //
    // LIVE HLS — single-pass re-encode:
    //   HLS .ts segments have discontinuous timestamps between segments.
    //   Stream-copy from HLS inherits those discontinuities — don't use it.
    //   Instead: re-encode in one pass with aresample=async=1:first_pts=0
    //   which resamples audio to lock it to the video clock from frame 0.
    // ─────────────────────────────────────────────────────────────────────────

    function trackProgress(proc){
      proc.stderr.on('data',d=>{
        const m=d.toString().match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if(m){ const secs=parseInt(m[1])*3600+parseInt(m[2])*60+parseFloat(m[3]); sess.progress=Math.min(99,Math.round((secs/duration)*100)); }
      });
    }

    function spawnFfmpeg(args){ return new Promise((ok,fail)=>{ const proc=spawn('ffmpeg',args); sess.proc=proc; trackProgress(proc); proc.on('close',code=>code===0?ok():fail(new Error(`ffmpeg exit ${code}`))); proc.on('error',fail); }); }

    const videoFilter = vf ? `${vf},setpts=PTS-STARTPTS` : 'setpts=PTS-STARTPTS';
    const encodeArgs  = ['-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-b:a','192k','-ac','2','-ar','48000','-movflags','+faststart'];

    (async()=>{
      try{
        sess.progress=2;

        if(isLiveHls){
          // ── Single-pass with double-ss for A/V sync ───────────────────────
          // Fast-seek to a preroll point, then output-side accurate seek for
          // the last few seconds. Decoding both streams together from the same
          // segment ensures audio and video are in sync at the clip boundary.
          // Without this, fast-seek alone lets audio/video land on different
          // segment boundaries → audio arrives late in the output.
          const preroll = Math.min(5, inPoint);
          await spawnFfmpeg([
            '-y',
            '-fflags', '+genpts+discardcorrupt',
            '-ss', String(inPoint - preroll),
            '-i', inputFile,
            '-ss', String(preroll),
            '-t', String(duration),
            '-vf', videoFilter,
            '-af', 'aresample=async=1:min_hard_comp=0.1',
            ...encodeArgs,
            exportFile,
          ]);

        } else {
          // ── Two-pass: copy → re-encode ────────────────────────────────────
          // Pass 1: stream-copy extract, timestamps reset cleanly to 0
          await spawnFfmpeg([
            '-y',
            '-ss', String(inPoint),
            '-i', inputFile,
            '-t', String(duration),
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            tmpFile,
          ]);
          sess.progress=50;

          // Pass 2: re-encode from clean temp file
          await spawnFfmpeg([
            '-y',
            '-i', tmpFile,
            '-vf', videoFilter,
            '-af', 'aresample=async=1:first_pts=0',
            ...encodeArgs,
            exportFile,
          ]);
          try{ fs.unlinkSync(tmpFile); }catch{}
        }

        sess.status='done'; sess.progress=100;
        if(clipId) db.prepare("UPDATE clips SET export_file=? WHERE id=?").run(`/exports/clip_${exportId}.mp4`,clipId);

      }catch(e){
        console.error('Export error:',e.message);
        try{ fs.unlinkSync(tmpFile); }catch{}
        sess.status='error'; sess.progress=100;
      }
      sess.proc=null;
    })();

    return jres(res,200,{exportId,status:'exporting'});
  }

  // Export status
  if(req.method==='GET'&&p.startsWith('/api/export/status/')){ const exportId=p.replace('/api/export/status/',''); const s=sessions.get(`export_${exportId}`); if(!s)return jres(res,404,{error:'Not found'}); return jres(res,200,{status:s.status,progress:s.progress,downloadUrl:s.status==='done'?`/exports/clip_${exportId}.mp4`:null}); }

  // Delete recording
  if(req.method==='DELETE'&&p.startsWith('/api/recordings/')){ const id=p.replace('/api/recordings/',''); const s=sessions.get(id); if(s&&s.status==='recording')return jres(res,400,{error:'Stop recording first'}); const used=db.prepare('SELECT COUNT(*) as c FROM clips WHERE recording_id=?').get(id); if(used.c>0)return jres(res,400,{error:`Used by ${used.c} clip(s). Remove clips first.`}); const mp4=path.join(RECORDINGS_DIR,`${id}.mp4`),hd=path.join(RECORDINGS_DIR,id); if(fs.existsSync(mp4))fs.unlinkSync(mp4); if(fs.existsSync(hd))fs.rmSync(hd,{recursive:true,force:true}); db.prepare('DELETE FROM recordings WHERE id=?').run(id); sessions.delete(id); return jres(res,200,{deleted:true}); }

  // Force delete recording (ignores clips — admin only)
  if(req.method==='DELETE'&&p.startsWith('/api/recordings/force/')){
    if(au.role!=='admin')return jres(res,403,{error:'Admin only'});
    const id=p.replace('/api/recordings/force/','');
    const s=sessions.get(id); if(s&&s.status==='recording')return jres(res,400,{error:'Stop recording first'});
    const mp4=path.join(RECORDINGS_DIR,`${id}.mp4`),hd=path.join(RECORDINGS_DIR,id);
    if(fs.existsSync(mp4))fs.unlinkSync(mp4);
    if(fs.existsSync(hd))fs.rmSync(hd,{recursive:true,force:true});
    db.prepare('DELETE FROM recordings WHERE id=?').run(id);
    sessions.delete(id);
    return jres(res,200,{deleted:true});
  }

  // Purge ALL MP4 recordings + HLS dirs (admin only — keeps clips in DB, deletes export files too)
  if(req.method==='POST'&&p==='/api/recordings/purge-all'){
    if(au.role!=='admin')return jres(res,403,{error:'Admin only'});
    const{includeExports}=await parseBody(req);
    // Stop any active recordings first
    for(const[id,s]of sessions.entries()){
      if(s.status==='recording'&&s.proc){ s.status='stopping'; s.proc.kill('SIGTERM'); }
    }
    let deletedRecs=0, deletedExports=0;
    // Delete all MP4 + HLS dirs
    if(fs.existsSync(RECORDINGS_DIR)){
      for(const f of fs.readdirSync(RECORDINGS_DIR)){
        const fp=path.join(RECORDINGS_DIR,f);
        try{ fs.rmSync(fp,{recursive:true,force:true}); deletedRecs++; }catch{}
      }
    }
    sessions.clear();
    db.prepare('DELETE FROM recordings').run();
    // Optionally delete export files
    if(includeExports&&fs.existsSync(EXPORTS_DIR)){
      for(const f of fs.readdirSync(EXPORTS_DIR)){
        try{ fs.unlinkSync(path.join(EXPORTS_DIR,f)); deletedExports++; }catch{}
      }
      db.prepare("UPDATE clips SET export_file=NULL").run();
    }
    return jres(res,200,{deleted:true,deletedRecs,deletedExports});
  }

  // List all recordings with sizes (for admin storage view)
  if(req.method==='GET'&&p==='/api/recordings/storage'){
    if(au.role!=='admin')return jres(res,403,{error:'Admin only'});
    const mp4s=fs.existsSync(RECORDINGS_DIR)?fs.readdirSync(RECORDINGS_DIR).filter(f=>f.endsWith('.mp4')):[];
    let totalBytes=0;
    const items=mp4s.map(f=>{
      const id=f.replace('.mp4',''),fp=path.join(RECORDINGS_DIR,f),stat=fs.statSync(fp);
      const rec=db.prepare('SELECT name FROM recordings WHERE id=?').get(id);
      const clipCount=db.prepare('SELECT COUNT(*) as c FROM clips WHERE recording_id=?').get(id).c;
      const s=sessions.get(id);
      totalBytes+=stat.size;
      return{id,name:rec?rec.name:'',size:stat.size,created:stat.birthtime,clipCount,status:s?s.status:'ready'};
    }).sort((a,b)=>new Date(b.created)-new Date(a.created));
    // Also count exports
    let exportBytes=0;
    if(fs.existsSync(EXPORTS_DIR)){
      for(const f of fs.readdirSync(EXPORTS_DIR)){
        try{exportBytes+=fs.statSync(path.join(EXPORTS_DIR,f)).size;}catch{}
      }
    }
    return jres(res,200,{recordings:items,totalBytes,exportBytes});
  }

  jres(res,404,{error:'Route not found'});
});

server.listen(PORT,()=>{ console.log(`\n🎬 YourSide Capture Studio v${VERSION}  →  http://localhost:${PORT}\n   Login: admin / admin\n`); });
