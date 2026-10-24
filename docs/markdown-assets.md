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

## Navigation and operations

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
