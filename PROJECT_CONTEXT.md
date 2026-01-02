# Contexto del Proyecto: App Comunicados (AppScript)

Este documento define las reglas de negocio, la estructura de datos, las relaciones y la lógica central del módulo **App Comunicados**. Está diseñado para que cualquier agente (IA o humano) comprenda el funcionamiento del sistema sin necesidad de re-analizar todos los archivos.

---

## 1. Visión General de la Arquitectura

La aplicación es un sistema web construido sobre **Google Apps Script (GAS)**.
- **Backend**: Scripts `.gs` ejecutándose en el servidor de Google. Manejan la base de datos (Google Sheets) y la lógica de negocio.
- **Frontend**: Archivos `.html` (que pueden contener CSS y JS). Se sirven mediante `HtmlService.createTemplateFromFile`.
- **Intercomunicación**: El frontend llama al backend mediante `google.script.run`.

> **CONVENCIÓN FRONTEND (.html vs .js.html)**:
> Dado que Google Apps Script solo acepta archivos `.html` para la capa de cliente (no sirve .js o .css puros):
> - La lógica de estructura se mantiene en archivos `*.html`.
> - La funcionalidad Javascript se separa en archivos `*.js.html` (que contienen tags `<script>`) y se inyectan en los HTML principales.

> **NOTA CRÍTICA SOBRE ARCHIVOS .GS**:
> En el entorno de Google Apps Script, **todos los archivos `.gs` comparten el mismo ámbito global**.
> No existen módulos ni importaciones estilo ES6.
> **Todos los archivos deben tratarse mentalesmente como si fueran uno solo concatenado.**
> Cualquier función o variable global definida en un archivo `A.gs` está disponible inmediatamente en `B.gs`.

### Puntos de Entrada
- `code.gs`: Contiene `doGet()` que carga la aplicación inicial (`index.html`).
- `include()`: Función helper en `code.gs` para modularizar el HTML (importar header, sidebar, scripts).

---

## 2. Reglas de Interacción para Agentes (CRÍTICO)

Todo agente (IA o Humano) que modifique este código está **OBLIGADO** a seguir este protocolo estrictamente.

### El Protocolo de los 7 Pasos
Antes de escribir una sola línea de código, se debe realizar un análisis detenido siguiendo estos 7 pasos:

1.  **Entendimiento Profundo**: Comprender no solo qué cambiar, sino *por qué* funciona como lo hace actualmente.
2.  **Análisis de Impacto**: Identificar todas las dependencias (funciones que llaman a lo que vas a editar).
3.  **Garantía de No-Ruptura**: Verificar que la lógica actual NO se rompa. **Lo que funciona, NO se toca** a menos que sea para refactorizar con equivalencia funcional estricta.
4.  **Compatibilidad**: Asegurar que los cambios sean retro-compatibles (e.g., si agregas un argumento, hazlo opcional).
5.  **Plan de Rollback**: Diseñar cómo revertir el cambio inmediatamente si algo falla.
6.  **Estrategia de Implementación**: Definir el código exacto a cambiar.
7.  **Revisión Final**: Auto-criticar el plan: ¿Realmente es seguro? ¿Rompe algo en el frontend (`.html`) o en el importador (`importacion.server.gs`)?

### Política de Seguridad de Código
- **Prohibido Romper**: No se permite dejar el sistema en un estado inestable.
- **Rollback Obligatorio**: Si una implementación causa errores, se debe revertir inmediatamente (Rollback) y volver a iniciar el análisis de 7 pasos.
- **Mejora Sin Destrucción**: Se permite cambiar lógica para mejorarla, pero nunca degradar la funcionalidad existente.

---

## 3. Modelo de Datos (Esquema)

La base de datos es un Google Sheet con múltiples hojas. La definición estricta está en `TABLE_DEFINITIONS` (`code.gs`).

### Entidades Principales

#### 1. Cuentas (`Referencia`)
- **Hoja**: `Referencias`
- **Rol**: Entidad padre de nivel superior. Representa una cuenta, contrato o referencia macro.
- **Clave Principal**: `id`
- **Campos Clave**: `referencia` (clave visible para usuarios), `idAjustador`.

#### 2. Comunicados
- **Hoja**: `Comunicados`
- **Rol**: Unidad central de trabajo. Pertenece a una Cuenta.
- **Clave Principal**: `id`
- **Relaciones**:
    - `idReferencia` -> `cuentas.id`
    - `idSustituido` -> `comunicados.id` (Auto-referencia para sustituciones)
- **Campos Clave**: `comunicado` (Código alfanumérico, ej: "L-01"), `status`.

#### 3. Datos Generales
- **Hoja**: `DatosGenerales`
- **Rol**: Contiene la metadata extendida de un comunicado. Relación 1:1 con Comunicados.
- **Clave Principal**: `id`
- **Relaciones**:
    - `idComunicado` -> `comunicados.id`
    - `idEstado` -> `estados.id`
    - `idDR` -> `distritosRiego.id`
    - `idSiniestro` -> `siniestros.id`
    - `idEmpresa` -> `empresas.id`
    - `idAjustador` -> `ajustadores.id` (Override del ajustador de la cuenta)
    - `idActualizacion` -> `actualizaciones.id` (Apunta a la actualización "vigente")

#### 4. Siniestros
- **Hoja**: `Siniestros`
- **Rol**: Catálogo de eventos dañinos.
- **Relaciones**:
    - `idAseguradora` -> `aseguradoras.id`

#### 5. Actualizaciones (Financiero)
- **Hoja**: `Actualizaciones`
- **Rol**: Historial de versiones financieras de un comunicado. Un comunicado tiene N actualizaciones.
- **Lógica**: Representan cambios en el presupuesto (Origen, Rev A, Rev B...).
- **Campos Clave**:
    - `consecutivo`: Orden de la actualización.
    - `esOrigen`: 1 si es la primera, 0 si son revisiones.
    - `monto`: Monto base.
    - `montoSupervisión`: Monto calculado (5% del base).
    - `idPresupuesto`: Link a desglose detallado.

#### 6. Presupuesto (Lineas)
- **Hoja**: `PresupuestoLineas`
- **Rol**: Desglose línea por línea de una Actualización.
- **Relación**: `idActualizacion` -> `actualizaciones.id`

---

## 3. Reglas de Negocio Clave

### A. Creación de Comunicados (`comunicados.crud.gs`)
1. **Unicidad**: No puede existir un comunicado con el mismo nombre (`comunicado`) dentro de la misma `idReferencia` (Cuenta).
2. **Validaciones**:
    - Nombre del comunicado: Máximo 15 caracteres.
    - Descripción: Máximo 15 caracteres (Combinación `Cuenta-Comunicado`).
    - Campos obligatorios: Referencia, Distrito, Siniestro, Fecha, Estado.
3. **Flujo de Creación**:
    - Se verifica/crea el Distrito y Siniestro en catálogos.
    - Se crea registro en `datosGenerales` primero.
    - Se crea registro en `comunicados`.
    - Si falla el comunicado, se hace rollback (borrado) de `datosGenerales`.

### B. Cálculo de Montos
- **Regla del 5%**: La Supervisión se calcula automáticamente como el 5% del monto capturado o monto base.
- **Presupuesto Vigente**: Se determina buscando la actualización con el `consecutivo` más alto para ese comunicado.
    - `Vigente = MontoCapturado (o Monto) + MontoSupervisión`

### C. Importación Batch (`importacion.server.gs`)
El sistema soporta carga masiva desde Excel/CSV con lógica compleja:
1. **Validación en Memoria**: Lee todo el CSV y valida reglas antes de escribir nada.
2. **Orden de Inserción Estricto**:
    1. Ajustadores / Aseguradoras (Nuevos)
    2. Siniestros / Distritos (Nuevos)
    3. Cuentas (Nuevas)
    4. Comunicados (Nuevos o Existentes)
    5. Datos Generales (Si es registro "ORIGEN" nuevo)
    6. Actualizaciones (Siempre se crea una nueva actualización incremental)
    7. Líneas de Presupuesto
3. **Lógica de "Origen" vs "Actualización"**:
    - Si `TIPO_REGISTRO` es "ORIGEN", intenta crear el Comunicado base y sus Datos Generales.
    - Si `TIPO_REGISTRO` es "ACTUALIZACION", busca el comunicado existente y le anexa una nueva versión financiera.

### D. Sistema CRUD (`crud.gs`)
- **Normalización**: Todas las búsquedas de texto ignoran mayúsculas/minúsculas y acentos (`normalizarTexto`).
- **IDs**: Los IDs son numéricos autoincrementales (`obtenerSiguienteId`).
- **Batch Create**: `createBatch` optimiza la inserción escribiendo bloques de filas de una sola vez para evitar timeouts de Google Apps Script.

---

## 4. Archivos Clave y Responsabilidades

| Archivo | Responsabilidad |
| :--- | :--- |
| **`code.gs`** | Configuración global, `TABLE_DEFINITIONS` (Schema), `doGet`, helpers de template. |
| **`crud.gs`** | Motor genérico de base de datos. `readRow`, `createRow`, `updateRow`, queries, batchs. |
| **`comunicados.crud.gs`** | Lógica de negocio específica para "Comunicados". Joins complejos (`enriquecerComunicado`), reglas de validación. |
| **`importacion.server.gs`** | Parser de CSV y orquestador transaccional para carga masiva. |
| **`utilidades.gs`** | Tools: Normalización de texto, manejo de fechas, mapeo de objetos. |
| **`datosGenerales.crud.gs`** | Wrapper ligero para la tabla DatosGenerales. |

---

> **Nota para Agentes**: Cuando se pida modificar la estructura de datos, SIEMPRE actualizar `TABLE_DEFINITIONS` en `code.gs`. Cuando se pida cambiar reglas de validación de comunicados, revisar `comunicados.crud.gs`.
