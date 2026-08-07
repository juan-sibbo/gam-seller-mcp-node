# ADR-4 — Separación entre integridad y dato identificativo en el registro

**Estado:** DECIDIDA — Opción B  
**Fecha:** 2026-08-07  
**Bloquea:** H1 (cobertura del hash), H2 (carga del ledger), persistencia, rotación  
**Autor:** elaborado por Claude Code a partir de auditoría del código real (v0.8.3)

---

## 1. Contexto

El registro de auditoría es hash-chained: cada entrada incluye el hash SHA-256 de la
anterior, de modo que cualquier modificación retrospectiva rompe la cadena. Ese es el
mecanismo de tamper-evidence.

La AEPD advierte, en sus orientaciones de febrero de 2026 sobre IA agéntica, que los
registros excesivos son en sí mismos un riesgo de privacidad. Nuestro registro empuja en
la dirección contraria a la minimización. La pregunta que cualquier DPO competente formula
en el minuto tres es:

> **¿Cómo se atiende una supresión (Art. 17 RGPD) sobre un libro diseñado para no poder
> alterarse?**

La respuesta determina qué campos entran en el hash y en qué forma. Por eso ADR-4 va
antes que cualquier reparación del hash: reparar primero y decidir después significaría
hacer el trabajo dos veces.

---

## 2. Lo que ya está resuelto (no es decisión de este ADR)

La auditoría del código v0.8.3 revela que la arquitectura de separación ya existe e
implementa la respuesta correcta a la pregunta del DPO:

```
src/audit/pseudonym.ts — PseudonymService
```

**Crypto-shredding por comprador:**
- Cada comprador tiene una clave HMAC propia generada en su primera aparición
  (`pseudonym.ts:125`).
- El `buyer_id` que entra en el ledger es `HMAC(clave_comprador, buyer_id)` — nunca el
  identificador en claro.
- Para atender una supresión Art. 17: se destruye la clave del comprador (`shred()`
  en `pseudonym.ts:82`). El pseudónimo en la cadena queda como ruido opaco sin referente.
  La cadena **no se toca** y **sigue verificando**.
- Un comprador que reaparece después del shred recibe una clave nueva, desvinculada de
  su historial anterior.

**La respuesta al DPO es:** "No borramos el libro; destruimos la llave que hace legible
quién figura en él. El libro acredita que las operaciones existieron; quién las hizo deja
de ser recuperable."

Este mecanismo **ya está implementado, probado y es la decisión correcta**. No requiere
ser rediseñado.

---

## 3. El hueco que SÍ requiere decisión

### 3.1 Descripción exacta

`hashEntry()` (`audit/event.ts:43-51`) calcula el hash sobre:

```
{ seq, event_class, payload, prev_hash, timestamp }
```

La entrada `AuditEvent` tiene además dos campos que **no entran en el hash**:

```typescript
buyer_id?: string;    // pseudónimo HMAC — fuera del hash
request_id?: string;  // ID de correlación — fuera del hash
```

Consecuencia: alguien con acceso de escritura al archivo del ledger puede modificar estos
dos campos sin romper la verificación de la cadena. Puede, por ejemplo, intercambiar el
`buyer_id` de una entrada con el de otra — ambos serían pseudónimos válidos de distintos
compradores bajo distintas claves — y `replayVerify()` no lo detectaría.

### 3.2 Por qué esto importa

| Escenario | Detectado por la cadena actual |
|-----------|-------------------------------|
| Modificar `seq`, `event_class`, `payload`, `timestamp` | ✅ Sí |
| Modificar `prev_hash` | ✅ Sí |
| Modificar `buyer_id` (top-level) o `request_id` | ❌ No |

El `buyer_id` en el `payload` de ciertos eventos **sí** entra en el hash (porque
`pseudonymizePayload()` lo incluye en `safePayload` antes de `hashEntry()`). Pero el
campo top-level es un campo de conveniencia para consultas — y ese no está cubierto.

### 3.3 Nota sobre `request_id`

`request_id` es el ID de correlación que el comprador proporciona como parámetro opcional
(`client_request_id` en la herramienta). No es dato personal en sentido estricto en el
contexto B2B, pero es correlable con la actividad del comprador. Tampoco está cubierto
por el hash.

---

## 4. Las opciones

### Opción A — Incluir `buyer_id` (pseudónimo) y `request_id` en el hash (RECOMENDADA)

Cambio en `hashEntry()`:

```typescript
export function hashEntry(
  seq: number,
  event_class: EventClass,
  payload: Record<string, unknown>,
  prev_hash: string,
  timestamp: string,
  buyer_id: string | undefined,   // nuevo
  request_id: string | undefined  // nuevo
): string {
  const canonical = JSON.stringify({
    seq, event_class, payload, prev_hash, timestamp, buyer_id, request_id
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
```

**¿El crypto-shredding sigue funcionando?** Sí. Lo que entra en el hash es el pseudónimo
(`psn_<hmac>`), no el `buyer_id` en claro. Destruir la clave del comprador hace que el
pseudónimo sea irresolvable, pero el valor sigue siendo el mismo en el hash — la cadena
**sigue verificando**. La diferencia es que ahora no se puede intercambiar ese pseudónimo
por otro sin romper el hash.

**Coste:** Cambio de firma de `hashEntry()`, `verifyEntryHash()`, y todas las llamadas.
Los fixtures de test deben regenerarse. Cualquier ledger persistido antes del cambio
**no** verificará con la nueva función — requiere una versión de transición o una carga
tolerante al schema anterior.

**Ventaja:** Cierra el único hueco de tamper-evidence que queda abierto.

---

### Opción B — Declarar el gap y no actuar

No cambiar `hashEntry()`. Documentar explícitamente en el código y en el README que los
campos top-level `buyer_id` y `request_id` son campos de conveniencia para consultas y
**no están cubiertos por la garantía de tamper-evidence** de la cadena.

**Ventaja:** Cero riesgo de migración. Ningún ledger existente queda invalidado.

**Coste:** El hueco de tamper-evidence sobre la atribución top-level queda abierto.
Cualquier DPO técnico que lea el código lo verá. No es un riesgo operativo inmediato —
requiere acceso de escritura al archivo del ledger — pero contradice lo que el README
dice sobre "cada allow/deny registrado".

---

### Opción C — Eliminar los campos top-level

Eliminar `buyer_id` y `request_id` como campos top-level de `AuditEvent`. Toda la
atribución queda dentro de `payload`, que ya está en el hash.

**Coste:** El DSR toolkit y cualquier lógica de consulta que dependa de estos campos
necesita reescribirse para buscar dentro de `payload`. Es el cambio más invasivo de los
tres.

---

## 5. Recomendación

**Opción A**, con una condición: antes de implementarla, añadir una versión de schema al
formato del ledger (`"version": 2`) de modo que `load()` pueda detectar si el archivo en
disco es pre-migración o post-migración y manejar ambos.

Secuencia de implementación segura:

1. Añadir `"version": 2` al ledger serializado (distingue el schema nuevo del viejo).
2. Modificar `hashEntry()` y `verifyEntryHash()` para incluir `buyer_id` y `request_id`.
3. Modificar `load()` para: si detecta schema sin `version` → carga sin verificar hash
   (datos pre-migración, tamper-evidence limitada) y los marca en un flag; si detecta
   `version: 2` → verifica normalmente.
4. Regenerar fixtures de test.
5. Registrar la migración como evento `RESTORE` en el ledger al arrancar con datos viejos.

Esto evita que un despliegue con datos anteriores falle al arrancar: los datos existentes
se cargan con tamper-evidence reducida y quedan marcados hasta que rotan por retención.

---

## 6. Lo que NO está en alcance de ADR-4

- La persistencia del key store de pseudónimos (actualmente archivo local, misma debilidad
  que el anchor). Eso es ADR-1 (modelo de persistencia transaccional).
- El anchor externo (cloud Object Lock). Fuera de agosto.
- La verificación de integridad en arranque (`verifyAfterRestore()`). Es H2, desbloqueado
  por este ADR pero no parte de él.
- El `load()` que falla abierto en ledger corrupto. También H2.

---

## 7. Firma requerida

Esta decisión bloquea toda implementación del Carril B. Requiere firma del owner antes de
que se escriba una línea de código de reparación del hash.

**Opciones para firmar:**

- [ ] **A** — Incluir `buyer_id` y `request_id` en el hash, con migración de schema
- [x] **B** — Declarar el gap explícitamente, no actuar sobre el hash ahora
- [ ] **C** — Eliminar campos top-level, toda atribución vía payload

**Firma:** owner (verbal, sesión 2026-08-07) **Fecha:** 2026-08-07
