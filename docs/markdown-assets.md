# Markdown-owned resources

Skills, Notes and Research use the same resource contract. For example:

```text
notes/Team/Design.md
notes/Team/Design.assets/plot.png
notes/Team/Design.assets/diagram.mmd
```

The Markdown reference is relative: `![Plot](Design.assets/plot.png)`.
Mermaid source can remain fenced in the document or be an attached source file.
Attaching an image does not automatically make it model-visible or send it to a
vision API.

`get_skill` includes existing image files from a Skill's owned `.assets` folder
in `image_assets`, with a ready-to-insert `markdown_reference` for each one.
Insert that reference into the Skill Markdown to embed the image. These MCP
fields describe existing files; image bytes must first be added through PKM's
resource management or another supported import workflow.

Browser Markdown previews (Notes, Skills and Research) fit Mermaid diagrams to their container width by default,
including side-by-side layouts. Each diagram has independent zoom-in, zoom-out,
Fit width and 100% controls; enlarged diagrams scroll within their own viewport.
Focus the diagram viewport to use `+` / `-`, `0` (original size) or `F` (fit).
Fit mode follows container resizing; manual zoom stays unchanged until Fit width
is selected. These controls do not modify the Markdown source.
Manual zoom is bounded to 1%-400%. Printing hides the controls, fits media to the
page and removes viewport height limits so diagrams are not cropped.
PKM's built-in Markdown previews use the same controls for both Mermaid diagrams
and ordinary images. Ordinary browser images are unchanged. Static HTML/linked
exports keep plain SVG diagrams and images without interactive controls.

Use **Fullscreen** to expand a diagram or image to the available browser/webview
window. The modal keeps keyboard focus inside; **Escape** or **Exit fullscreen**
restores the original zoom mode, scroll position and control focus. This works
without requiring the browser's native fullscreen permission.
Hold **Ctrl** (Windows/Linux) or **Command** (macOS) while scrolling over media to
zoom around the pointer. Ordinary scrolling remains unchanged. Enlarged media
can be panned by dragging non-text, non-link areas with the left mouse button.
Text labels remain selectable; links and controls retain their normal behavior.
Shift-drag retains selection behavior instead of starting a pan.

## Navigation and operations

PKM browser pages and Extension webviews enable the browser's native spellcheck
for prose inputs, including Chat, Markdown and Todo details. Code/JSON editors,
URLs and structured Todo references opt out. Suggestions and underlines depend
on the browser/VS Code webview's installed dictionaries and spellcheck settings;
PKM installs no dictionary, service or additional spelling extension.

Standalone browser readers have **Skills / Notes / Research** Library tabs.
Use the arrow handle centered on the sidebar's right edge to collapse or expand
navigation. It remains visible while scrolling; collapsing gives space back to
the article without changing the selected tab or expanded folder state.
The bottom-left navigation badge identifies the current reader as **Public**
(Public knowledge only) or **Private** (authenticated Public and Private
knowledge). It is an indicator, not an access-mode switch.
Private folders and their documents display the same small lock icon as the
Extension, including inherited privacy in nested folders. Public content stays
unlocked even in the Private reader; the Public reader still omits Private content.
Opening a document selects its content type; switching tabs changes only the
sidebar, never the article. Each tab retains its expanded folders, sidebar
scroll position and Research view for the browser session. **Ctrl/Command+F**
searches the directory; select the appropriate tab to browse its results.

Right-click a Library folder or document and choose **Copy path** to copy its
canonical `pkm://` URL, matching Navigation Copy Path (for example,
`pkm://notes/Research/` or `pkm://notes/Research/Topic.md`). Folder URLs end in `/`;
document URLs include `.md`, with each path segment URL-encoded. Shift+F10 also
opens this menu. Copy failures show the URL for manual copying.

**Ctrl/Command+G** opens **Go to PKM path** in the browser. Paste a copied Library
URL to open a document or expand, reveal and focus a folder in the correct tab.
Only content in the current reader's visible Library can be located; a URL does
not grant access to private content. Research folders open in Directory view.

Research offers **Directory**, **2D Graph** (Cytoscape), and **3D Graph**
(ForceGraph3D/WebGL), using the extension's bundled renderers. Citation arrows run
from the cited parent to the citing child; clicking a node opens its paper.
Graphs are read-only. Missing libraries or unavailable WebGL produce an explicit
error; Directory and 2D remain available.

The public gateway filters graph nodes and edges before sending them to the
browser and counts only visible citations. Private document titles, paths and
metadata are not included. Live assets pass the same privacy boundary rather
than being embedded in public HTML. Authenticated private previews retain their
separate access-controlled scope when navigating to another article.

Dragging content or folders to a new location in native Navigation refreshes the
knowledge inventory before updating the tree and panel. An older in-flight scan
cannot count as the refresh for a completed move. If the move succeeds but that
refresh fails, PKM reports both facts explicitly: refresh Navigation again, do not
repeat the move.

Expand a document in native Navigation to see its resource folder, then its
resources. The panel CatTree also exposes that folder. Select a resource to
preview it using VS Code's registered file/image editor. **Manage resources...**
is available in the folder and the document's native context menu.

Management supports adding files with relative links, copying a document together
with its resources, exporting a document bundle, renaming a resource together
with its Markdown references, deleting unused resources and previewing a legacy
migration. Resource folders, including attached `.md` source files, are not
misclassified as Knowledge categories or separate documents.

Save a new Note/Paper before pasting an image or attaching its file. Existing
attachments are saved using the original document path even when its form has
an unsaved title/category change. Save or close inline Markdown forms before
managing resources; dirty native Markdown editors also block mutation.

Moving/renaming a document moves its owned resource folder and rebases its managed
relative references. Existing legacy `_assets/` references are first migrated
into that document's owned directory; folder moves do the same for their documents.
Copying creates a new Knowledge identity and owns the copy's legacy attachments
without changing the source document. It copies owned
resources, including unattached diagram sources. Folder move/promote operations
retain resources and rebase references. A destination collision is refused rather
than merged or overwritten.

Trash stores an individual document and its resource folder in the same entry,
first owning any legacy attachments, records deletion intent for both and restores both without overwriting a
destination. Folder Trash includes its contents. Permanent deletion/Empty Trash
remove that entry's resources with it. Operations that would invalidate another
document's shared resource references are refused, with the referencing document
identified. A referenced resource cannot be deleted until its reference is
removed; it is never silently removed from another document.

## Legacy migration and transport

Existing category `_assets/` references continue to work. Opening a document,
listing resources, previewing an image or upgrading the extension never migrates
them. **Preview legacy resource migration** displays a hash-bound copy plan and
candidate document. **Apply reviewed migration**, or an explicit document
move/Trash operation, copies the resources into the document's `.assets/` folder
and rewrites that document. Changed sources,
changed documents, symlinks, escaping paths and conflicting destinations are
refused. Shared originals are retained until their last Markdown reference
migrates; then the old file is removed with deletion intent recorded for Sync.
Unreferenced unrelated files are not swept or guessed to belong to a document.
An existing document still owns unattached files in its `.assets` folder.
Selecting one as an explicit recovery source copies it without deleting the
other document's original, even when no Markdown link currently references it.
Missing legacy sources fail explicitly instead of moving a document with another
broken reference.
For an already broken historical link, **Repair missing legacy resource** lets
the user explicitly choose its original file from an existing resource directory
in the same content root. The reviewed, hash-bound plan copies it into the
document's owned directory, rewrites the link and removes an unshared old source.
The system never searches by basename and silently guesses an owner.

JSON export/import, Sync bundle/subscription materialization, subscription Fork
and GitHub dependency transport include owned resources and referenced legacy
resources. Imports validate hashes, ownership/reference paths and collisions.
Group imports prefix resource and document paths together; they refuse an
existing globally unique Skill name instead of moving that original Skill.
Resource mutations use the shared cross-process lock and the existing deletion
journal. Resource rename/deletion records the old path; saving or restoring the
parent clears only paths that actually exist in the restored payload. Previously
deleted resources retain their deletion intent rather than reappearing from
another replica. MCP Markdown writes and Trash use the same TypeScript lifecycle
code.

## Verification boundary

```sh
npm run test:markdown-assets
```

The tests use real isolated file stores for all three types, the actual MCP
mutation bridge, native UI workflows with mocked VS Code dialogs, and Chromium
CatTree resource controls at 1280/390/320 pixels. They cover explicit approval,
trust/dirty-editor guards, collisions, shared references, source hashes, copy/
move/rename, folder promotion, Trash/restore/deletion and bundle transport.
Native OS image-editor visuals, Windows filesystem/ACL behavior and power-loss
atomicity are separate acceptance; these tests do not certify them.
