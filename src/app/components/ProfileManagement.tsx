import { useEffect, useRef, useState } from 'react';
import { validOnboardingFullName, validOnboardingBirthDate } from '../../shared/self-identity';
import {
  Copy,
  HardDrive,
  HeartHandshake,
  KeyRound,
  LockKeyhole,
  Pencil,
  Plus,
  Stethoscope,
  Trash2,
  UserRoundPen,
} from 'lucide-react';
import { PersonIcon, PersonIconPicker } from './PersonIcon';
import { LoadingIndicator } from './LoadingIndicator';
import { api, ApiError } from '../data/api';
import { publishNoteUpdate, subscribeNoteUpdates } from '../data/note-updates';
import {
  clearProfile,
  currentProfile,
  replaceProfiles,
  selectProfile,
  subscribeProfileIdentity,
  useProfiles,
} from '../data/profile';
import type { Profile } from '../data/profile';
import type { Note } from '../../shared/api';
import { formFor, inputFor, keyFor } from '../features/notes/note-form';
import {
  createProfile,
  deleteProfile,
  lockProfile,
  resumeProfileSetup,
  verifyProfileSetup,
  unlockProfile,
  type ProfileSetup,
  type RecoveryKit,
  type SavedPasskey,
  removeProfilePasskey,
} from '../data/profile-management';
import { NoteDialog } from '../features/notes/NoteDialog';
import { formatStorageBytes } from '../data/storage';
import { ArchiveStorageSummary, ProfileStorage } from './ProfileStorage';
import {
  unlockProfilePasskey,
  PasskeyUnlockError,
  type PasskeyUnlockPhase,
} from './passkey-unlock';
import { enrollProfilePasskey, PasskeyEnrollmentError } from './passkey-enrollment';
import { PasskeyNameEditor } from './PasskeyNameEditor';
import { notifySuccess } from './Toasts';
import { useProfileTransition } from './ProfileTransitionGuard';
import './profile-management.css';

let onboardingHandoff: string | null = null;
let storageHandoff: string | null = null;
let profileHandoff: { profileId: string; mode: 'recovery-choice' | 'setup-passkey' } | null = null;
// Profile details were collected before recovery setup. Keep old progress entries as history.
const onboardingKeys = ['primary-care', 'emergency-contact'];
function onboardingStepDone(progress: Note['person']['onboarding'], key: string) {
  const done = (value: string) =>
    Boolean(progress?.completedSteps.includes(value) || progress?.skippedSteps.includes(value));
  // The earlier combined care step covered both contacts. Keep its saved history intact.
  return (
    done(key) || ((key === 'primary-care' || key === 'emergency-contact') && done('care-team'))
  );
}
function needsSetup(note: Note) {
  const progress = note.person.onboarding;
  return !progress?.finished && onboardingKeys.some((key) => !onboardingStepDone(progress, key));
}

export function ProfileManagement({
  initialOpen = false,
  initialMode = 'list',
  triggerLabel,
  onBack,
  backLabel = 'Back',
}: {
  initialOpen?: boolean;
  initialMode?: 'list' | 'create';
  triggerLabel?: string;
  onBack?: () => void;
  backLabel?: string;
}) {
  const [open, setOpen] = useState(initialOpen),
    [mode, setMode] = useState<
      | 'list'
      | 'create'
      | 'recovery'
      | 'verify'
      | 'unlock'
      | 'recovery-choice'
      | 'delete'
      | 'storage'
      | 'onboarding'
      | 'passkey'
      | 'passkeys'
      | 'remove-passkey'
    >(initialMode);
  const [name, setName] = useState(''),
    [fullName, setFullName] = useState(''),
    [setupBirthDate, setSetupBirthDate] = useState(''),
    [icon, setIcon] = useState('person'),
    [placebo, setPlacebo] = useState(false),
    [ack, setAck] = useState(false),
    [setupName, setSetupName] = useState(''),
    [phrase, setPhrase] = useState(''),
    [setup, setSetup] = useState<ProfileSetup | null>(null),
    [target, setTarget] = useState<Profile | null>(null),
    [copyFrom, setCopyFrom] = useState<string | undefined>(),
    [step, setStep] = useState(0),
    [selfNote, setSelfNote] = useState<Note | null>(null),
    [primaryCare, setPrimaryCare] = useState(''),
    [primaryCarePhone, setPrimaryCarePhone] = useState(''),
    [emergencyContact, setEmergencyContact] = useState(''),
    [emergencyContactPhone, setEmergencyContactPhone] = useState(''),
    [passkeyPhase, setPasskeyPhase] = useState<'creating' | 'confirming' | 'saving'>('creating'),
    [setupPasskeyFlow, setSetupPasskeyFlow] = useState(false),
    [setupIncomplete, setSetupIncomplete] = useState<{
      profileId: string;
      incomplete: boolean;
    } | null>(null),
    [savedPasskeys, setSavedPasskeys] = useState<SavedPasskey[]>([]),
    [passkeyListProfileId, setPasskeyListProfileId] = useState<string | null>(null),
    [removingPasskey, setRemovingPasskey] = useState<SavedPasskey | null>(null),
    [editingPasskeyId, setEditingPasskeyId] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const profiles = useProfiles(),
    careNotes = useRef(new Map<string, Note | null>()),
    renameButtons = useRef(new Map<string, HTMLButtonElement>()),
    trigger = useRef<HTMLButtonElement | null>(null);
  const passkeyAttempt = useRef<{
      controller: AbortController;
      phase: 'creating' | 'confirming' | 'saving';
    } | null>(null),
    skipPasskeyButton = useRef<HTMLButtonElement | null>(null);
  const unlockAttempt = useRef<{ controller: AbortController; phase: PasskeyUnlockPhase } | null>(
    null,
  );
  const recoveryFocus = useRef(false);
  const privateEpoch = useRef(0);
  useEffect(() => {
    const unsubscribe = subscribeProfileIdentity(() => {
      privateEpoch.current++;
    });
    return () => {
      privateEpoch.current++;
      unsubscribe();
    };
  }, []);
  const privateActive = () => {
    const id = currentProfile()?.id,
      epoch = privateEpoch.current;
    return () => currentProfile()?.id === id && privateEpoch.current === epoch;
  };
  const requirePrivateActive = (active: () => boolean) => {
    if (!active()) throw new DOMException('Profile changed', 'AbortError');
  };
  const [recoveryParent, setRecoveryParent] = useState<'create' | 'list'>('create');
  const [passkeyParent, setPasskeyParent] = useState<'list' | 'recovery-choice' | 'passkeys'>(
    'list',
  );
  const [unlockPhase, setUnlockPhase] = useState<PasskeyUnlockPhase | null>(null);
  const [unlockMethod, setUnlockMethod] = useState<'passkey' | 'recovery'>('recovery');
  const transition = useProfileTransition();
  const refresh = async (active: () => boolean = () => true) => {
    const { data } = await api<Profile[]>('/profiles');
    if (!active()) return false;
    replaceProfiles(data);
    return true;
  };
  const selectedId = currentProfile()?.id;
  const selectedLocked = currentProfile()?.locked;
  useEffect(() => {
    setEditingPasskeyId(null);
  }, [open, mode, target?.id, selectedId, selectedLocked]);
  useEffect(() => {
    if (!open || mode !== 'list' || !selectedId || selectedLocked) return;
    let active = true;
    const update = (note: Note) => {
      if (active && note.isSelf && currentProfile()?.id === selectedId) {
        setSetupIncomplete({ profileId: selectedId, incomplete: needsSetup(note) });
      }
    };
    const unsubscribe = subscribeNoteUpdates(({ profileId, note }) => {
      if (profileId === selectedId) update(note);
    });
    void api<Note>('/notes/patient')
      .then(({ data }) => update(data))
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [open, mode, selectedId, selectedLocked]);
  const close = (next: boolean, force = false) => {
    if (!next && mode === 'unlock' && unlockAttempt.current) {
      if (unlockAttempt.current.phase === 'saving' && !force) return;
      cancelUnlock();
      force = true;
    }
    if (!next && mode === 'passkey' && !force) {
      skipPasskey();
      return;
    }
    if (!busy || force) {
      setOpen(next);
      if (!next) {
        setMode(initialMode);
        setError('');
        setPhrase('');
        setSetupPasskeyFlow(false);
      }
    }
  };
  useEffect(() => {
    const selected = currentProfile();
    if (storageHandoff && selected?.id === storageHandoff) {
      storageHandoff = null;
      setOpen(true);
      setMode('storage');
    }
    if (profileHandoff && selected?.id === profileHandoff.profileId) {
      const handoff = profileHandoff;
      profileHandoff = null;
      setOpen(true);
      setTarget(selected);
      setSetupPasskeyFlow(handoff.mode === 'setup-passkey');
      setPasskeyParent('recovery-choice');
      setMode('recovery-choice');
    }
    if (onboardingHandoff && selected?.id === onboardingHandoff) {
      onboardingHandoff = null;
      setOpen(true);
      void beginOnboarding();
    }
  });
  function openStorage(profile: Profile) {
    if (currentProfile()?.id === profile.id) {
      setMode('storage');
      return;
    }
    transition.request(() => {
      storageHandoff = profile.id;
      selectProfile(profile);
    });
  }
  function leavePasskey() {
    setBusy(false);
    if (setupPasskeyFlow) {
      setMode('onboarding');
      void beginOnboarding();
      return;
    }
    if (passkeyParent === 'passkeys') {
      setMode('passkeys');
      return;
    }
    close(false, true);
  }
  function skipPasskey() {
    const attempt = passkeyAttempt.current;
    if (attempt?.phase === 'saving') return;
    attempt?.controller.abort();
    passkeyAttempt.current = null;
    leavePasskey();
  }
  useEffect(() => {
    if (!open || mode !== 'passkey' || !target || target.locked) return;
    const attempt = {
      controller: new AbortController(),
      phase: 'creating' as 'creating' | 'confirming' | 'saving',
    };
    passkeyAttempt.current = attempt;
    setPasskeyPhase('creating');
    setError('');
    setBusy(true);
    // Defer browser UI until StrictMode's setup/cleanup replay has finished.
    queueMicrotask(async () => {
      if (attempt.controller.signal.aborted) return;
      skipPasskeyButton.current?.focus();
      try {
        await enrollProfilePasskey(target.id, {
          signal: attempt.controller.signal,
          onPhase: (phase) => {
            if (attempt.controller.signal.aborted || passkeyAttempt.current !== attempt) return;
            attempt.phase = phase;
            setPasskeyPhase(phase);
          },
        });
        if (attempt.controller.signal.aborted || passkeyAttempt.current !== attempt) return;
        passkeyAttempt.current = null;
        await refresh(() => !attempt.controller.signal.aborted);
        if (attempt.controller.signal.aborted) return;
        notifySuccess('Passkey added.');
        leavePasskey();
      } catch (error) {
        if (attempt.controller.signal.aborted || passkeyAttempt.current !== attempt) return;
        passkeyAttempt.current = null;
        setBusy(false);
        setError(
          error instanceof PasskeyEnrollmentError
            ? error.message
            : 'Passkey setup did not finish. Your recovery key still works.',
        );
      }
    });
    return () => {
      attempt.controller.abort();
      if (passkeyAttempt.current === attempt) passkeyAttempt.current = null;
    };
  }, [open, mode, target?.id, target?.locked, setupPasskeyFlow]);
  useEffect(() => {
    if (mode === 'passkey' && error) skipPasskeyButton.current?.focus();
  }, [mode, error]);
  async function start() {
    if (busy || !name.trim()) return;
    if (setup) {
      setError('');
      setPhrase('');
      setMode('recovery');
      return;
    }
    if (
      !copyFrom &&
      !placebo &&
      (!validOnboardingFullName(fullName) || !validOnboardingBirthDate(setupBirthDate))
    ) {
      setError('Enter your full name and complete date of birth.');
      return;
    }
    setRecoveryParent('create');
    setBusy(true);
    setError('');
    setAck(false);
    setPhrase('');
    setSetupName(name.trim());
    setSetup(null);
    try {
      setSetup(
        await createProfile(
          name.trim(),
          icon,
          placebo,
          copyFrom,
          !copyFrom && !placebo
            ? { fullName: fullName.trim(), birthDate: setupBirthDate }
            : undefined,
        ),
      );
      setMode('recovery');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create setup.');
    } finally {
      setBusy(false);
    }
  }
  function chooseRecovery() {
    if (!ack) return;
    setPhrase('');
    setMode('verify');
  }
  function verify(recovery: string) {
    if (busy || !ack || !setup || !recovery.trim()) return;
    transition.request(async (active) => {
      setBusy(true);
      setError('');
      try {
        const p = await verifyProfileSetup(setup.setupId, recovery.trim());
        if (!active()) return;
        if (!(await refresh(active))) return;
        setBusy(false);
        setPhrase('');
        setSetup(null);
        profileHandoff = { profileId: p.id, mode: 'setup-passkey' };
        selectProfile(p);
      } catch (e) {
        if (active()) {
          setPhrase('');
          setError(
            e instanceof Error ? e.message : 'That recovery key could not unlock this profile.',
          );
        }
      } finally {
        if (active()) setBusy(false);
      }
    });
  }
  async function verifyFile(file: File) {
    if (!setup) return;
    setBusy(true);
    setError('');
    try {
      const kit = JSON.parse(await file.text()) as RecoveryKit;
      if (
        kit.format !== 'circus-health-recovery-v1' ||
        kit.profileId !== setup.profileId ||
        !kit.phrase
      )
        throw new Error('That recovery file belongs to a different profile.');
      setPhrase(kit.phrase);
    } catch (e) {
      setPhrase('');
      setError(
        e instanceof Error ? e.message : 'That recovery file could not verify this profile.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function readCarePerson(id?: string) {
    if (!id) return null;
    try {
      return (await api<Note>(`/notes/${encodeURIComponent(id)}`)).data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  async function beginOnboarding() {
    const active = privateActive();
    setBusy(true);
    setError('');
    careNotes.current.clear();
    try {
      const note = (await api<Note>('/notes/patient')).data,
        form = formFor(note),
        progress = form.person.onboarding || {
          completedSteps: [],
          skippedSteps: [],
          finished: false,
        },
        next = progress.finished
          ? -1
          : onboardingKeys.findIndex((key) => !onboardingStepDone(progress, key));
      requirePrivateActive(active);
      if (next < 0) {
        setError('Setup is already complete.');
        return;
      }
      const ids = progress.careTeam,
        [primary, emergency] = await Promise.all([
          readCarePerson(ids?.primaryCareId),
          readCarePerson(ids?.emergencyContactId),
        ]);
      requirePrivateActive(active);
      if (ids?.primaryCareId) careNotes.current.set(ids.primaryCareId, primary);
      if (ids?.emergencyContactId) careNotes.current.set(ids.emergencyContactId, emergency);
      setPrimaryCare(primary?.title || '');
      setPrimaryCarePhone(typeof primary?.person.phone === 'string' ? primary.person.phone : '');
      setEmergencyContact(emergency?.title || '');
      setEmergencyContactPhone(
        typeof emergency?.person.phone === 'string' ? emergency.person.phone : '',
      );
      setSelfNote(note);
      setName(form.title);
      setIcon(typeof form.person.icon === 'string' ? form.person.icon : 'person');
      setStep(next);
      setMode('onboarding');
    } catch (e) {
      if (active()) setError(e instanceof Error ? e.message : 'Could not load setup progress.');
    } finally {
      if (active()) setBusy(false);
    }
  }
  function resumeOnboarding(profile: Profile) {
    if (currentProfile()?.id === profile.id) {
      void beginOnboarding();
      return;
    }
    transition.request(() => {
      onboardingHandoff = profile.id;
      selectProfile(profile);
    });
  }
  async function saveSelf(
    stepKey: string,
    skipped: boolean,
    changes: Record<string, unknown> = {},
    source = selfNote,
    recordProgress = true,
  ) {
    const active = privateActive();
    if (!source) throw new Error('Setup details have not loaded.');
    const form = formFor(source),
      prior = form.person.onboarding || { completedSteps: [], skippedSteps: [], finished: false },
      changed = changes.onboarding as Partial<typeof prior> | undefined,
      completedSteps = recordProgress
        ? [...new Set([...prior.completedSteps, ...(skipped ? [] : [stepKey])])]
        : prior.completedSteps,
      skippedSteps = recordProgress
        ? [...new Set([...prior.skippedSteps, ...(skipped ? [stepKey] : [])])]
        : prior.skippedSteps;
    form.title = typeof changes.name === 'string' ? changes.name : form.title;
    form.person = {
      ...form.person,
      ...changes,
      onboarding: {
        ...prior,
        ...changed,
        completedSteps,
        skippedSteps,
        finished: onboardingKeys.every((key) =>
          onboardingStepDone({ ...prior, completedSteps, skippedSteps }, key),
        ),
      },
    };
    const saved = (
      await api<Note>(`/notes/${encodeURIComponent(source.id)}`, {
        method: 'PUT',
        body: JSON.stringify(inputFor(form, 'person', source.version)),
      })
    ).data;
    requirePrivateActive(active);
    setSelfNote(saved);
    const profileId = currentProfile()?.id;
    if (profileId) setSetupIncomplete({ profileId, incomplete: needsSetup(saved) });
    publishNoteUpdate(currentProfile()?.id, saved);
    return saved;
  }
  async function upsertCarePerson(id: string, title: string, person: Record<string, unknown>) {
    const active = privateActive();
    if (!title.trim()) return;
    const existing = careNotes.current.get(id) || (await readCarePerson(id));
    requirePrivateActive(active);
    if (existing && (existing.kind !== 'person' || existing.isSelf))
      throw new Error('This setup contact is not an editable Person.');
    const form = formFor(existing),
      before = keyFor(form, 'person');
    form.title = title.trim();
    form.person = {
      ...form.person,
      ...person,
      name: title.trim(),
      tags: [
        ...new Set([
          ...(Array.isArray(form.person.tags) ? form.person.tags : []),
          ...(Array.isArray(person.tags) ? person.tags : []),
        ]),
      ],
    };
    if (existing && before === keyFor(form, 'person')) {
      careNotes.current.set(id, existing);
      return;
    }
    const input = inputFor(form, 'person', existing?.version),
      saved = (
        await api<Note>(existing ? `/notes/${encodeURIComponent(id)}` : '/notes', {
          method: existing ? 'PUT' : 'POST',
          body: JSON.stringify(existing ? input : { ...input, id }),
        })
      ).data;
    requirePrivateActive(active);
    careNotes.current.set(id, saved);
    publishNoteUpdate(currentProfile()?.id, saved);
  }
  function careNoteId(prior?: string) {
    if (prior && careNotes.current.get(prior)) return prior;
    // Earlier setup saved a descriptive prefix before the UUID. Keep that UUID
    // when repairing an uncreated contact so retries share one stable identity.
    const uuid = prior?.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
    )?.[1];
    return `note:${uuid || crypto.randomUUID()}`;
  }
  async function finishOnboarding(skipped: boolean) {
    const active = privateActive();
    setBusy(true);
    setError('');
    try {
      const key = onboardingKeys[step];
      let saved: Note;
      if ((key === 'primary-care' || key === 'emergency-contact') && !skipped) {
        if (!selfNote) throw new Error('Setup details have not loaded.');
        const primary = key === 'primary-care';
        if (primary && primaryCarePhone.trim() && !primaryCare.trim())
          throw new Error('Enter the primary care provider’s name with their phone number.');
        if (!primary && emergencyContactPhone.trim() && !emergencyContact.trim())
          throw new Error('Enter the emergency contact’s name with their phone number.');
        const prior = selfNote.person.onboarding || {
            completedSteps: [],
            skippedSteps: [],
            finished: false,
          },
          careTeam = {
            ...prior.careTeam,
            ...(primary
              ? { primaryCareId: careNoteId(prior.careTeam?.primaryCareId) }
              : { emergencyContactId: careNoteId(prior.careTeam?.emergencyContactId) }),
          },
          persisted = await saveSelf(
            key,
            false,
            { onboarding: { ...prior, careTeam } },
            selfNote,
            false,
          );
        if (primary)
          await upsertCarePerson(careTeam.primaryCareId!, primaryCare, {
            tags: ['Primary Care Provider'],
            ...(primaryCarePhone.trim() ||
            careNotes.current.get(careTeam.primaryCareId!)?.person.phone
              ? { phone: primaryCarePhone.trim() }
              : {}),
          });
        else
          await upsertCarePerson(careTeam.emergencyContactId!, emergencyContact, {
            ...(emergencyContactPhone.trim() ||
            careNotes.current.get(careTeam.emergencyContactId!)?.person.phone
              ? { phone: emergencyContactPhone.trim() }
              : {}),
          });
        saved = await saveSelf(key, false, {}, persisted);
      } else saved = await saveSelf(key, true);
      requirePrivateActive(active);
      const next = onboardingKeys.findIndex(
        (item, index) => index > step && !onboardingStepDone(saved.person.onboarding, item),
      );
      if (next < 0) close(false, true);
      else setStep(next);
    } catch (e) {
      if (active()) setError(e instanceof Error ? e.message : 'Could not save setup progress.');
    } finally {
      if (active()) setBusy(false);
    }
  }
  function unlock(recovery: string) {
    if (busy || !target || !recovery.trim()) return;
    transition.request(async (active) => {
      setBusy(true);
      setError('');
      try {
        const p = await unlockProfile(target.id, recovery.trim());
        if (!active()) return;
        if (!(await refresh(active))) return;
        setBusy(false);
        setPhrase('');
        profileHandoff = { profileId: p.id, mode: 'recovery-choice' };
        selectProfile(p);
      } catch (e) {
        if (active()) {
          setPhrase('');
          setError(
            e instanceof Error ? e.message : 'That recovery key could not unlock this profile.',
          );
        }
      } finally {
        if (active()) setBusy(false);
      }
    }, currentProfile()?.id !== target.id);
  }
  function lock(target: Profile) {
    if (busy) return;
    transition.request(async (active) => {
      setBusy(true);
      setError('');
      try {
        await lockProfile(target.id);
        if (!active()) return;
        setBusy(false);
        const lockedSelected = currentProfile()?.id === target.id;
        if (lockedSelected) clearProfile();
        await refresh(lockedSelected ? () => !currentProfile() : active);
      } catch (e) {
        if (active()) setError(e instanceof Error ? e.message : 'Could not lock profile.');
      } finally {
        if (active()) setBusy(false);
      }
    }, currentProfile()?.id === target.id);
  }
  async function remove() {
    if (
      !target ||
      target.locked ||
      !profiles.some((p) => p.id === target.id && !p.locked) ||
      name.trim() !== target.name
    )
      return;
    setBusy(true);
    setError('');
    try {
      await deleteProfile(target.id, target.name, target.version ?? 0);
      if (currentProfile()?.id === target.id) clearProfile();
      await refresh();
      setMode('list');
      setTarget(null);
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete profile.');
    } finally {
      setBusy(false);
    }
  }
  async function resume(file: File) {
    if (busy) return;
    const active = transition.captureActive();
    let kit: RecoveryKit, result: Awaited<ReturnType<typeof resumeProfileSetup>>;
    setBusy(true);
    setError('');
    try {
      kit = JSON.parse(await file.text()) as RecoveryKit;
      if (!active()) return;
      if (kit.format !== 'circus-health-recovery-v1' || !kit.profileId || !kit.phrase)
        throw new Error('That recovery file is not valid.');
      result = await resumeProfileSetup(kit);
    } catch {
      if (active()) setError('That recovery file could not resume setup.');
      return;
    } finally {
      if (active()) setBusy(false);
    }
    if (!active()) return;
    if (result.active) {
      transition.request(async (canContinue) => {
        setBusy(true);
        setError('');
        try {
          const p = await unlockProfile(result.profileId, kit);
          if (!canContinue()) return;
          if (!(await refresh(canContinue))) return;
          setBusy(false);
          setPhrase('');
          profileHandoff = { profileId: p.id, mode: 'recovery-choice' };
          selectProfile(p);
        } catch {
          if (canContinue()) setError('That recovery file could not open the profile.');
        } finally {
          if (canContinue()) setBusy(false);
        }
      }, currentProfile()?.id !== result.profileId);
    } else {
      setRecoveryParent('list');
      setSetup({ setupId: result.setupId, profileId: result.profileId, recoveryKit: kit });
      setPhrase('');
      setAck(false);
      setSetupName(result.name || result.profileId);
      setMode('recovery');
    }
  }
  function cancelUnlock() {
    const attempt = unlockAttempt.current;
    if (attempt) transition.cancelAction();
    attempt?.controller.abort();
    unlockAttempt.current = null;
    setUnlockPhase(null);
    setBusy(false);
  }
  function useRecovery() {
    if (unlockAttempt.current?.phase === 'saving') return;
    recoveryFocus.current = true;
    cancelUnlock();
    setError('');
    setUnlockMethod('recovery');
  }
  useEffect(() => {
    if (
      mode === 'unlock' &&
      unlockMethod === 'recovery' &&
      unlockPhase === null &&
      recoveryFocus.current
    ) {
      recoveryFocus.current = false;
      document.getElementById('recovery-password')?.focus();
    }
  }, [mode, unlockMethod, unlockPhase]);
  function unlockPasskey() {
    if (!target || unlockAttempt.current || busy) return;
    setUnlockMethod('passkey');
    setError('');
    transition.request(async (transitionActive) => {
      const attempt = { controller: new AbortController(), phase: 'waiting' as PasskeyUnlockPhase };
      unlockAttempt.current = attempt;
      setBusy(true);
      setUnlockPhase('waiting');
      setError('');
      const active = () =>
        transitionActive() &&
        !attempt.controller.signal.aborted &&
        unlockAttempt.current === attempt;
      try {
        const p = await unlockProfilePasskey(target.id, {
          signal: attempt.controller.signal,
          onPhase: (phase) => {
            if (active()) {
              attempt.phase = phase;
              setUnlockPhase(phase);
            }
          },
        });
        if (!active()) return;
        if (!(await refresh(active))) return;
        unlockAttempt.current = null;
        setUnlockPhase(null);
        setBusy(false);
        setPhrase('');
        selectProfile(p);
        close(false, true);
      } catch (error) {
        if (active()) {
          unlockAttempt.current = null;
          setUnlockPhase(null);
          setBusy(false);
          setError(
            error instanceof PasskeyUnlockError
              ? error.message
              : 'Passkey unlock did not finish. Try again or use your recovery key.',
          );
        }
      }
    }, currentProfile()?.id !== target.id);
  }
  useEffect(() => {
    if (!open || mode !== 'unlock' || !target) return;
    let disposed = false;
    // Defer the single entry attempt past StrictMode's effect replay.
    queueMicrotask(() => {
      if (!disposed && target.hasPasskey === true) void unlockPasskey();
    });
    const unsubscribe = subscribeProfileIdentity(() => {
      cancelUnlock();
      setMode('list');
    });
    return () => {
      disposed = true;
      unsubscribe();
      unlockAttempt.current?.controller.abort();
      unlockAttempt.current = null;
    };
  }, [open, mode, target?.id]);

  // Private sub-screens belong to the current identity. A lock or selection
  // change must not leave a Back path into stale fields or pending credentials.
  useEffect(() => {
    if (
      ![
        'passkey',
        'passkeys',
        'remove-passkey',
        'recovery-choice',
        'onboarding',
        'storage',
        'delete',
      ].includes(mode)
    )
      return;
    return subscribeProfileIdentity(() => {
      passkeyAttempt.current?.controller.abort();
      passkeyAttempt.current = null;
      setBusy(false);
      setTarget(null);
      setSavedPasskeys([]);
      setRemovingPasskey(null);
      setSelfNote(null);
      careNotes.current.clear();
      setName('');
      setPrimaryCare('');
      setPrimaryCarePhone('');
      setEmergencyContact('');
      setEmergencyContactPhone('');
      setSetupPasskeyFlow(false);
      setPhrase('');
      setError('');
      setMode('list');
    });
  }, [mode]);
  useEffect(() => {
    if (!open || !['list', 'passkeys'].includes(mode)) return;
    const profile = mode === 'passkeys' ? target : currentProfile();
    if (!profile || profile.locked) return;
    let active = true;
    if (mode === 'passkeys') setBusy(true);
    setSavedPasskeys([]);
    setPasskeyListProfileId(null);
    void api<SavedPasskey[]>(`/api/profiles/${encodeURIComponent(profile.id)}/passkeys`)
      .then(({ data }) => {
        if (active && Array.isArray(data)) {
          setSavedPasskeys(data);
          setPasskeyListProfileId(profile.id);
        }
      })
      .catch((e) => {
        if (active && mode === 'passkeys')
          setError(e instanceof Error ? e.message : 'Could not load passkeys.');
      })
      .finally(() => {
        if (active && mode === 'passkeys') setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [open, mode, target?.id, target?.locked, selectedId, selectedLocked]);
  async function removeSavedPasskey() {
    if (!target || !removingPasskey || busy) return;
    const id = target.id,
      active = privateActive();
    setBusy(true);
    setError('');
    try {
      await removeProfilePasskey(id, removingPasskey.id);
      if (!active()) return;
      await refresh(active);
      if (!active()) return;
      setRemovingPasskey(null);
      setMode('passkeys');
      notifySuccess('Passkey removed.');
    } catch (e) {
      if (active()) setError(e instanceof Error ? e.message : 'Could not remove passkey.');
    } finally {
      if (active()) setBusy(false);
    }
  }
  const passkeyDate = (value: string) =>
    new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const backDisabled =
    mode === 'passkey'
      ? busy && passkeyPhase === 'saving'
      : mode === 'unlock'
        ? busy && (!unlockAttempt.current || unlockPhase === 'saving')
        : busy;
  function goBack() {
    if (backDisabled) return;
    setError('');
    setPhrase('');
    if (mode === 'list') {
      close(false);
      onBack?.();
      return;
    }
    if (mode === 'unlock') {
      cancelUnlock();
      setTarget(null);
      setMode('list');
      return;
    }
    if (mode === 'passkey') {
      passkeyAttempt.current?.controller.abort();
      passkeyAttempt.current = null;
      setBusy(false);
      setMode(passkeyParent);
      return;
    }
    if (mode === 'remove-passkey') {
      setRemovingPasskey(null);
      setMode('passkeys');
      return;
    }
    if (mode === 'verify') {
      setMode('recovery');
      return;
    }
    if (mode === 'recovery') {
      if (recoveryParent === 'create') setName(setupName);
      setMode(recoveryParent);
      return;
    }
    if (mode === 'onboarding' && step > 0) {
      setStep(step - 1);
      return;
    }
    if (mode === 'onboarding' && setupPasskeyFlow) {
      setMode('recovery-choice');
      return;
    }
    setMode('list');
  }
  const backText =
    mode === 'list'
      ? backLabel
      : mode === 'remove-passkey' || (mode === 'passkey' && passkeyParent === 'passkeys')
        ? 'Back to passkeys'
        : mode === 'verify'
          ? 'Back to recovery key'
          : mode === 'recovery' && recoveryParent === 'create'
            ? 'Back to profile details'
            : (mode === 'passkey' && passkeyParent === 'recovery-choice') ||
                (mode === 'onboarding' && setupPasskeyFlow && step === 0)
              ? 'Back to recovery options'
              : mode === 'onboarding' && step > 0
                ? 'Back to primary care provider'
                : 'Back to profiles';

  const title =
    mode === 'create' ? (
      'Create profile'
    ) : mode === 'recovery' ? (
      'Save your recovery key'
    ) : mode === 'unlock' ? (
      <span className="profile-unlock-title">
        <span className="profile-unlock-icon">
          <PersonIcon value={target?.icon} size={26} />
        </span>
        <span>Open {target?.name}</span>
      </span>
    ) : mode === 'verify' ? (
      'Open profile'
    ) : mode === 'recovery-choice' ? (
      'Recovery unlocked'
    ) : mode === 'storage' ? (
      'Profile storage'
    ) : mode === 'passkey' ? (
      `Add passkey for ${target?.name}`
    ) : mode === 'passkeys' ? (
      'Manage passkeys'
    ) : mode === 'remove-passkey' ? (
      'Remove passkey'
    ) : mode === 'onboarding' ? (
      'Care contacts'
    ) : (
      'Profiles'
    );
  return (
    <>
      <button ref={trigger} className="profile-current" type="button" onClick={() => setOpen(true)}>
        <PersonIcon value={currentProfile()?.icon} />
        <span>{triggerLabel || currentProfile()?.name || 'Profiles'}</span>
      </button>
      <NoteDialog
        open={open}
        onOpenChange={close}
        returnFocusTo={() => trigger.current}
        onBack={mode !== 'list' || onBack ? goBack : undefined}
        backLabel={backText}
        backDisabled={backDisabled}
        title={title}
        className={mode === 'unlock' ? 'profile-unlock-dialog' : ''}
        hideDescription={mode === 'unlock'}
        description={
          mode === 'unlock'
            ? 'Open with your passkey. Your recovery key is available as a fallback.'
            : mode === 'verify'
              ? 'Use your recovery key to open this profile. You can save it in your password manager.'
              : mode === 'passkeys' || mode === 'remove-passkey'
                ? 'Passkeys saved for this encrypted profile.'
                : mode === 'passkey'
                  ? 'Approve the request in your password manager.'
                  : mode === 'list'
                    ? 'Profiles are separate encrypted archives.'
                    : mode === 'storage'
                      ? 'Encrypted data kept for the selected profile only.'
                      : mode === 'onboarding'
                        ? 'Each step is optional and can be updated later from Self.'
                        : 'Recovery material stays only in this browser tab while you finish this step.'
        }
      >
        {mode === 'list' && (
          <div className="profile-management">
            <ul className="profile-management-list">
              {profiles.map((p) => {
                const hasWorkingPasskey = p.hasPasskey === true,
                  hasRegisteredPasskeys =
                    passkeyListProfileId === p.id ? savedPasskeys.length > 0 : hasWorkingPasskey,
                  onboardingIncomplete =
                    setupIncomplete?.profileId === p.id && setupIncomplete.incomplete,
                  setupNeedsAttention = onboardingIncomplete || !hasWorkingPasskey,
                  topActionCount =
                    1 +
                    Number(onboardingIncomplete) +
                    Number(!hasWorkingPasskey) +
                    Number(hasRegisteredPasskeys);
                return (
                  <li className={p.id === currentProfile()?.id ? 'selected' : ''} key={p.id}>
                    <button
                      className="profile-row"
                      type="button"
                      aria-current={p.id === currentProfile()?.id ? 'true' : undefined}
                      onClick={() =>
                        p.locked
                          ? (setTarget(p),
                            setPhrase(''),
                            setError(''),
                            setBusy(false),
                            setUnlockPhase(null),
                            setUnlockMethod(p.hasPasskey === true ? 'passkey' : 'recovery'),
                            setMode('unlock'))
                          : transition.request(
                              () => selectProfile(p),
                              currentProfile()?.id !== p.id,
                            )
                      }
                    >
                      <PersonIcon value={p.icon} />
                      <span className="profile-row-identity">
                        <strong>{p.name}</strong>
                        <small>
                          {p.locked ? 'Locked' : p.placebo ? 'Placebo account' : 'Private profile'}
                        </small>
                      </span>
                      <small className="profile-storage">
                        {formatStorageBytes(p.storageBytes)}
                      </small>
                    </button>
                    {!p.locked && (
                      <div
                        className="profile-management-actions"
                        role="group"
                        aria-label={`Actions for ${p.name}`}
                      >
                        {setupNeedsAttention && (
                          <div className="profile-action-setup">
                            <h3 id={`profile-setup-heading-${p.id}`}>Setup incomplete</h3>
                            {!hasWorkingPasskey && (
                              <p className="profile-action-guidance">
                                Add a passkey for primary access. Your recovery key remains
                                available as a fallback.
                              </p>
                            )}
                          </div>
                        )}
                        <section
                          className="profile-action-group profile-action-access"
                          aria-labelledby={
                            setupNeedsAttention ? `profile-setup-heading-${p.id}` : undefined
                          }
                          aria-label={setupNeedsAttention ? undefined : 'Profile access'}
                        >
                          <div
                            className={`profile-action-row profile-action-top profile-action-count-${Math.min(3, topActionCount)}`}
                          >
                            {onboardingIncomplete && (
                              <button
                                type="button"
                                className="button primary profile-action"
                                disabled={busy}
                                onClick={() => resumeOnboarding(p)}
                              >
                                <UserRoundPen size={16} aria-hidden="true" />
                                <span>Resume setup</span>
                              </button>
                            )}
                            {!hasWorkingPasskey && (
                              <button
                                type="button"
                                className="button primary profile-action"
                                disabled={busy}
                                onClick={() => {
                                  setTarget(p);
                                  setError('');
                                  setSetupPasskeyFlow(false);
                                  setPasskeyParent('list');
                                  setMode('passkey');
                                }}
                              >
                                <KeyRound size={16} aria-hidden="true" />
                                <span>Add passkey</span>
                              </button>
                            )}
                            <button
                              type="button"
                              className="button primary profile-action profile-action-lock"
                              disabled={busy}
                              onClick={() => void lock(p)}
                            >
                              <LockKeyhole size={16} aria-hidden="true" />
                              <span>Lock profile</span>
                            </button>
                            {hasRegisteredPasskeys && (
                              <button
                                type="button"
                                className="button secondary profile-action"
                                disabled={busy}
                                onClick={() => {
                                  setTarget(p);
                                  setError('');
                                  setSetupPasskeyFlow(false);
                                  setMode('passkeys');
                                }}
                              >
                                <KeyRound size={16} aria-hidden="true" />
                                <span>Manage passkeys</span>
                              </button>
                            )}
                          </div>
                        </section>
                        <details className="profile-danger-zone">
                          <summary>Danger Zone</summary>
                          <div className="profile-danger-zone-actions">
                            <button
                              type="button"
                              className="button secondary profile-action"
                              disabled={busy}
                              onClick={() => openStorage(p)}
                            >
                              <HardDrive size={16} aria-hidden="true" />
                              <span>View storage</span>
                            </button>
                            <button
                              type="button"
                              className="button secondary profile-action"
                              disabled={busy}
                              onClick={() => {
                                setSetup(null);
                                setAck(false);
                                setPhrase('');
                                setCopyFrom(p.id);
                                setName(`${p.name} copy`);
                                setIcon(p.icon || 'person');
                                setPlacebo(false);
                                setMode('create');
                              }}
                            >
                              <Copy size={16} aria-hidden="true" />
                              <span>Copy profile</span>
                            </button>
                            <button
                              type="button"
                              className="button secondary profile-action profile-action-delete"
                              disabled={busy}
                              onClick={() => {
                                setTarget(p);
                                setName('');
                                setMode('delete');
                              }}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                              <span>Delete profile</span>
                            </button>
                          </div>
                        </details>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <ArchiveStorageSummary />
            <button
              className="button primary"
              onClick={() => {
                setMode(setup ? 'recovery' : 'create');
                if (!setup) {
                  setName('');
                  setFullName('');
                  setSetupBirthDate('');
                  setCopyFrom(undefined);
                }
                setError('');
              }}
            >
              <Plus size={16} /> {setup ? 'Continue profile setup' : 'Create profile'}
            </button>
            <label className="text-link">
              Resume with recovery file
              <input
                className="sr-only"
                type="file"
                accept="application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void resume(file);
                }}
              />
            </label>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
        {mode === 'create' && (
          <div className="profile-management">
            <fieldset className="profile-setup-details" disabled={busy || !!setup}>
              <label className="profile-management-field">
                Display name
                <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </label>
              {!copyFrom && !placebo && (
                <>
                  <label className="profile-management-field">
                    Your name
                    <input
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      autoComplete="name"
                      required
                      maxLength={200}
                    />
                  </label>
                  <label className="profile-management-field">
                    Date of birth
                    <input
                      type="date"
                      value={setupBirthDate}
                      onChange={(e) => setSetupBirthDate(e.target.value)}
                      autoComplete="bday"
                      required
                      max={new Date().toISOString().slice(0, 10)}
                    />
                  </label>
                  <p>
                    Your display name can be different. This name is added to your Names; it and
                    your date of birth help check whose records you upload.
                  </p>
                </>
              )}
              <PersonIconPicker
                value={icon}
                onChange={setIcon}
                backLabel="Back to profile details"
              />
              <label>
                <input
                  type="checkbox"
                  checked={placebo}
                  onChange={(e) => setPlacebo(e.target.checked)}
                />{' '}
                Create Placebo account with invented records
              </label>
            </fieldset>
            {setup && (
              <p>
                Your recovery key is already created. Continue with the same key; you can update
                profile details from Self after opening it.
              </p>
            )}
            <button
              className="button primary"
              disabled={
                busy ||
                !name.trim() ||
                (!setup &&
                  !copyFrom &&
                  !placebo &&
                  (!validOnboardingFullName(fullName) || !validOnboardingBirthDate(setupBirthDate)))
              }
              onClick={() => void start()}
            >
              Continue to recovery key
            </button>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
        {mode === 'recovery' && setup && (
          <div className="profile-management">
            <p>
              Save this recovery key somewhere safe. It can open your profile without a passkey.
            </p>
            <textarea
              className="recovery-phrase"
              readOnly
              value={setup.recoveryKit.phrase}
              aria-label="Recovery key"
            />
            <a
              className="button secondary"
              download={`circus-health-${setup.profileId}-recovery.json`}
              href={`data:application/json,${encodeURIComponent(JSON.stringify(setup.recoveryKit))}`}
            >
              Download recovery key
            </a>
            <label>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I
              have saved my recovery key
            </label>
            <button className="button primary" disabled={!ack || busy} onClick={chooseRecovery}>
              Verify recovery key
            </button>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
        {mode === 'unlock' && target && unlockMethod === 'passkey' && (
          <div className="profile-management profile-unlock-passkey">
            {unlockPhase && (
              <LoadingIndicator
                label={
                  unlockPhase === 'saving'
                    ? 'Opening profile…'
                    : 'Approve in your password manager.'
                }
                layout="panel"
              />
            )}
            {error && <p role="alert">{error}</p>}
            {!unlockPhase && (
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={unlockPasskey}
              >
                <KeyRound size={17} aria-hidden="true" />
                {error ? 'Try passkey again' : 'Use passkey'}
              </button>
            )}
            <button
              className="text-link profile-unlock-switch"
              type="button"
              disabled={unlockPhase === 'saving'}
              onClick={useRecovery}
            >
              Use recovery key
            </button>
          </div>
        )}
        {((mode === 'verify' && setup) ||
          (mode === 'unlock' && target && unlockMethod === 'recovery')) && (
          <form
            id="profile-open-form"
            className="profile-management"
            method="post"
            action="/"
            autoComplete="on"
            onSubmit={(event) => {
              event.preventDefault();
              const recovery = String(new FormData(event.currentTarget).get('password') || '');
              setPhrase(recovery);
              if (mode === 'verify') void verify(recovery);
              else void unlock(recovery);
            }}
          >
            <label htmlFor="recovery-username" style={{ display: 'none' }}>
              Username
            </label>
            <input
              style={{ display: 'none' }}
              id="recovery-username"
              type="text"
              name="username"
              autoComplete="username"
              value={mode === 'verify' ? setupName : target?.name || ''}
              readOnly
            />
            <label className="profile-management-field" htmlFor="recovery-password">
              Recovery key
              <input
                id="recovery-password"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                disabled={busy}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoFocus
              />
            </label>
            {mode === 'verify' && (
              <label className="text-link">
                Verify with recovery file
                <input
                  className="sr-only"
                  type="file"
                  accept="application/json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void verifyFile(file);
                  }}
                />
              </label>
            )}
            <button className="button primary" type="submit" disabled={busy}>
              Open profile
            </button>
            {busy && (
              <LoadingIndicator
                label={mode === 'verify' ? 'Creating profile…' : 'Opening profile…'}
                layout="panel"
              />
            )}
            {mode === 'unlock' && (
              <button
                className="text-link profile-unlock-switch"
                type="button"
                disabled={busy}
                onClick={() => void unlockPasskey()}
              >
                Use passkey instead
              </button>
            )}
            {error && <p role="alert">{error}</p>}
          </form>
        )}
        {mode === 'recovery-choice' && (
          <div className="profile-management">
            <p>Use a passkey for everyday access. Keep your recovery key as a fallback.</p>
            <div className="profile-management-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => (setupPasskeyFlow ? leavePasskey() : close(false, true))}
              >
                Skip
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => {
                  setPasskeyParent('recovery-choice');
                  setMode('passkey');
                }}
              >
                {target?.hasPasskey ? 'Add another passkey' : 'Add passkey'}
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
        {mode === 'delete' && target && (
          <div className="profile-management">
            <p>
              Type <strong>{target.name}</strong> to permanently delete this encrypted profile.
            </p>
            <label className="profile-management-field">
              Profile name
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <button
              className="button primary"
              disabled={busy || name.trim() !== target.name}
              onClick={() => void remove()}
            >
              Delete profile
            </button>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
        {mode === 'passkey' && (
          <div className="profile-management">
            {busy && (
              <LoadingIndicator
                label={
                  passkeyPhase === 'saving'
                    ? 'Saving passkey…'
                    : passkeyPhase === 'confirming'
                      ? 'Confirm your passkey…'
                      : 'Creating passkey…'
                }
                layout="panel"
              />
            )}
            {error && <p role="alert">{error}</p>}
            <div className="profile-management-actions">
              <button
                ref={skipPasskeyButton}
                className="button secondary"
                disabled={busy && passkeyPhase === 'saving'}
                onClick={skipPasskey}
              >
                Skip
              </button>
            </div>
          </div>
        )}
        {mode === 'passkeys' && (
          <div className="profile-management">
            <p>
              Each saved passkey can unlock this profile at its address. Your recovery key still
              works if you remove every passkey.
            </p>
            {busy && !editingPasskeyId && (
              <LoadingIndicator label="Loading passkeys…" layout="panel" />
            )}
            {!busy && !savedPasskeys.length && !error && <p>No saved passkeys.</p>}
            <ul className="profile-passkey-list">
              {savedPasskeys.map((key) => (
                <li key={key.id}>
                  <div>
                    <strong>{key.label || 'Passkey'}</strong>
                    <p>{key.rpID}</p>
                    <p>Created {passkeyDate(key.createdAt)}</p>
                    <p>
                      {key.lastUsedAt
                        ? `Last used ${passkeyDate(key.lastUsedAt)}`
                        : 'No recorded use'}
                    </p>
                  </div>
                  <div className="profile-passkey-actions">
                    <button
                      ref={(button) => {
                        if (button) renameButtons.current.set(key.id, button);
                        else renameButtons.current.delete(key.id);
                      }}
                      className="button secondary"
                      disabled={busy || editingPasskeyId !== null}
                      onClick={() => setEditingPasskeyId(key.id)}
                      aria-label={`Rename ${key.label || 'passkey'}`}
                    >
                      <Pencil size={16} />
                      Rename
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy || editingPasskeyId !== null}
                      onClick={() => {
                        setRemovingPasskey(key);
                        setError('');
                        setMode('remove-passkey');
                      }}
                      aria-label={`Remove ${key.label || 'passkey'}`}
                    >
                      <Trash2 size={16} />
                      Remove
                    </button>
                  </div>
                  {editingPasskeyId === key.id && target && (
                    <PasskeyNameEditor
                      key={`${target.id}:${key.id}`}
                      profileId={target.id}
                      passkey={key}
                      onBusyChange={setBusy}
                      onCancel={() => {
                        setEditingPasskeyId(null);
                        requestAnimationFrame(() => renameButtons.current.get(key.id)?.focus());
                      }}
                      onSaved={(label) => {
                        setSavedPasskeys((keys) =>
                          keys.map((saved) => (saved.id === key.id ? { ...saved, label } : saved)),
                        );
                        setEditingPasskeyId(null);
                        requestAnimationFrame(() => renameButtons.current.get(key.id)?.focus());
                        notifySuccess('Passkey renamed.');
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
            <button
              className="button primary"
              disabled={busy || editingPasskeyId !== null}
              onClick={() => {
                setPasskeyParent('passkeys');
                setSetupPasskeyFlow(false);
                setError('');
                setMode('passkey');
              }}
            >
              <KeyRound size={16} />
              Add another passkey
            </button>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
        {mode === 'remove-passkey' && removingPasskey && (
          <div className="profile-management">
            <p>
              Remove <strong>{removingPasskey.label || 'Passkey'}</strong> for{' '}
              <strong>{removingPasskey.rpID}</strong>, created{' '}
              {passkeyDate(removingPasskey.createdAt)}?
            </p>
            <p>
              This passkey will no longer unlock this profile. Your other passkeys and recovery key
              will still work. Its entry in your password manager is not deleted.
            </p>
            <button
              className="button secondary profile-action-delete"
              disabled={busy}
              onClick={() => void removeSavedPasskey()}
            >
              Remove passkey
            </button>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
        {mode === 'storage' && (
          <div className="profile-management">
            <ProfileStorage />
          </div>
        )}
        {mode === 'onboarding' && (
          <div className="profile-management profile-management-onboarding">
            <p>
              Step {step + 1} of {onboardingKeys.length}
            </p>
            {step === 0 && (
              <>
                <h3 className="profile-management-care-heading">
                  <Stethoscope size={24} aria-hidden="true" /> Primary care provider
                </h3>
                <p>Optional. You can update this person later.</p>
                <div
                  className="profile-management-care-contact"
                  role="group"
                  aria-label="Primary care provider details"
                >
                  <label className="profile-management-field">
                    Primary care provider
                    <input
                      value={primaryCare}
                      onChange={(e) => setPrimaryCare(e.target.value)}
                      placeholder="Provider’s name"
                    />
                  </label>
                  <label className="profile-management-field">
                    Primary care provider phone
                    <input
                      type="tel"
                      maxLength={200}
                      value={primaryCarePhone}
                      onChange={(e) => setPrimaryCarePhone(e.target.value)}
                      placeholder="Optional phone number"
                    />
                  </label>
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <h3 className="profile-management-care-heading">
                  <HeartHandshake size={24} aria-hidden="true" /> Emergency contact
                </h3>
                <p>Optional. Someone you trust, such as a loved one.</p>
                <div
                  className="profile-management-care-contact"
                  role="group"
                  aria-label="Emergency contact details"
                >
                  <label className="profile-management-field">
                    Emergency contact
                    <input
                      value={emergencyContact}
                      onChange={(e) => setEmergencyContact(e.target.value)}
                      placeholder="Contact’s name"
                    />
                  </label>
                  <label className="profile-management-field">
                    Emergency contact phone
                    <input
                      type="tel"
                      maxLength={200}
                      value={emergencyContactPhone}
                      onChange={(e) => setEmergencyContactPhone(e.target.value)}
                      placeholder="Optional phone number"
                    />
                  </label>
                </div>
              </>
            )}
            <div className="profile-management-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void finishOnboarding(true)}
              >
                Skip for now
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void finishOnboarding(false)}
              >
                {step === onboardingKeys.length - 1 ? 'Finish setup' : 'Save and continue'}
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
        {transition.dialog}
      </NoteDialog>
    </>
  );
}
