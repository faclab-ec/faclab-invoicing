# Cambios

Cada versión de faclab-invoicing y lo que trae, la más reciente arriba. Sigue
[versionado semántico](https://semver.org/lang/es/): mientras empiece por 0 (hasta el piloto), una
versión menor puede romper la compatibilidad. `scripts/release.sh` escribe cada sección a partir de
los commits convencionales de `master` (README, "Versions and releases").

Si una versión cambia lo que publica o acepta por Kafka (`schema_version`, `contracts/`) o trae una
migración que no se puede revertir, su sección lo dice en una línea **Contratos** o **Migraciones**.
Qué versiones de core, invoicing y web funcionan juntas lo dice la
[matriz de compatibilidad](https://github.com/faclab-ec/faclab-infra/blob/master/deploy/production/COMPATIBILITY.md).

## [0.1.0] - 2026-11-22

Primera versión etiquetada: todo lo construido hasta la entrega continua (S8.2). La historia anterior
está en el historial de Git.

- **Contratos:** acepta `sales.confirmed` v1 a v3 y `credit_notes.requested` v1 y v2; publica
  `invoices` v1 y `credit_notes.results` v1. API pública `/api/v1/invoices` 1.0.0.
- **Migraciones:** las nueve de `migrations/`, todas con su `Down Migration`.
