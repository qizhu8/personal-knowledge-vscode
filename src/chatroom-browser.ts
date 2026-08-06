// ── Browser view (served by the hub over HTTP) ────────────────────────────────
// A single self-contained page: enter room + name + shared secret, then watch and
// participate in the room over WebSocket. File downloads are not offered here —
// files relay peer-to-peer between online VS Code clients only.
export function browserViewHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PKM Agent Room</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#1e1e1e;color:#ddd;height:100vh;display:flex;flex-direction:column}
  header{padding:10px 14px;background:#252526;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  header input{background:#3c3c3c;border:1px solid #444;border-radius:4px;color:#eee;padding:5px 8px;font-size:13px}
  header button{background:#0e639c;border:none;border-radius:4px;color:#fff;padding:5px 12px;cursor:pointer;font-size:13px}
  header button:hover{background:#1177bb}
  #dot{width:9px;height:9px;border-radius:50%;background:#888}
  #dot.on{background:#4ade80}#dot.err{background:#f87171}
  #wrap{flex:1;display:flex;min-height:0}
  #log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
  #side{width:180px;border-left:1px solid #333;background:#252526;padding:12px;overflow-y:auto}
  .sys{align-self:center;color:#888;font-style:italic;font-size:12px}
  .msg{max-width:80%;background:#2d2d30;border:1px solid #3a3a3a;border-radius:10px;padding:6px 10px;font-size:14px}
  .msg.agent{border-left:3px solid #a78bfa}
  .who{font-size:11px;font-weight:600;color:#4ea1ff;margin-bottom:2px}
  .who .t{color:#888;font-weight:400;margin-left:6px}
  .body{white-space:pre-wrap;word-break:break-word;line-height:1.4}
  .mem{display:flex;align-items:center;gap:6px;font-size:13px;padding:3px 0}
  .mem.gone{opacity:.5}
  .mem.muted{color:#888;font-style:italic}
  .mem .sid{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#888;background:#333;border-radius:4px;padding:0 4px;margin-left:2px}
  .mem .ago{color:#888;font-size:11px;margin-left:auto}
  .mdot{width:7px;height:7px;border-radius:50%;background:#4ade80}.mdot.agent{background:#a78bfa}.mdot.gone{background:#666}
  #composer{display:flex;gap:8px;padding:10px;border-top:1px solid #333;background:#252526}
  #composer textarea{flex:1;resize:none;background:#3c3c3c;border:1px solid #444;border-radius:6px;color:#eee;padding:6px 8px;font-size:14px;font-family:inherit}
  #composer button{background:#0e639c;border:none;border-radius:6px;color:#fff;padding:0 16px;cursor:pointer}
  #attach{padding:0 12px}
  .filerow{align-self:flex-start}
  .dl{display:inline-block;color:#4ea1ff;text-decoration:none;background:#2d2d30;border:1px solid #3a3a3a;border-radius:8px;padding:5px 10px;font-size:13px}
  .dl:hover{border-color:#4ea1ff}
  .hint{color:#888;font-size:12px;padding:6px 14px}
  h4{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#888}
</style></head><body>
<header>
  <span id="dot"></span>
  <span id="roomlabel" style="display:none;font-weight:600;color:#4ea1ff"></span>
  <input id="name" placeholder="your name" style="width:130px">
  <input id="secret" type="password" placeholder="room secret" style="width:150px">
  <button id="go" onclick="toggleConn()">Join</button>
  <span id="status" style="color:#888;font-size:12px"></span>
</header>
<div class="hint" id="hint">Enter a display name and this room's secret to watch or participate. Files shared in the room are peer-to-peer and not shown here.</div>
<div id="wrap">
  <div id="log"></div>
  <div id="side"><h4>In the room</h4><div id="members"></div></div>
</div>
<div id="composer" style="display:none">
  <input type="file" id="file" style="display:none" onchange="if(this.files[0])sendFile(this.files[0])">
  <button id="attach" onclick="document.getElementById('file').click()" title="Share a file (max 25 MB)">📎</button>
  <textarea id="input" rows="1" placeholder="Message the room… (Enter to send)"></textarea>
  <button onclick="sendMsg()">Send</button>
</div>
<script>
  var ws=null, me="", joined=false, ROOM="", incoming={};
  var shownIds={}, everJoined=false;   // de-dup by message id + track rejoins
  var cid=(function(){ try{ var k="pkm-chat-cid"; var v=localStorage.getItem(k); if(!v){ v=Math.random().toString(36).slice(2,10); localStorage.setItem(k,v); } return v; }catch(e){ return Math.random().toString(36).slice(2,10); } })();
  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  var q=new URLSearchParams(location.search);
  ROOM=q.get("room")||"";
  if(!ROOM){ var p=location.pathname; if(p.indexOf("/room/")===0){ try{ROOM=decodeURIComponent(p.slice(6));}catch(e){ROOM=p.slice(6);} } }
  if(ROOM){
    var rl=document.getElementById("roomlabel"); rl.textContent="Room: "+ROOM; rl.style.display="inline";
    document.getElementById("hint").textContent='You are joining room "'+ROOM+'". Enter a display name and this room secret, then click Join.';
  } else {
    document.getElementById("go").disabled=true;
    document.getElementById("hint").innerHTML='<span style="color:#f87171">No room specified. Open the room link the host shared with you.</span>';
  }
  function toggleConn(){ if(joined){ leave(); } else { join(); } }
  function leave(){ if(ws){try{ws.close();}catch(e){}} }
  function setJoined(on){
    joined=on;
    document.getElementById("go").textContent=on?"Leave":"Join";
    ["name","secret"].forEach(function(id){ document.getElementById(id).disabled=on; });
    document.getElementById("composer").style.display=on?"flex":"none";
  }
  function join(){
    if(!ROOM) return;
    var h=document.getElementById("hint"); if(h){ h.textContent=""; }   // clear any prior error
    me=document.getElementById("name").value.trim()||"viewer";
    var secret=document.getElementById("secret").value;
    if(ws){try{ws.close();}catch(e){}}
    var proto=location.protocol==="https:"?"wss":"ws";
    ws=new WebSocket(proto+"://"+location.host);
    setStatus("connecting…","");
    ws.onopen=function(){ ws.send(JSON.stringify({t:"join",room:ROOM,user:me,token:secret,kind:"browser",cid:cid})); setStatus("connected","on"); setJoined(true); };
    ws.onclose=function(){ setStatus("disconnected",""); setJoined(false); };
    ws.onmessage=function(ev){ var f; try{f=JSON.parse(ev.data);}catch(e){return;} onFrame(f); };
  }
  function setStatus(t,cls){ document.getElementById("status").textContent=t; document.getElementById("dot").className=cls; }
  function onFrame(f){
    if(f.t==="error"){
      if(f.code==="muted"||f.code==="moderation"){ append({system:true,text:f.msg}); return; }   // informational, stay joined
      setStatus("error: "+f.msg,"err"); document.getElementById("hint").innerHTML='<span style="color:#f87171">'+esc(f.msg)+'</span>'; setJoined(false); return;
    }
    if(f.t==="closed"){ append({system:true,text:"Room closed ("+f.reason+")."}); setStatus("room closed","err"); if(ws){try{ws.close();}catch(e){}} return; }
    if(f.t==="kicked"){ append({system:true,text:f.reason||"You were removed by the host."}); setStatus("removed by host","err"); if(ws){try{ws.close();}catch(e){}} return; }
    if(f.t==="renamed"){ me=f.name; append({system:true,text:'The host renamed you to "'+f.name+'".'}); return; }
    if(f.t==="presence"){ paintMembers(f.members); return; }
    if(f.t==="history"){
      var msgs=f.messages||[];
      // Only show messages you haven't seen yet (dedup by id). On a rejoin, mark
      // where you left off so you just read what happened while you were away.
      var unseen=msgs.filter(function(m){ return !m.id || !shownIds[m.id]; });
      if(everJoined){ append({system:true,text: unseen.length ? "— new messages since you left —" : "— you're back; nothing new while you were away —"}); }
      unseen.forEach(append);
      everJoined=true;
      return;
    }
    if(f.t==="system"){ append({system:true,text:f.text}); return; }
    if(f.t==="msg"){ append(f); return; }
    if(f.t==="file.offer"){ incoming[f.file.fileId]={meta:f.file,from:f.from,chunks:[]}; append({from:f.from,kind:f.kind,text:"📎 sharing a file: "+f.file.name,ts:f.ts}); return; }
    if(f.t==="file.chunk"){ var inc=incoming[f.fileId]; if(inc){ inc.chunks.push(Uint8Array.from(atob(f.data),function(c){return c.charCodeAt(0);})); if(f.last){ var blob=new Blob(inc.chunks,{type:(inc.meta.mime||"application/octet-stream")}); addFileLink(inc.meta.name, URL.createObjectURL(blob)); delete incoming[f.fileId]; } } return; }
  }
  function append(m){
    if(m && m.id){ if(shownIds[m.id]) return; shownIds[m.id]=1; }   // never render the same message twice
    var log=document.getElementById("log");
    var atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<40;
    var el=document.createElement("div");
    if(m.system){ el.className="sys"; el.textContent=m.text; }
    else{
      el.className="msg"+(m.kind==="agent"?" agent":"");
      var t=m.ts?new Date(m.ts):new Date();
      var hh=("0"+t.getHours()).slice(-2)+":"+("0"+t.getMinutes()).slice(-2);
      el.innerHTML='<div class="who">'+(m.kind==="agent"?"🤖 ":"")+esc(m.from)+'<span class="t">'+hh+'</span></div><div class="body">'+esc(m.text)+'</div>';
    }
    log.appendChild(el); if(atBottom) log.scrollTop=log.scrollHeight;
  }
  function paintMembers(mm){
    function ago(ts){ if(!ts) return "left"; var s=Math.max(0,Math.round((Date.now()-ts)/1000)); if(s<60) return "left "+s+"s ago"; var m=Math.round(s/60); if(m<60) return "left "+m+"m ago"; var h=Math.round(m/60); return "left "+h+"h ago"; }
    document.getElementById("members").innerHTML=(mm||[]).map(function(m){
      var here=m.present!==false;
      var icon=m.host?"👑":m.kind==="agent"?"🤖":m.kind==="browser"?"🌐":"👤";
      var title=(m.host?"room host":m.kind==="agent"?"via MCP agent":m.kind==="browser"?"via browser":"via extension")+(m.verified===false?" · unverified identity":"");
      var sid=m.sid?'<span class="sid" title="'+(m.verified===false?"best-effort id (browser)":"stable id")+'">'+esc(m.sid)+'</span>':"";
      var mut=m.muted?' 🔇':"";
      var dotCls=here?(m.kind==="agent"?"agent":""):"gone";
      var tail=here?"":'<span class="ago">'+esc(ago(m.lastSeen))+'</span>';
      return '<div class="mem'+(here?"":" gone")+(m.muted?" muted":"")+'" title="'+title+'"><span class="mdot '+dotCls+'"></span>'+icon+' '+esc(m.user)+sid+mut+tail+'</div>';
    }).join("");
    // If the host muted me, disable my composer and show why.
    var mine=(mm||[]).filter(function(m){return m.sid&&m.sid===cid;})[0];
    var iAmMuted=!!(mine&&mine.muted);
    var input=document.getElementById("input"); var comp=document.getElementById("composer");
    if(input){ input.disabled=iAmMuted; input.placeholder=iAmMuted?"You are muted by the host — you can read but not post.":"Message the room… (Enter to send)"; }
    if(comp){ comp.style.opacity=iAmMuted?"0.6":"1"; }
  }
  function sendMsg(){
    var inp=document.getElementById("input"); var v=inp.value.trim(); if(!v||!ws) return;
    ws.send(JSON.stringify({t:"msg",room:ROOM,from:me,text:v,kind:"browser"}));
    inp.value="";
  }
  function b64(bytes){ var s=""; for(var i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return btoa(s); }
  async function sendFile(file){
    if(!ws||!joined||!file) return;
    if(file.size > 25*1024*1024){ alert("File too large (max 25 MB)."); return; }
    var buf=await file.arrayBuffer(); var bytes=new Uint8Array(buf);
    var fid=Math.random().toString(36).slice(2,10);
    ws.send(JSON.stringify({t:"file.offer",room:ROOM,from:me,kind:"browser",file:{fileId:fid,name:file.name,size:file.size,mime:(file.type||"application/octet-stream")}}));
    var CH=65536, seq=0;
    for(var off=0; off<bytes.length; off+=CH){
      var slice=bytes.subarray(off, Math.min(off+CH,bytes.length));
      ws.send(JSON.stringify({t:"file.chunk",room:ROOM,fileId:fid,seq:seq++,data:b64(slice),last:(off+CH>=bytes.length)}));
      while(ws.bufferedAmount > 4194304){ await new Promise(function(r){setTimeout(r,20);}); }
    }
    document.getElementById("file").value="";
  }
  function addFileLink(name,url){
    var log=document.getElementById("log");
    var el=document.createElement("div"); el.className="filerow";
    var a=document.createElement("a"); a.href=url; a.download=name; a.textContent="⬇ Save "+name; a.className="dl";
    el.appendChild(a); log.appendChild(el); log.scrollTop=log.scrollHeight;
  }
  document.getElementById("input").addEventListener("keydown",function(e){ if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg();} });
</script>
</body></html>`;
}
