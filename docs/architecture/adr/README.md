# Architekturentscheidungen

Kurze Notizen zu Entscheidungen, deren Begründung sonst verlorengeht. Eine Datei je
Entscheidung, fortlaufend nummeriert, Format nach Michael Nygard.

Ein ADR wird nicht bearbeitet, wenn sich die Entscheidung ändert — es wird ein neues
geschrieben, das das alte ablöst. Das alte bleibt stehen und wird als `Abgelöst` markiert.

| Nr. | Titel | Status |
| --- | --- | --- |
| [0001](0001-monorepo-with-generated-protocol.md) | Monorepo mit generiertem Protokoll-Layer | Angenommen |
| [0002](0002-no-kernel-driver-in-v1.md) | Kein eigener Kernel-Treiber in Version 1 | Angenommen |
| [0003](0003-localhost-transport-for-nui-hop.md) | Localhost-Transport für den NUI-Hop | Angenommen |
| [0004](0004-server-side-verdicts.md) | Urteile entstehen ausschließlich serverseitig | Angenommen |
| [0005](0005-fail-open-by-default.md) | `fail-open` als Standardverhalten bei Backend-Ausfall | Angenommen |
| [0006](0006-tpm-attestation-key-as-hardware-identity.md) | TPM-Attestation-Key als Hardware-Identität | Angenommen |
| [0007](0007-github-workflow-and-branch-protection.md) | GitHub-Workflow und Grenzen der Branch-Absicherung | Angenommen |
| [0008](0008-schema-ir-instead-of-zod-reflection.md) | Schema-IR statt Reflexion über Zod | Angenommen, verfeinert 0001 |
| [0009](0009-dark-only-interface-with-mint-accent.md) | Dunkle Oberfläche mit Mint-Akzent und Manrope | Angenommen, ersetzt Designdokument 12.3 |
| [0010](0010-companion-collects-its-own-nonce.md) | Der Companion holt seine Nonce beim Backend ab | Angenommen, korrigiert 0003 |
| [0011](0011-companion-may-read-its-own-outcome.md) | Der Companion darf sein eigenes Ergebnis lesen | Angenommen, lockert 0004 |
