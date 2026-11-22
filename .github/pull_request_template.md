## Descripción

<!-- Describe brevemente los cambios realizados -->

## Tipo de cambio

<!-- Marca con una 'x' el tipo de cambio que aplica -->

- [ ] Nueva funcionalidad (feature)
- [ ] Corrección de bug (fix)
- [ ] Refactorización (refactor)
- [ ] Documentación (docs)
- [ ] Pruebas (test)
- [ ] Otros

## Checklist

- [ ] El código sigue las convenciones del proyecto
- [ ] Se han ejecutado las pruebas y pasan correctamente (`npm run lint && npm run typecheck && npm test`)
- [ ] Se han agregado las migraciones de base de datos (si aplica)
- [ ] Si cambia un mensaje de Kafka, su contrato en faclab-core y la copia sincronizada (`npm run contracts:sync`)

## Observabilidad (definición de terminado)

<!-- faclab-core docs/architecture/OBSERVABILITY.md §10. Marca lo que aplica; si algo no aplica, explica por qué -->

- [ ] Los logs nuevos llevan `event.name` (`<dominio>.<acción>[.<resultado>]`), sin secretos ni datos personales (§4.6)
- [ ] Las operaciones nuevas tienen sus métricas en `src/shared/telemetry/metrics.ts` y en el catálogo de `test/shared/metric-attributes.test.ts`, sin ids como atributos
- [ ] Las rutas críticas nuevas o cambiadas tienen sus spans y una prueba que los fija, con su padre y su traza (`useSpans` de `test/tracing.ts`, `captureLogs` de `test/logs.ts`)
- [ ] Si el cambio trae un modo de fallo nuevo, tiene su panel o su alerta (con runbook) en `faclab-infra/observability/signoz/`
