export const seedOriginalPrivateNoteLegacyReferrer = `
  const before = store.noteGet("Private/Secret");
  if (!before) throw new Error("Original private Note seed is missing");
  store.noteUpsert({ ...before, tags: JSON.parse(before.tags),
    content: before.content + "![private referrer to PUBLIC data](../_assets/shared.PNG?private-ref=1#view)\\n" });
  return { id: store.noteGet("Private/Secret").knowledgeId };
`;
