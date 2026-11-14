/** Revoke and drain live work before invalidating the profile key. */
export async function resetSelectedChatPermissions(options: {
  state: { owner: { assertCurrent(): void; revoke(): Promise<void> };
    profile: { resetPermissions(): Promise<void> }; ownerDrained?: boolean };
  confirm(): Promise<boolean>;
  assertSelection(): void;
}): Promise<boolean> {
  const { state } = options;
  if (!state.ownerDrained) {
    state.owner.assertCurrent();
    if (!await options.confirm()) return false;
    state.owner.assertCurrent();
    options.assertSelection();
    await state.owner.revoke();
    state.ownerDrained = true;
  }
  await state.profile.resetPermissions();
  return true;
}
