/** Mounted editors register independently, including editors in linked columns. */
export type ProfileTransitionEditor = {
  profileId: string | undefined;
  pending: () => boolean;
  checkReady: (choice: 'save' | 'discard') => void;
  save: () => Promise<void>;
  /** Pause writes while the lifecycle request runs; resume if it fails/cancels. */
  pause: () => () => void;
};

const editors = new Set<ProfileTransitionEditor>();
export function registerProfileTransitionEditor(editor: ProfileTransitionEditor) {
  editors.add(editor);
  return () => {
    editors.delete(editor);
  };
}
export function profileTransitionEditors(profileId: string | undefined) {
  return profileId ? [...editors].filter((editor) => editor.profileId === profileId) : [];
}

export async function prepareProfileTransition(
  profileId: string | undefined,
  choice: 'save' | 'discard',
  active: () => boolean,
) {
  const participants = profileTransitionEditors(profileId);
  const checkActive = () => {
    if (!active())
      throw new Error('The selected profile changed. Reopen the profile action to continue.');
  };
  checkActive();
  // Check every editor before saving any: unresolved attachment links and history
  // operations must remain available to the user in their original editor.
  for (const editor of participants) editor.checkReady(choice);
  if (choice === 'save') {
    for (const editor of participants) {
      checkActive();
      if (!editors.has(editor))
        throw new Error('An editor changed. Review your entries before continuing.');
      if (editor.pending()) await editor.save();
    }
  }
  checkActive();
  if (profileTransitionEditors(profileId).some((editor) => !participants.includes(editor)))
    throw new Error('An editor opened. Review your entries before continuing.');
  for (const editor of participants) {
    if (!editors.has(editor))
      throw new Error('An editor changed. Review your entries before continuing.');
    editor.checkReady(choice);
  }
  // A discard only suspends local writers. Never rewrite or revoke accepted
  // versions; keep the draft available if the lifecycle request fails.
  const resume = participants.map((editor) => editor.pause());
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    for (const restore of resume) restore();
  };
}
