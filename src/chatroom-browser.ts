// ── Browser view (served by the hub over HTTP) ────────────────────────────────
// A single self-contained page: paste the host's Magic Message + enter a name, then watch and
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
  header input,header textarea{background:#3c3c3c;border:1px solid #444;border-radius:4px;color:#eee;padding:5px 8px;font-size:13px;font-family:inherit}
  header textarea{width:min(460px,70vw);height:48px;resize:vertical}
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
  #inputwrap{position:relative;display:flex;flex:1}
  #composer textarea{flex:1;resize:none;background:#3c3c3c;border:1px solid #444;border-radius:6px;color:#eee;padding:6px 8px;font-size:14px;font-family:inherit}
  #composer button{background:#0e639c;border:none;border-radius:6px;color:#fff;padding:0 16px;cursor:pointer}
  #suggest{position:absolute;left:0;bottom:calc(100% + 5px);z-index:20;min-width:220px;max-width:min(420px,80vw);max-height:220px;overflow-y:auto;background:#252526;border:1px solid #555;border-radius:7px;box-shadow:0 6px 20px rgba(0,0,0,.45);padding:4px}
  #suggest.hidden{display:none}.srow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px}.srow:hover,.srow.sel{background:#094771}.ssub{color:#999;font-size:11px;margin-left:auto}
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
  <textarea id="invite" placeholder="paste the complete Magic Message" oninput="authorizeMagicMessage()"></textarea>
  <button id="go" onclick="toggleConn()">Join</button>
  <span id="status" style="color:#888;font-size:12px"></span>
</header>
<div class="hint" id="hint">Paste the complete Magic Message from the host. Credentials are verified and extracted locally in this browser.</div>
<div id="wrap">
  <div id="log"></div>
  <div id="side"><h4>In the room</h4><div id="members"></div></div>
</div>
<div id="composer" style="display:none">
  <input type="file" id="file" style="display:none" onchange="if(this.files[0])sendFile(this.files[0])">
  <button id="attach" onclick="document.getElementById('file').click()" title="Share a file (max 25 MB)">📎</button>
  <div id="inputwrap"><div id="suggest" class="hidden"></div><textarea id="input" rows="1" placeholder="Message the room… (Enter to send)"></textarea></div>
  <button onclick="sendMsg()">Send</button>
</div>
<script>
  var ws=null, me="", joined=false, joining=false, ROOM="", ROOM_ID="", roomSecret="", magicGeneration=0, incoming={};
  var shownIds={}, everJoined=false, roster=[], suggestAnchor=null, suggestIndex=-1;   // de-dup by message id + track rejoins
  var browserCommands=[
    {cmd:"/help",args:"",desc:"List room commands"},
    {cmd:"/whois",args:" ",desc:"Show details about a member"},
    {cmd:"/stop",args:" ",desc:"Host: disconnect an online agent without removing its identity"}
  ];
  var cid=(function(){ try{ var k="pkm-chat-cid"; var v=localStorage.getItem(k); if(!v){ v=Math.random().toString(36).slice(2,10); localStorage.setItem(k,v); } return v; }catch(e){ return Math.random().toString(36).slice(2,10); } })();
  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  var q=new URLSearchParams(location.search);
  ROOM=q.get("room")||"";
  if(!ROOM){ var p=location.pathname; if(p.indexOf("/room/")===0){ try{ROOM=decodeURIComponent(p.slice(6));}catch(e){ROOM=p.slice(6);} } }
  if(ROOM){
    var rl=document.getElementById("roomlabel"); rl.textContent="Room: "+ROOM; rl.style.display="inline";
    document.getElementById("hint").textContent='You are joining room "'+ROOM+'". Paste its complete Magic Message, then click Join.';
  } else {
    document.getElementById("hint").textContent='No room is selected yet. Paste a Magic Message to select and authorize its room.';
  }
  document.getElementById("go").disabled=true;
  function b64url(bytes){ var s=""; for(var i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]); return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,""); }
  function decodeB64url(value){ var s=value.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4)s+="="; var raw=atob(s),bytes=new Uint8Array(raw.length); for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i); return new TextDecoder().decode(bytes); }
  function canonRoom(value){ return String(value||"").trim().replace(/\\s+/g," ").toLowerCase().slice(0,80); }
  function rotr(value,bits){return (value>>>bits)|(value<<(32-bits));}
  function sha256Fallback(text){
    var initial=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var constants=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var bytes=[];for(var i=0;i<text.length;i++)bytes.push(text.charCodeAt(i)&255);
    var bitLength=bytes.length*8;bytes.push(0x80);while(bytes.length%64!==56)bytes.push(0);
    for(i=7;i>=0;i--)bytes.push(i<4?(bitLength>>>i*8)&255:0);
    var hash=initial.slice(),words=new Array(64);
    for(var offset=0;offset<bytes.length;offset+=64){
      for(i=0;i<16;i++){var p=offset+i*4;words[i]=((bytes[p]<<24)|(bytes[p+1]<<16)|(bytes[p+2]<<8)|bytes[p+3])|0;}
      for(i=16;i<64;i++){var x=words[i-15],y=words[i-2],s0=rotr(x,7)^rotr(x,18)^(x>>>3),s1=rotr(y,17)^rotr(y,19)^(y>>>10);words[i]=(words[i-16]+s0+words[i-7]+s1)|0;}
      var a=hash[0],b=hash[1],c=hash[2],d=hash[3],e=hash[4],f=hash[5],g=hash[6],h=hash[7];
      for(i=0;i<64;i++){var big1=rotr(e,6)^rotr(e,11)^rotr(e,25),choose=(e&f)^(~e&g),t1=(h+big1+choose+constants[i]+words[i])|0,big0=rotr(a,2)^rotr(a,13)^rotr(a,22),majority=(a&b)^(a&c)^(b&c),t2=(big0+majority)|0;h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;}
      hash[0]=(hash[0]+a)|0;hash[1]=(hash[1]+b)|0;hash[2]=(hash[2]+c)|0;hash[3]=(hash[3]+d)|0;hash[4]=(hash[4]+e)|0;hash[5]=(hash[5]+f)|0;hash[6]=(hash[6]+g)|0;hash[7]=(hash[7]+h)|0;
    }
    var out=new Uint8Array(32);for(i=0;i<8;i++){out[i*4]=(hash[i]>>>24)&255;out[i*4+1]=(hash[i]>>>16)&255;out[i*4+2]=(hash[i]>>>8)&255;out[i*4+3]=hash[i]&255;}return out;
  }
  async function sha256(text){
    if(globalThis.crypto&&globalThis.crypto.subtle)return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)));
    return sha256Fallback(text);
  }
  async function authorizeMagicMessage(){
    var generation=++magicGeneration,text=document.getElementById("invite").value;
    roomSecret=""; document.getElementById("go").disabled=true;
    var match=text.match(/pkchat:v1:([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]{16})/);
    if(!match){ setMagicHint(text.trim()?"Magic Message does not contain a complete pkchat:v1 invitation.":"Paste the complete Magic Message from the host.",false); return; }
    try{
      var digest=await sha256(match[1]);
      if(generation!==magicGeneration)return;
      if(b64url(digest).slice(0,16)!==match[2])throw new Error("Magic Message checksum failed. Ask the host for a fresh copy.");
      var payload=JSON.parse(decodeB64url(match[1]));
      if(payload.v!==1||!payload.u||!String(payload.s||"").trim())throw new Error("Magic Message is missing room credentials.");
      var magicUrl=new URL(payload.u),magicRoom=canonRoom(decodeURIComponent(magicUrl.pathname.replace(/^\\/+/,"")));
      if(!/^wss?:$/.test(magicUrl.protocol)||!magicUrl.hostname||!magicRoom)throw new Error("Magic Message contains an invalid room URL.");
      if(ROOM&&canonRoom(ROOM)!==magicRoom)throw new Error('This invitation is for room "'+magicRoom+'", not "'+ROOM+'".');
      ROOM=magicRoom; ROOM_ID=String(payload.r||"").trim(); roomSecret=String(payload.s).trim();
      var rl=document.getElementById("roomlabel");rl.textContent="Room: "+ROOM;rl.style.display="inline";
      document.getElementById("go").disabled=false;
      setMagicHint('✓ Magic Message verified locally for room "'+ROOM+'".',true);
    }catch(e){if(generation===magicGeneration)setMagicHint(e&&e.message?e.message:String(e),false);}
  }
  function setMagicHint(text,ok){var h=document.getElementById("hint");h.textContent=text;h.style.color=ok?"#4ade80":"#f87171";}
  function toggleConn(){ if(joined||joining){ leave(); } else { join(); } }
  function leave(){ if(ws){try{ws.close();}catch(e){}} }
  function setJoined(on){
    joined=on;
    joining=false;
    document.getElementById("go").textContent=on?"Leave":"Join";
    ["name","invite"].forEach(function(id){ document.getElementById(id).disabled=on; });
    document.getElementById("composer").style.display=on?"flex":"none";
  }
  function setJoining(on){
    joining=on;
    joined=false;
    document.getElementById("go").textContent=on?"Cancel":"Join";
    ["name","invite"].forEach(function(id){ document.getElementById(id).disabled=on; });
    document.getElementById("composer").style.display="none";
  }
  function join(){
    if(!ROOM||!roomSecret){ setMagicHint("Paste and verify the room's Magic Message first.",false); return; }
    var h=document.getElementById("hint"); if(h){ h.textContent=""; }   // clear any prior error
    me=document.getElementById("name").value.trim()||"viewer";
    var secret=roomSecret;
    if(ws){try{ws.close();}catch(e){}}
    var proto=location.protocol==="https:"?"wss":"ws";
    ws=new WebSocket(proto+"://"+location.host);
    setJoining(true);
    setStatus("connecting…","");
    ws.onopen=function(){ ws.send(JSON.stringify({t:"join",room:ROOM,roomId:ROOM_ID||undefined,user:me,token:secret,kind:"browser",cid:cid})); };
    ws.onclose=function(){ setStatus("disconnected",""); setJoining(false); setJoined(false); };
    ws.onmessage=function(ev){ var f; try{f=JSON.parse(ev.data);}catch(e){return;} onFrame(f); };
  }
  function setStatus(t,cls){ document.getElementById("status").textContent=t; document.getElementById("dot").className=cls; }
  function onFrame(f){
    if(f.t==="join.pending"){ setJoining(true); setStatus("waiting for Host approval…",""); return; }
    if(f.t==="join.approved"){ return; }
    if(f.t==="join.ready"){ setJoined(true); setStatus("connected","on"); return; }
    if(f.t==="error"){
      if(f.code==="muted"||f.code==="moderation"){ append({system:true,text:f.msg}); return; }   // informational, stay joined
      setStatus("error: "+f.msg,"err"); document.getElementById("hint").innerHTML='<span style="color:#f87171">'+esc(f.msg)+'</span>'; setJoined(false); return;
    }
    if(f.t==="closed"){ append({system:true,text:"Room closed ("+f.reason+")."}); setStatus("room closed","err"); if(ws){try{ws.close();}catch(e){}} return; }
    if(f.t==="kicked"){ append({system:true,text:f.reason||"You were removed by the host."}); setStatus("removed by host","err"); if(ws){try{ws.close();}catch(e){}} return; }
    if(f.t==="renamed"){ me=f.name; append({system:true,text:'The host renamed you to "'+f.name+'".'}); return; }
    if(f.t==="room.renamed"){ ROOM=f.room; append({system:true,text:'Room renamed to "'+f.room+'".'}); return; }
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
    if(f.t==="msg"){ if(f.receipt&&f.receipt.ack&&f.id&&ws){ws.send(JSON.stringify({t:"msg.read",room:ROOM,messageId:f.id}));} append(f); return; }
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
    roster=mm||[];
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
    if(v.charAt(0)!=="/"&&!/^@(?:"[^"]{1,60}"|[\w\-]{1,60})(?:\s+|$)/u.test(v)){
      var selfMember=roster.filter(function(member){return member.user===me&&member.present!==false;})[0];
      var host=roster.filter(function(member){return member.host&&member.present!==false;})[0];
      var recipient=selfMember&&selfMember.host?"all":host?host.user:"all";
      var quoted=recipient!=="all"&&/[^A-Za-z0-9_\-]/.test(recipient);
      v=(quoted?'@"'+recipient.replace(/"/g,'')+'"':'@'+recipient)+" "+v;
    }
    ws.send(JSON.stringify({t:"msg",room:ROOM,from:me,text:v,kind:"browser"}));
    inp.value=""; hideSuggest();
  }
  function mentionCandidates(filter){
    var f=String(filter||"").toLowerCase(),seen={};
    var selfMember=roster.filter(function(member){return member.user===me&&member.present!==false;})[0];
    var list=selfMember&&selfMember.host?[{name:"all",label:"@all",sub:"notify everyone",icon:"📢"}]:[];
    roster.slice().sort(function(a,b){return (a.present===false?1:0)-(b.present===false?1:0);}).forEach(function(m){
      if(m.user===me||seen[m.user.toLowerCase()])return;seen[m.user.toLowerCase()]=1;
      list.push({name:m.user,label:"@"+m.user,sub:(m.present===false?"away":m.host?"host":m.kind||""),icon:m.host?"👑":m.kind==="agent"?"🤖":m.kind==="browser"?"🌐":"👤"});
    });
    return list.filter(function(item){return !f||item.name.toLowerCase().indexOf(f)===0;});
  }
  function showSuggest(items,anchor,type){
    var pop=document.getElementById("suggest");if(!items.length){hideSuggest();return;}
    suggestAnchor=anchor;suggestIndex=0;
    pop.innerHTML=items.map(function(item,i){return '<div class="srow'+(i===0?' sel':'')+'" data-type="'+type+'" data-value="'+esc(item.name||item.cmd)+'" data-args="'+esc(item.args||'')+'"><span>'+(item.icon||'⌘')+'</span><span>'+esc(item.label||item.cmd)+'</span><span class="ssub">'+esc(item.sub||item.desc||'')+'</span></div>';}).join("");
    Array.prototype.forEach.call(pop.querySelectorAll(".srow"),function(row){row.onclick=function(){pickSuggest(row.dataset.type,row.dataset.value,row.dataset.args);};});pop.classList.remove("hidden");
  }
  function hideSuggest(){var pop=document.getElementById("suggest");pop.classList.add("hidden");pop.innerHTML="";suggestAnchor=null;suggestIndex=-1;}
  function suggestInput(){
    var input=document.getElementById("input"),caret=input.selectionStart,upto=input.value.slice(0,caret),command=upto.match(/^\\/([a-z_]*)$/i);
    if(command){var f=command[1].toLowerCase();showSuggest(browserCommands.filter(function(c){return c.cmd.slice(1).indexOf(f)===0;}),{start:0,end:caret},"command");return;}
    var mention=upto.match(/@([^@\\s,.;:!?，。！？；：]*)$/u);
    if(mention){showSuggest(mentionCandidates(mention[1]),{start:caret-mention[1].length-1,end:caret},"mention");return;}hideSuggest();
  }
  function pickSuggest(type,value,args){
    var input=document.getElementById("input"),a=suggestAnchor||{start:input.selectionStart,end:input.selectionEnd},insert;
    if(type==="command")insert=value+(args||"");else{var quoted=value!=="all"&&/[^A-Za-z0-9_\\-]/.test(value);insert=(a.start>0&&!/\\s/.test(input.value[a.start-1])?" ":"")+(quoted?'@"'+value+'"':'@'+value)+" ";}
    input.value=input.value.slice(0,a.start)+insert+input.value.slice(a.end);var pos=a.start+insert.length;input.setSelectionRange(pos,pos);hideSuggest();input.focus();
  }
  function inputKeydown(e){
    var pop=document.getElementById("suggest"),open=!pop.classList.contains("hidden"),rows=Array.prototype.slice.call(pop.querySelectorAll(".srow"));
    if(open&&(e.key==="ArrowDown"||e.key==="ArrowUp")&&rows.length){e.preventDefault();suggestIndex=(suggestIndex+(e.key==="ArrowDown"?1:-1)+rows.length)%rows.length;rows.forEach(function(r,i){r.classList.toggle("sel",i===suggestIndex);});rows[suggestIndex].scrollIntoView({block:"nearest"});return;}
    if(open&&(e.key==="Enter"||e.key==="Tab")&&rows.length){e.preventDefault();rows[Math.max(0,suggestIndex)].click();return;}
    if(open&&e.key==="Escape"){e.preventDefault();hideSuggest();return;}
    if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg();}
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
  document.getElementById("input").addEventListener("input",suggestInput);
  document.getElementById("input").addEventListener("keydown",inputKeydown);
</script>
</body></html>`;
}
