import type { DenyReason, RequirementId, RequirementResult } from '@fiveprotect/protocol';

/**
 * Player-facing text for the block screen.
 *
 * Design document 12.2 calls this the most important screen in the product: "Secure Boot
 * ist deaktiviert" produces a support ticket, the same statement with a concrete
 * instruction does not. The text is therefore written for a player, in German, and says
 * what to do rather than what is wrong.
 *
 * Only the first blocking failure is explained. A list of five problems reads as
 * insurmountable; one problem with one instruction gets acted on.
 */

const REQUIREMENT_TEXT: Partial<Record<RequirementId, (detail?: string) => string>> = {
  secure_boot_enabled: () =>
    'Secure Boot ist deaktiviert. Starte den Rechner neu, öffne mit Entf oder F2 das ' +
    'UEFI-Menü und aktiviere unter „Boot" oder „Security" die Option Secure Boot. ' +
    'Ist der Eintrag ausgegraut, stelle den Boot-Modus zuerst von Legacy/CSM auf UEFI um.',

  hvci_enabled: (detail) =>
    detail === undefined
      ? 'Die Speicherintegrität ist abgeschaltet. Öffne Windows-Sicherheit → ' +
        'Gerätesicherheit → Kernisolierung und schalte die Speicherintegrität ein. ' +
        'Danach ist ein Neustart nötig.'
      : `Die Speicherintegrität ist abgeschaltet, weil ein Treiber sie blockiert (${detail}). ` +
        'Deinstalliere die zugehörige Software oder aktualisiere sie, und aktiviere ' +
        'danach unter Windows-Sicherheit → Gerätesicherheit → Kernisolierung die ' +
        'Speicherintegrität.',

  tpm_attestation_valid: () =>
    'Es wurde kein TPM 2.0 gefunden. Aktiviere es im UEFI-Menü — bei Intel heißt die ' +
    'Option meist „PTT" oder „Platform Trust Technology", bei AMD „fTPM". Ältere ' +
    'Mainboards ohne TPM können an diesem Server nicht teilnehmen.',

  test_signing_disabled: () =>
    'Der Testsignaturmodus von Windows ist aktiv. Öffne die Eingabeaufforderung als ' +
    'Administrator, führe „bcdedit /set testsigning off" aus und starte neu.',

  kernel_debugging_disabled: () =>
    'Das Kernel-Debugging ist aktiv. Öffne die Eingabeaufforderung als Administrator, ' +
    'führe „bcdedit /debug off" aus und starte neu.',

  driver_blocklist_enabled: () =>
    'Die Microsoft-Sperrliste für angreifbare Treiber ist deaktiviert. Aktiviere sie ' +
    'unter Windows-Sicherheit → App- & Browsersteuerung → Exploit-Schutz → ' +
    'Einstellungen für die Sperrliste angreifbarer Treiber.',

  iommu_enabled: () =>
    'Der Kernel-DMA-Schutz ist nicht aktiv. Aktiviere im UEFI-Menü die Virtualisierung ' +
    '(VT-d bei Intel, AMD-Vi bei AMD) und die Speicherintegrität in Windows.',

  game_process_present: () =>
    'FiveProtect konnte FiveM auf diesem Rechner nicht finden. Starte FiveM und FiveProtect auf ' +
    'demselben PC und versuche es erneut.',

  network_origin_matches: () =>
    'FiveProtect läuft offenbar auf einem anderen Rechner als FiveM. Beide müssen auf ' +
    'demselben PC laufen.',

  vulnerable_drivers_absent: () =>
    'Auf dem System ist ein Treiber geladen, der als angreifbar bekannt ist. ' +
    'Deinstalliere die zugehörige Software und versuche es erneut.',
};

const REASON_TEXT: Partial<Record<DenyReason, string>> = {
  companion_missing: 'FiveProtect läuft nicht. Starte die Anwendung und verbinde dich danach erneut.',
  companion_timeout:
    'FiveProtect hat nicht rechtzeitig geantwortet. Starte die Anwendung neu und versuche es ' +
    'noch einmal.',
  companion_outdated:
    'Deine FiveProtect-Version ist veraltet. Starte die Anwendung neu — sie aktualisiert sich ' +
    'selbst — und verbinde dich danach erneut.',
  attestation_invalid:
    'Die Systemprüfung war fehlerhaft. Starte FiveProtect neu und versuche es erneut.',
  nonce_expired: 'Die Prüfung hat zu lange gedauert. Versuche es einfach noch einmal.',
  nonce_reused: 'Die Prüfung war bereits abgeschlossen. Versuche es noch einmal.',
  heartbeat_lost:
    'FiveProtect hat sich während des Spiels beendet. Starte die Anwendung und verbinde dich ' +
    'erneut.',
  backend_unavailable:
    'Der Anticheat-Dienst ist gerade nicht erreichbar. Bitte versuche es in ein paar ' +
    'Minuten erneut.',
  banned: 'Dieser Account ist auf diesem Server gesperrt.',
};

/**
 * Builds the text shown to the player.
 *
 * Prefers the concrete requirement that failed over the generic reason, because
 * `policy_not_met` on its own tells a player nothing they can act on.
 */
export function buildRemediation(
  reasons: DenyReason[],
  requirements: RequirementResult[],
): string | undefined {
  const blocking = requirements.find(
    (entry) => entry.status === 'fail' || entry.status === 'unknown',
  );

  if (blocking !== undefined) {
    const text = REQUIREMENT_TEXT[blocking.requirement];
    if (text !== undefined) {
      const base = text(blocking.detail);
      return blocking.status === 'unknown'
        ? `${base}\n\nHinweis: FiveProtect konnte diesen Punkt nicht sicher auslesen. ` +
            'Wenn die Einstellung bereits stimmt, hilft meist ein Neustart von FiveProtect ' +
            'mit Administratorrechten.'
        : base;
    }
  }

  for (const reason of reasons) {
    const text = REASON_TEXT[reason];
    if (text !== undefined) return text;
  }

  return undefined;
}
