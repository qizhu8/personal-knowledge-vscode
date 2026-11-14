import { readFileSync } from "fs";
import { join } from "path";
import { readNoteWorkItems } from "../knowledge/note-work-items";

/** Reuse the panel projection, with writes restricted to an explicitly managed transport. */
export function browserNoteTodo(bodyHtml: string, markdown: string, slug: string, title: string, extensionPath: string, boardSnapshot?: ReturnType<typeof readNoteWorkItems>, live = true, managed = false, webview = false, detail?: Record<string, unknown>): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let snapshot: ReturnType<typeof readNoteWorkItems>;
  try { snapshot = boardSnapshot ?? readNoteWorkItems(markdown); }
  catch (error) {
    return `<p role="alert">Cannot display Work Items: ${escape(error instanceof Error ? error.message : String(error))}</p>${bodyHtml}`;
  }
  if (!snapshot.items.length && !boardSnapshot) return bodyHtml;
  managed = managed && live && !!boardSnapshot;
  const source = readFileSync(join(extensionPath, "dist/webview/note-todo.js"), "utf8");
  const css = readFileSync(join(extensionPath, "dist/webview/panel.css"), "utf8");
  const todoCss = css.slice(css.indexOf(".note-todo-tabs"), css.indexOf(".user-profile-page"));
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<style>
    :root{--vscode-foreground:#24292f;--vscode-descriptionForeground:#57606a;--vscode-panel-border:#d0d7de;--vscode-editor-background:#fff;--vscode-sideBar-background:#f6f8fa;--vscode-input-background:#fff;--vscode-input-foreground:#24292f;--vscode-focusBorder:#0969da;--vscode-textLink-foreground:#0969da;--vscode-charts-blue:#087ea4;--vscode-charts-green:#1a7f37;--vscode-charts-yellow:#b08800;--vscode-editorWarning-foreground:#9a6700;--vscode-errorForeground:#cf222e}
    .hidden{display:none!important}.tbtn{font:inherit;background:transparent;color:inherit;border:1px solid var(--vscode-panel-border);border-radius:3px;padding:4px 8px;cursor:pointer}.tbtn:hover{background:#eaeef2}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0)}
    ${todoCss}
    ${live ? "" : "[data-todo-refresh]{display:none!important}"}
    @media print{.note-todo-tabs,.note-todo-toolbar button,.note-todo-filters{display:none}.note-todo-swimboard{max-height:none;overflow:visible}}
  </style>
  <nav class="note-todo-tabs" aria-label="Note views">${(boardSnapshot ? [["table","Table"],["board","Board"],["timeline","Timeline"]] : [["markdown","Markdown"],["table","Todo Table"],["board","Board"],["timeline","Timeline"]]).map(([view,label]) =>
    `<button type="button" class="tbtn" data-note-view="${view}"${webview ? "" : ` onclick="noteTodoShow('${view}')"`}>${label}</button>`).join("")}</nav>
  <p>${managed ? "Local Board management · double-click a card to open; click Unassigned to assign. Reload for the latest Agent claims." : live ? "Read-only progress view · reload the page to read the latest Note." : "Read-only exported snapshot · this file does not update from the live Board."} No Agent is started.</p>
  <div id="note-todo"></div><div id="note-markdown" class="hidden">${boardSnapshot ? "" : bodyHtml}</div>
  <script>
    const esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    let currentDetail=${json({ ...detail, type:"note", slug, title, ...(boardSnapshot ? { documentKind:"todo-board" } : {}) })};
    ${source}
    noteTodo.readOnly=${!managed};
    noteTodo.browserManaged=${managed && !webview};
    noteTodo.slug=currentDetail.slug;
    ${managed && webview ? `document.addEventListener('click',event=>{
      const link=event.target?.closest?.('a[href^="pkm://knowledge/"]');
      if(!link)return;
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({command:'nativeTodoOpenKnowledge',slug:currentDetail.slug,uri:link.getAttribute('href')});
    },true);` : ""}
    noteTodo.snapshot=${json({ ...snapshot, items:snapshot.items.filter(item=>!item.deletedAt) })};
    document.documentElement.dataset.pkmDirty='true';
    ${managed && webview ? `const nativeTodoApi=acquireVsCodeApi();
    const vscode={postMessage:message=>{
      if(message.command==='todoBoardGrantWorker'){
        if(noteTodo.pending)return;
        const requestId=++noteTodo.request;noteTodo.pending={requestId,kind:'worker-grant'};
        nativeTodoApi.postMessage({...message,requestId});noteTodoPaint();return;
      }
      nativeTodoApi.postMessage(message);
    }};
    let nativeTodoDeleted=${json(snapshot.items.filter(item=>item.deletedAt))};
    window.addEventListener('message',event=>{
      if(event.data?.command==='noteTodoResult'){
        const data=event.data.data;
        if(!data||!noteTodo.pending||data.slug!==noteTodo.slug||data.requestId!==noteTodo.pending.requestId)return;
        if(data.workerSecretStatus)noteTodo.workerSecretStatus=data.workerSecretStatus;
        if(data.snapshot)
          nativeTodoDeleted=data.snapshot.items.filter(item=>item.deletedAt);
        noteTodoResult(event.data.data);
      }
    });
    const pkModal=options=>{
      const dialog=document.createElement('dialog');dialog.setAttribute('aria-label','Todo confirmation');
      const label=document.createElement('p');label.textContent=options.message||options.title||'Reason';
      const input=document.createElement('input');input.id='pkm-native-todo-reason';input.setAttribute('aria-label','Reason');
      const ok=document.createElement('button');ok.textContent='Confirm';ok.onclick=()=>{const value=input.value;dialog.close();dialog.remove();options.onOk(value);};
      const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.onclick=()=>{dialog.close();dialog.remove();};
      dialog.append(label,input,ok,cancel);document.body.append(dialog);dialog.showModal();input.focus();
    };
    const safeMarked=esc;
    document.querySelectorAll('[data-note-view]').forEach(button=>button.onclick=()=>noteTodoShow(button.dataset.noteView));
    const nativeTodoPaint=noteTodoPaint;
    const nativeTodoChatButton=chatUrl=>{
      const open=document.createElement('button');open.type='button';open.className='tbtn';open.textContent='Open associated Chat';
      open.dataset.nativeTodoOpenChat=chatUrl;
      open.onclick=()=>{if(open.dataset.nativeTodoOpenChat)vscode.postMessage({command:'nativeTodoOpenChat',chatUrl:open.dataset.nativeTodoOpenChat});};
      return open;
    };
    noteTodoPaint=()=>{
      nativeTodoPaint();
      document.querySelectorAll('[data-todo-copy-chat]').forEach(button=>button.after(nativeTodoChatButton(button.dataset.todoCopyChat)));
      const form=document.getElementById('note-todo-editor'),owner=form?.elements.ownerId;
      if(owner){
        if(noteTodo.editor?.existing){
          const remove=document.createElement('button');remove.type='button';remove.className='tbtn';remove.textContent='Delete Work Item';
          remove.disabled=!!noteTodo.pending;
          remove.onclick=()=>pkModal({message:'Reason for deleting this Work Item',onOk:reason=>{
            if(reason.trim())noteTodoCommand({action:'delete',id:noteTodo.editor.item.id,reason:reason.trim()});
          }});
          form.querySelector('footer').append(remove);
        }
        const open=nativeTodoChatButton('');
        const update=()=>{
          const chat=noteTodo.chats.find(chat=>'chat:'+chat.id===owner.value);
          open.dataset.nativeTodoOpenChat=chat?.chatUrl||'';open.hidden=!open.dataset.nativeTodoOpenChat;
        };
        owner.addEventListener('input',update);form.querySelector('footer').prepend(open);update();
        const worker=form.querySelector('[data-todo-worker-token]');
        if(worker){
          worker.disabled=!!noteTodo.pending;
          const status=document.createElement('p');status.className='wide';status.dataset.nativeTodoWorkerSecret=worker.dataset.todoWorkerToken;
          const state=noteTodo.workerSecretStatus?.[worker.dataset.todoWorkerToken];
          status.textContent=state==='ready'?'Worker grant matches this private profile SecretStorage.':state==='pending'?'Worker secret finalization is still pending in this private profile.':state==='mismatch'?'Worker grant does not match this private profile secret.':state==='unavailable'?'Private profile SecretStorage is unavailable.':'No matching worker secret in this private profile.';
          worker.after(status);
        }
      }
      if(nativeTodoDeleted.length){
        const trash=document.createElement('section');trash.dataset.nativeTodoTrash='true';
        const heading=document.createElement('h3');heading.textContent='Deleted Work Items';trash.append(heading);
        nativeTodoDeleted.forEach(item=>{
          const row=document.createElement('p'),label=document.createElement('span'),restore=document.createElement('button');
          label.textContent=item.title+' ';restore.type='button';restore.className='tbtn';restore.textContent='Restore Work Item';
          restore.dataset.nativeTodoRestore=item.id;restore.disabled=!!noteTodo.pending;
          restore.onclick=()=>pkModal({message:'Reason for restoring this Work Item',onOk:reason=>{
            if(reason.trim())noteTodoCommand({action:'restore',id:item.id,reason:reason.trim()});
          }});
          row.append(label,restore);trash.append(row);
        });
        document.getElementById('note-todo').append(trash);
      }
    };
    ` : managed ? `const vscode={postMessage:async message=>{
      try{
        const response=await fetch('/_pkm/todo',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Pkm-Todo':'1'},
          body:JSON.stringify({documentPath:decodeURIComponent(location.pathname),message})});
        const data=await response.json();
        if(!response.ok||data.error)throw new Error(data.error||'Todo request failed: '+response.status);
        noteTodoResult(data);
      }catch(error){noteTodoResult({slug:noteTodo.slug,requestId:message.requestId,error:error.message});}
    }};
    const pkModal=options=>{const reason=prompt(options.message||options.title);if(reason!==null)options.onOk(reason);};
    const safeMarked=esc;` : "noteTodoLoad=()=>location.reload();"}
    const showNoteView=noteTodoShow;
    noteTodoShow=view=>{
      showNoteView(view);
      if(['markdown','table','board','timeline'].includes(view))history.replaceState(null,'','#todo-'+view);
    };
    const initialView=location.hash.replace(/^#todo-/,'');
    noteTodoShow(${json(boardSnapshot ? ["table","board","timeline"] : ["markdown","table","board","timeline"])}.includes(initialView)?initialView:${json(boardSnapshot ? "board" : "table")});
    ${managed ? "noteTodoLoad();" : ""}
  </script>`;
}
