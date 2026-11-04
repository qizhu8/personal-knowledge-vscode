import { readFileSync } from "fs";
import { join } from "path";
import { readNoteWorkItems } from "../knowledge/note-work-items";

/** Reuse the panel projection without exposing a webview bridge or mutation endpoint. */
export function browserNoteTodo(bodyHtml: string, markdown: string, slug: string, title: string, extensionPath: string, boardSnapshot?: ReturnType<typeof readNoteWorkItems>, live = true, managed = false): string {
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
    `<button type="button" class="tbtn" data-note-view="${view}" onclick="noteTodoShow('${view}')">${label}</button>`).join("")}</nav>
  <p>${managed ? "Local Board management · double-click a card to open; click Unassigned to assign. Reload for the latest Agent claims." : live ? "Read-only progress view · reload the page to read the latest Note." : "Read-only exported snapshot · this file does not update from the live Board."} No Agent is started.</p>
  <div id="note-todo"></div><div id="note-markdown" class="hidden">${boardSnapshot ? "" : bodyHtml}</div>
  <script>
    const esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    let currentDetail=${json({ type:"note", slug, title, ...(boardSnapshot ? { documentKind:"todo-board" } : {}) })};
    ${source}
    noteTodo.readOnly=${!managed};
    noteTodo.browserManaged=${managed};
    noteTodo.slug=currentDetail.slug;
    noteTodo.snapshot=${json({ ...snapshot, items:snapshot.items.filter(item=>!item.deletedAt) })};
    document.documentElement.dataset.pkmDirty='true';
    ${managed ? `const vscode={postMessage:async message=>{
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
