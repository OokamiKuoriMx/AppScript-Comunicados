/**
 * ============================================================================
 * SERVICIO DE INTELIGENCIA ARTIFICIAL (Gemini 1.5 Flash - Estable)
 * Descripción: Procesa archivos PDF usando OCR y LLM para extracción estructurada.
 * ============================================================================
 */

// Configuración - TIER DE PAGO
const GEMINI_MODEL = 'gemini-2.0-flash';  // Modelo estable para producción (con facturación)
const MAX_RETRIES = 5;                     // Reintentos para errores de validación/parseo
const MAX_RATE_LIMIT_RETRIES = 3;          // Reintentos para Rate Limit (menos necesarios con pago)
const BASE_COOLDOWN_MS = 1000;             // 1 segundo entre archivos (tier de pago tiene límites altos)
const BASE_429_WAIT_MS = 5000;             // 5 segundos base si hay 429 (raro con pago)

// =============================================================================
// FRAGMENTOS DEL PROMPT MODULAR (v7.0)
// =============================================================================

/**
 * PASOS DE EXTRACCIÓN FINANCIERA (Comunes para Origen y Actualización)
 * Corresponde a los pasos de sabueso geográfico, consolidación y output
 */
const PROMPT_CORE_EXTRACTION = `
### PASO 5: Análisis de Presupuestos (Sabueso Geográfico)
*Objetivo: Extraer montos y asignarles su identidad geográfica correcta.*

* **5.0 EXCLUSIONES CRÍTICAS (ANTI-ALUCINACIÓN):**
    - **IGNORA FORMATOS DE CAMPO:** Si encuentras tablas manuscritas tituladas "FORMATO DE INSPECCIÓN", "LEVANTAMIENTO", "CROQUIS" o "BITÁCORA", **IGNÓRALAS**. No son presupuestos financieros.
    - **IGNORA DATOS LOGÍSTICOS:** No extraigas dimensiones (metros, espesores) como importes monetarios.
    - **LENGUAJE DE RECHAZO:** Si el texto dice "no estaríamos en condiciones de modificar las cantidades", "no procede", "no cuenta con soporte" y NO hay una nueva tabla de presupuesto formal impresa:
        -> **NO EXTRAIGAS NADA**. Devuelve una lista de líneas vacía [].
        -> Esto clasificará el documento como **INFORMATIVO**.

* **5.1 Estrategia de Fuente Dual (CRÍTICO):**
    - **NO TE DETENGAS EN EL RESUMEN.** Debes escanear el documento completo.
    - **FUENTE 1: TABLA RESUMEN (Validación):**
        - Úsala SOLO para detectar si una categoría completa (Daño Físico o Desazolve) está en **$0.00**.
        - Si aquí dice $0.00, eso confirma que NO hay cambios para esa categoría en todo el reporte.
    - **FUENTE 2: TABLA DETALLADA / GENERADORA (Extracción):**
        - Busca tablas tituladas "Hoja Generadora", "Cédula", "Anexo", "Desglose", "Ubicación Específica", "Localización", "Sitio" o "Tramo".
        - **PRIORIDADES DE BÚSQUEDA:**
            - Prioridad A: Declaraciones explícitas en texto: "estimar un monto preliminar de...".
            - Prioridad B: Tablas con columna "UBICACIÓN" o "CONCEPTO" geográfico.
            - Prioridad C: "HOJA GENERADORA" o "CÉDULA DE CUANTIFICACIÓN".
            - Prioridad D: Cualquier tabla con coordenadas (km, GPS) o nombres de tramos.
        - **ESTA ES LA ÚNICA FUENTE VÁLIDA** para extraer ubicaciones y sus importes.
        - Si extraes conceptos genéricos como "Preliminares" o "Terracerías", **ESTÁS EN LA TABLA INCORRECTA**. Busca el desglose geográfico.

* **5.2 Mapeo de Columnas:**
    - Identifica columna Infraestructura ("Importe", "Daño Físico", "Total") e identifica columna Desazolve ("Limpieza", "Desazolve").

* **5.3 Identidad Geográfica (CRÍTICO):**
    - Antes de extraer, define el SITIO. 
    - Si es Hoja Generadora y la fila dice "Cemento", **MIRA ARRIBA** (encabezado \`UBICACIÓN:\`).
    - Usa el sitio, no el material.
    - **PRESERVAR SUFIJOS DISTINTIVOS:** Si el nombre incluye "(Continuación)", "(Tramo X)", "(Sección Y)" o "(Parte Z)", MANTENLO como parte del concepto. Son ubicaciones DISTINTAS.
    - Ejemplo: "Canal Principal Cuxtepeques" ≠ "Canal Principal Cuxtepeques (Continuación)". Son 2 conceptos separados.

* **5.4 Extracción de DAÑO FÍSICO:**
    - Identifica la columna "Importe daño físico".
    - **REGLA DE EXISTENCIA:** Solo extrae el valor si la fila corresponde explícitamente a la ubicación (Concepto) que estás analizando.
    - **MANEJO DE VALOR:**
        - Si la celda dice "$0.00": Extrae \`0\` (Cero Numérico).
        - Si la celda está vacía o la ubicación no aparece: No generes extracción para este campo.
    - Crea registro "DAÑO FISICO" solo si encontraste un valor explícito (incluyendo 0).

* **5.5 Extracción de DESAZOLVES:**
    - Identifica la columna "Importe Remoción/Desazolves".
    - **REGLA DE EXISTENCIA:** Mismo criterio. Solo extrae si la ubicación está presente en la tabla.
    - **MANEJO DE VALOR:**
        - Si la celda dice "$0.00": Extrae \`0\`.
        - Si existe un valor: Extráelo.
    - Crea registro "DESAZOLVES" solo si encontraste un valor explícito.

* **5.6 Separación de Líneas (Split Multiplicativo):**
    - Si una fila tiene columnas para Daño Físico y Desazolves, **DEBES DUPLICAR** la extracción.
    - **MANDATO MATEMÁTICO**: Si hay 10 ubicaciones en la tabla y ambas columnas existen, tu output debe tener **20 líneas** (10 de daño + 10 de desazolve).
    - Nunca sumes los importes. Genera dos objetos independientes con la misma ubicación.

* **5.7 Extracción Narrativa (PRIORIDAD D - Modo Rescate):**
    - Si no hay tablas claras, busca montos en el texto: "asciende a MX$[Monto]".
    - ASÍGNALO SIEMPRE A **"DAÑO FISICO"** salvo que diga explícitamente "limpieza".

### PASO 6: Consolidación y Limpieza
*Objetivo: Refinar los datos crudos extraídos.*

* **6.0 Preservación de Sufijos Distintivos (ANTES DE AGREGAR):**
    - **NUNCA FUSIONES** conceptos que tengan sufijos como "(Continuación)", "(Tramo)", "(Sección)", "(Parte)".
    - "Canal X" y "Canal X (Continuación)" son ubicaciones DIFERENTES. Mantén ambos por separado.

* **6.1 Agregación de Generadoras:**
    - Si extrajiste datos de "Hojas Generadoras" (10 filas de materiales para 1 ubicación), **AGRUPA Y SUMA**.
    - El output debe tener una sola línea por \`Concepto\` con la suma total.
    - **EXCEPCIÓN:** No agregues conceptos con sufijos distintivos (Continuación, Tramo, Sección) - son ubicaciones distintas.

* **6.2 Discriminación de Columnas:**
    - Descarta valores de "Anterior" y conserva solo "Actual/Revisado".

* **6.3 Normalización Numérica:**
    - Elimina \`$\`, comas \`,\`. Convierte a Float.

* **6.4 Entity Resolution de Conceptos:**
    - Si el concepto se parece a uno de la lista de "CONCEPTOS EXISTENTES" (Contexto), USA EL NOMBRE DE LA LISTA.
    - Normaliza: "UR" → "Unidad de Riego", "DR" → "Distrito de Riego".
    - **PRESERVAR:** Mantén "(Continuación)" y similares aunque no estén en la lista.

### PASO 7: Integración Final y Auditoría
* **7.1 Ensamble del Header:** Compila \`refAjustador\`, \`comunicadoId\`, \`fechaDoc\`.
* **7.2 Cálculo Matemático:** Verifica que la suma de líneas coincida (con tolerancia de $1) con el total del documento.
* **7.3 Validación Estructural:** Asegura que no falten llaves obligatorias.

### PASO 8: Output (JSON Estricto)
*Objetivo: Generar el entregable final.*

\`\`\`json
{
  "header": {
    "refCta": "string",
    "comunicadoId": "string",
    "tipoRegistro": "ORIGEN|Actualización",
    "descripcion": "string",
    "fechaDoc": "YYYY-MM-DD",
    "totalPdf": 0.00,
    "advertencias": ["string"]
  },
  "lineas": [
    {
      "id_bd": null,
      "concepto": "string",
      "categoria": "DAÑO FISICO|DESAZOLVES",
      "accion": "ACTUALIZAR|MANTENER|CANCELAR|CREAR", 
      "importe": 0.00
    }
  ]
}
\`\`\`
`;

/**
 * Procesa un PDF en Base64 y devuelve los datos estructurados.
 * NUEVO: Usa Gemini multimodal directamente (sin Drive OCR).
 * @param {object|string} payload - Objeto {content, filename, existingConcepts} o content string (legacy).
 * @param {string} [optFilename] - Filename si payload es string.
 * @returns {object} Resultado estructurado { header, lineas, validacion, metadata }.
 */
function procesarPdfIA(payload, optFilename) {
    let base64Content = payload;
    let filename = optFilename || 'documento_desconocido.pdf';

    if (payload && typeof payload === 'object' && payload.content) {
        base64Content = payload.content;
        filename = payload.filename || filename;
    }

    const contexto = `procesarPdfIA(${filename})`;

    // [INYECCIÓN DE CONTEXTO DESDE NOMBRE DE ARCHIVO]
    // Intentar inferir RefCta antes de cargar conceptos para poder filtrar el contexto
    if (!payload) payload = {};
    if ((!payload.refCta || !payload.comunicadoId) && filename) {
        try {
            // Regex para: GL098774-L50A.pdf o similar
            const nameMatch = filename.match(/^([A-Z0-9]+)-(L\d+[A-Z]*).*/i);
            if (nameMatch) {
                if (!payload.refCta) payload.refCta = nameMatch[1].toUpperCase();
                if (!payload.comunicadoId) payload.comunicadoId = nameMatch[2].toUpperCase();
                console.log(`[${contexto}] Metadata inferida de archivo: Ref=${payload.refCta}, Com=${payload.comunicadoId}`);
            }
        } catch (eParse) { console.warn(`[${contexto}] Error parseando nombre: ${eParse.message}`); }
    }

    // Batch de resultados ya procesados (para buscar registros relacionados)
    const batchResults = (payload && payload.batchResults) || [];

    // Modificación Step 2: Inyectar Diccionario Maestro (SCOPED)
    let cache = (payload && payload.cache) || null;
    let existingConcepts = (payload && payload.existingConcepts) || [];

    // Cargar cache si no existe
    if (!cache) {
        try { cache = _loadCatalogsCache(); } catch (e) { console.warn('Error cargando cache:', e); }
    }

    // [FIX] SOLO Cargar conceptos de la cuenta actual (si se conoce)
    // Eliminamos la carga GLOBAL para evitar contaminación de contextos.
    if (existingConcepts.length === 0 && payload.refCta) {
        existingConcepts = cargarConceptosPorRefCta(payload.refCta);
        console.log(`[procesarPdfIA] Inyectados ${existingConcepts.length} conceptos del contexto ${payload.refCta}.`);
    } else if (existingConcepts.length === 0) {
        console.log(`[procesarPdfIA] Sin contexto de cuenta (RefCta desc). No se inyectaron conceptos.`);
    }

    try {
        // === PASADA 1: Extracción Rápida de Identificadores ===
        // Si no tenemos refCta y comunicadoId seguros, extraerlos del PDF primero
        if (!payload.refCta || !payload.comunicadoId) {
            console.log(`[${contexto}] Ejecutando Pasada 1: Extracción rápida de identificadores...`);
            const identificadores = _extraerIdentificadoresRapido(base64Content, filename);

            if (identificadores && identificadores.refAjustador) {
                payload.refCta = identificadores.refAjustador;
                payload.comunicadoId = identificadores.comunicadoId;
                // NUEVO: Guardar header de Fase 1 para completar campos vacíos después
                payload._headerFase1 = identificadores.header || {};
                console.log(`[${contexto}] ✓ Pasada 1 exitosa: Ref=${payload.refCta}, Com=${payload.comunicadoId}`);

                // Cargar conceptos ahora que tenemos refCta seguro
                if (existingConcepts.length === 0) {
                    existingConcepts = cargarConceptosPorRefCta(payload.refCta);
                    console.log(`[${contexto}] Inyectados ${existingConcepts.length} conceptos post-Pasada1.`);
                }
            } else {
                console.warn(`[${contexto}] Pasada 1 falló. Continuando sin contexto seguro.`);
            }
        }

        // === CONSULTA BD: Obtener contexto preciso con formato {header, lineas} ===
        // ACTUALIZADO: _consultarContextoBD ahora retorna {registros, expectedLines}
        let registrosContextoBD = [];
        let expectedLines = []; // NUEVO: Líneas esperadas para Schema Injection

        if (payload.refCta && payload.comunicadoId && cache) {
            const contextoBD = _consultarContextoBD(payload.refCta, payload.comunicadoId, cache);
            registrosContextoBD = contextoBD.registros || [];
            expectedLines = contextoBD.expectedLines || [];
            console.log(`[${contexto}] Contexto BD: ${registrosContextoBD.length} registros, ${expectedLines.length} líneas esperadas`);
        }

        // Loop de Intentos con Auto-Corrección (PASADA 2)
        let intentos = 0;
        let lastError = null;
        let resultadoFinal = null;
        let esOrigen = expectedLines.length === 0; // Declarar ANTES del while para uso en post-procesamiento

        while (intentos < MAX_RETRIES) {
            intentos++;
            console.log(`[${contexto}] Intento AI #${intentos}...`);

            try {
                // Llamada API con PDF multimodal (sin OCR previo)
                // INYECCIÓN DE CATÁLOGOS (RAG Ligero)
                let catalogsContext = {};
                try {
                    if (!cache) {
                        cache = _loadCatalogsCache();
                    }

                    catalogsContext = {
                        ajustadores: [...new Set(cache.ajustadores.map(a => a.nombre || a.nombreAjustador).filter(Boolean))],
                        siniestros: [...new Set(cache.siniestros.map(s => s.siniestro).filter(Boolean))],
                        fenomenos: [...new Set(cache.siniestros.map(s => s.fenomeno).filter(Boolean))],
                        distritos: [...new Set(cache.distritosRiego.map(d => d.distritoRiego).filter(Boolean))],
                        aseguradoras: [...new Set(cache.aseguradoras.map(a => a.aseguradora || a.nombre).filter(Boolean))],
                        // Cargar estados desde la tabla estados de la BD
                        estados: [...new Set(cache.estados.map(e => e.estado || e.nombre).filter(Boolean))]
                    };
                } catch (errCatalogs) {
                    console.warn(`[${contexto}] No se pudieron cargar catálogos para contexto AI:`, errCatalogs);
                }

                // COMBINAR CONTEXTO: BD + Batch (formato unificado {header, lineas})
                // registrosContextoBD ya está calculado arriba con el nuevo formato
                // También agregar registros del batch actual que tengan la misma refCta
                let registrosContextoUnificado = [...registrosContextoBD];

                // [FIX] Extraer familia actual para filtro de aislamiento RF8
                const familiaActual = _extractFamily(payload.comunicadoId);
                console.log(`[${contexto}] Familia actual: ${familiaActual}`);

                if (batchResults && batchResults.length > 0 && payload.refCta) {
                    const refClean = String(payload.refCta).toUpperCase().trim();
                    const batchRelevantes = batchResults
                        .filter(r => {
                            const rRef = String(r.rawPayload?.header?.refCta || r.header?.refCta || '').toUpperCase().trim();
                            // [FIX] Filtrar por familia además de referencia
                            const rComId = r.rawPayload?.header?.comunicadoId || r.header?.comunicadoId || '';
                            const rFamilia = _extractFamily(rComId);
                            return rRef === refClean && rFamilia === familiaActual;
                        })
                        .map(r => ({
                            header: r.rawPayload?.header || r.header || {},
                            lineas: r.rawPayload?.lineas || r.lineas || []
                        }));

                    registrosContextoUnificado.push(...batchRelevantes);
                    console.log(`[${contexto}] Agregados ${batchRelevantes.length} registros del batch (familia ${familiaActual}) al contexto`);

                    // =====================================================================
                    // FIX CRÍTICO: Construir expectedLines desde BATCH si BD está vacía
                    // Esto permite que L03A reconozca las líneas de L03 del mismo batch
                    // =====================================================================
                    if (expectedLines.length === 0 && batchRelevantes.length > 0) {
                        console.log(`[${contexto}] expectedLines vacío, construyendo desde BATCH...`);

                        // Parsear versión actual para filtrar solo predecesores
                        const versionActual = _parseVersionLocal(payload.comunicadoId);

                        // [FIX] Ordenar batchRelevantes Descendente (Z -> A)
                        // Para que L30B tenga prioridad sobre L30A, y L30A sobre L30
                        batchRelevantes.sort((a, b) => {
                            const vA = _parseVersionLocal(a.header.comunicadoId);
                            const vB = _parseVersionLocal(b.header.comunicadoId);
                            return vB.index - vA.index;
                        });

                        for (const reg of batchRelevantes) {
                            const versionReg = _parseVersionLocal(reg.header.comunicadoId);
                            const regFamilia = _extractFamily(reg.header.comunicadoId);
                            // Solo considerar predecesores estrictos (misma familia, índice menor)
                            if (regFamilia === familiaActual && versionReg.index < versionActual.index) {
                                for (const linea of reg.lineas || []) {
                                    if (linea.concepto && linea.concepto !== 'Sin descripción') {
                                        // Normalización clave para comparación robusta
                                        const key = `${linea.concepto}|${linea.categoria}`.toUpperCase();
                                        // Acumulación defensiva: Si ya tengo el concepto (de un doc más nuevo), no lo sobrescribo
                                        if (!expectedLines.some(e => `${e.concepto}|${e.categoria}`.toUpperCase() === key)) {
                                            expectedLines.push({
                                                // id_bd será null para origen en batch -> FASE 2B asignará ID virtual (100+i)
                                                id_bd: linea.id_bd || null,
                                                concepto: linea.concepto,
                                                categoria: linea.categoria || 'DAÑO FISICO',
                                                importe_previo: linea.importe || 0,
                                                comunicado_origen: reg.header.comunicadoId
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        console.log(`[${contexto}] expectedLines construido desde BATCH: ${expectedLines.length} líneas acumuladas`);
                    }
                }

                console.log(`[${contexto}] Total contexto unificado: ${registrosContextoUnificado.length} registros`);

                // =========================================================================
                // FLUJO BIFURCADO: Determinar modo ORIGEN vs ACTUALIZACIÓN
                // =========================================================================
                // REGLA CLAVE:
                // - Si expectedLines.length === 0 → MODO ORIGEN (extracción total)
                // - Si expectedLines.length > 0  → MODO ACTUALIZACIÓN (extracción diferencial)
                // =========================================================================
                esOrigen = expectedLines.length === 0; // Reasignar (ya declarado antes del while)
                console.log(`[${contexto}] MODO DE EXTRACCIÓN: ${esOrigen ? 'ORIGEN (Línea Base)' : 'ACTUALIZACIÓN (Diferencial)'} [${expectedLines.length} líneas previas]`);

                const jsonResponse = _callGeminiWithPdf(base64Content, filename, lastError, catalogsContext, existingConcepts, registrosContextoUnificado, expectedLines, esOrigen, payload.comunicadoId);

                // Validar Lógica de Negocio básica (Suma)
                const validacion = _validarLogicaNegocio(jsonResponse);

                if (validacion.esValido) {
                    resultadoFinal = jsonResponse;
                    break; // Éxito
                } else {
                    console.warn(`[${contexto}] Intento #${intentos} falló validación: ${validacion.mensaje}`);
                    lastError = `Tu respuesta anterior tenía errores lógicos: ${validacion.mensaje}. Por favor rectifica y verifica los cálculos.`;
                }

            } catch (e) {
                console.warn(`[${contexto}] Error en Intento #${intentos}: ${e.message}`);
                lastError = `Ocurrió un error de formato o parseo: ${e.message}. Asegúrate de devolver JSON válido.`;
            }
        }

        if (!resultadoFinal) {
            throw new Error(`Falló tras ${MAX_RETRIES} intentos. Último error: ${lastError}`);
        }

        // =====================================================================
        // POST-PROCESAMIENTO: Normalizar datos de la IA
        // =====================================================================
        // Convertir conceptos y categorías a mayúsculas para consistencia
        // FIX: Para documentos ORIGEN, forzar accion:'CREAR' ya que no hay líneas previas
        if (resultadoFinal.lineas && Array.isArray(resultadoFinal.lineas)) {
            resultadoFinal.lineas = resultadoFinal.lineas.map(linea => ({
                ...linea,
                concepto: String(linea.concepto || '').toUpperCase().trim(),
                categoria: String(linea.categoria || 'DAÑO FISICO').toUpperCase().trim(),
                accion: esOrigen ? 'CREAR' : (linea.accion || 'MANTENER')
            }));
            console.log(`[procesarPdfIA] Normalizadas ${resultadoFinal.lineas.length} líneas a MAYÚSCULAS${esOrigen ? ' (todas con accion:CREAR)' : ''}`);

            // =====================================================================
            // FIX: CORRECCIÓN DE ACCIÓN BASADA EN COMPARACIÓN DE IMPORTES
            // Si la IA dice MANTENER pero el importe cambió, forzar ACTUALIZAR
            // =====================================================================
            if (!esOrigen && expectedLines.length > 0) {
                const expectedMap = new Map();
                expectedLines.forEach(e => {
                    const key = `${String(e.concepto).toUpperCase().trim()}|${String(e.categoria).toUpperCase().trim()}`;
                    expectedMap.set(key, e);
                });

                let correccionesAplicadas = 0;
                resultadoFinal.lineas = resultadoFinal.lineas.map(linea => {
                    if (linea.accion === 'MANTENER' && linea.importe !== null && linea.importe !== undefined) {
                        const key = `${linea.concepto}|${linea.categoria}`;
                        const previo = expectedMap.get(key);
                        if (previo) {
                            const importePrevio = parseFloat(previo.importe_previo) || 0;
                            const importeNuevo = parseFloat(linea.importe) || 0;
                            if (Math.abs(importePrevio - importeNuevo) > 0.01) {
                                console.log(`[procesarPdfIA] FIX Acción: ${linea.concepto.substring(0, 30)}... MANTENER → ACTUALIZAR ($${importePrevio.toFixed(2)} → $${importeNuevo.toFixed(2)})`);
                                correccionesAplicadas++;
                                return { ...linea, accion: 'ACTUALIZAR' };
                            }
                        }
                    }
                    return linea;
                });

                if (correccionesAplicadas > 0) {
                    console.log(`[procesarPdfIA] ✓ Corregidas ${correccionesAplicadas} acciones de MANTENER → ACTUALIZAR`);
                }
            }
        }

        // =====================================================================
        // PASADA FINAL: Completar campos vacíos del header con datos de Fase 1
        // =====================================================================
        const headerFase1 = payload._headerFase1 || {};
        const camposACompletar = [
            { campo: 'distritoRiego', fuente: 'distritoRiego' },
            { campo: 'ajustador', fuente: 'ajustador' },
            { campo: 'aseguradora', fuente: 'aseguradora' },
            { campo: 'fenomeno', fuente: 'fenomeno' },
            { campo: 'siniestro', fuente: 'siniestro' },
            { campo: 'fechaDoc', fuente: 'fechaDoc' }
        ];

        let camposCompletados = [];
        camposACompletar.forEach(({ campo, fuente }) => {
            const valorActual = resultadoFinal.header[campo];
            const valorFase1 = headerFase1[fuente];

            // Completar si está vacío y Fase 1 tiene valor
            if ((!valorActual || valorActual === '' || valorActual === 'null') && valorFase1) {
                resultadoFinal.header[campo] = valorFase1;
                camposCompletados.push(campo);
            }
        });

        if (camposCompletados.length > 0) {
            console.log(`[procesarPdfIA] ✓ Pasada Final: Completados campos vacíos desde Fase 1: ${camposCompletados.join(', ')}`);
        }

        // Estructurar para el Importador
        // Extraer conceptos únicos para propagar en batch
        const extractedConcepts = [...new Set(resultadoFinal.lineas.map(l => l.concepto).filter(Boolean))];

        return {
            success: true,
            data: {
                header: resultadoFinal.header,
                lineas: resultadoFinal.lineas
            },
            extractedConcepts: extractedConcepts,
            analisis: {
                intentos: intentos,
                modelo: GEMINI_MODEL
            }
        };

    } catch (error) {
        console.error(`[${contexto}] ERROR FATAL:`, error);
        return {
            success: false,
            message: error.message,
            filename: filename
        };
    }
}

/**
 * Carga conceptos de ubicación existentes desde la BD para una referencia CTA.
 * Usado para Entity Resolution cuando no hay conceptos en el batch pero hay historial.
 * @param {string} refCta - Referencia CTA del comunicado (ej: "GL098774")
 * @returns {Array} Lista de conceptos únicos existentes
 */
function cargarConceptosPorRefCta(refCta) {
    if (!refCta) return [];

    try {
        // Buscar comunicados con esta refCta
        const comunicados = readAllRows('comunicados');
        if (!comunicados.success) return [];

        const comsConRef = comunicados.data.filter(c =>
            c.refCta && c.refCta.toUpperCase() === refCta.toUpperCase()
        );

        if (comsConRef.length === 0) return [];

        // Obtener IDs de comunicados
        const idsComs = comsConRef.map(c => String(c.id));

        // Buscar actualizaciones de esos comunicados
        const actualizaciones = readAllRows('actualizaciones');
        if (!actualizaciones.success) return [];

        const actsDeReferencia = actualizaciones.data.filter(a =>
            idsComs.includes(String(a.idComunicado))
        );

        if (actsDeReferencia.length === 0) return [];

        // Obtener IDs de actualizaciones
        const idsActs = actsDeReferencia.map(a => String(a.id));

        // Buscar líneas de presupuesto de esas actualizaciones
        const lineasResp = readAllRows('presupuestoLineas');
        if (!lineasResp.success) return [];

        const lineasDeRef = lineasResp.data.filter(l =>
            idsActs.includes(String(l.idActualizacion))
        );

        // Obtener IDs de líneas únicas
        const idsLineas = [...new Set(lineasDeRef.map(l => String(l.idLinea)))];

        // Buscar descripciones de esas líneas
        const descripcionesResp = readAllRows('descripcionLineas');
        if (!descripcionesResp.success) return [];

        const conceptos = descripcionesResp.data
            .filter(d => idsLineas.includes(String(d.id)))
            .map(d => d.descripcion)
            .filter(Boolean);

        const conceptosUnicos = [...new Set(conceptos)];
        console.log(`[cargarConceptosPorRefCta] ${refCta}: ${conceptosUnicos.length} conceptos encontrados`);

        return conceptosUnicos;

    } catch (error) {
        console.error('[cargarConceptosPorRefCta] Error:', error);
        return [];
    }
}

/**
 * Carga registros relacionados para carry-forward de líneas en actualizaciones.
 * Busca candidatos en el batch actual y en la BD, ordenados por cercanía de versión.
 * @param {string} refCta - Referencia CTA del comunicado (ej: "GL098774")
 * @param {string} comunicadoId - ID del comunicado actual (ej: "L50B")
 * @param {Array} batchResults - Resultados ya procesados en el batch actual
 * @param {object} cache - Cache de catálogos de BD (opcional, para búsqueda en BD)
 * @returns {Array} Lista de candidatos ordenados { header, lineas }
 */
function cargarRegistrosRelacionados(refCta, comunicadoId, batchResults = [], cache = null) {
    if (!refCta) return [];

    const contexto = '[cargarRegistrosRelacionados]';
    const refClean = String(refCta).toUpperCase().trim();

    // [FIX] Extraer familia para aislamiento RF8
    const familiaActual = _extractFamily(comunicadoId);

    // Parsear versión actual para determinar predecesores esperados
    const versionActual = _parseVersionLocal(comunicadoId);
    const predecesoresEsperados = _calcularPredecesores(versionActual);
    console.log(`${contexto} Buscando candidatos para ${refCta}-${comunicadoId}. Familia: ${familiaActual}. Predecesores: ${predecesoresEsperados.join(', ')}`);

    const candidatos = [];

    // 1. Buscar en batch actual (prioridad 1)
    if (batchResults && batchResults.length > 0) {
        const batchCandidatos = batchResults
            .filter(r => {
                const rRef = String(r.rawPayload?.header?.refCta || r.header?.refCta || '').toUpperCase().trim();
                // [FIX] Filtrar por familia además de referencia
                const rComId = r.rawPayload?.header?.comunicadoId || r.header?.comunicadoId || '';
                const rFamilia = _extractFamily(rComId);
                return rRef === refClean && rFamilia === familiaActual;
            })
            .map(r => ({
                source: 'BATCH',
                header: r.rawPayload?.header || r.header || {},
                lineas: r.rawPayload?.lineas || r.lineas || []
            }));

        candidatos.push(...batchCandidatos);
        console.log(`${contexto} Encontrados ${batchCandidatos.length} candidatos en batch (familia ${familiaActual})`);
    }

    // 2. Buscar en BD (prioridad 2) - También filtrar por familia
    if (cache) {
        const dbCandidatos = _buscarCandidatosEnBD(refClean, cache)
            .filter(c => _extractFamily(c.header.comunicadoId) === familiaActual);
        candidatos.push(...dbCandidatos);
        console.log(`${contexto} Encontrados ${dbCandidatos.length} candidatos en BD (familia ${familiaActual})`);
    }

    // 3. Ordenar por cercanía de versión (predecesor exacto primero)
    candidatos.sort((a, b) => {
        const idA = String(a.header.comunicadoId || '').toUpperCase();
        const idB = String(b.header.comunicadoId || '').toUpperCase();

        const indexA = predecesoresEsperados.indexOf(idA);
        const indexB = predecesoresEsperados.indexOf(idB);

        // Predecesores esperados primero (menor índice = más cercano)
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;

        // Si ambos no son predecesores esperados, ordenar por fecha desc
        const fechaA = new Date(a.header.fechaDoc || 0);
        const fechaB = new Date(b.header.fechaDoc || 0);
        return fechaB - fechaA;
    });

    // Limitar a 5 candidatos
    const resultado = candidatos.slice(0, 5);
    console.log(`${contexto} Retornando ${resultado.length} candidatos ordenados`);

    return resultado;
}

/**
 * Parsea versión de comunicadoId (duplicado local para evitar dependencias circulares)
 */
function _parseVersionLocal(comunicadoId) {
    if (!comunicadoId) return { base: '', sufijo: '', index: 0 };
    const cleanId = String(comunicadoId).toUpperCase().trim();
    const match = cleanId.match(/^(L\d+)([A-Z])?$/);
    if (match) {
        const sufijo = match[2] || '';
        return { base: match[1], sufijo, index: sufijo ? sufijo.charCodeAt(0) - 64 : 0 };
    }
    return { base: cleanId, sufijo: '', index: 0 };
}

/**
 * Extrae la familia base de un comunicadoId.
 * Ejemplos:
 *   "L50" -> "L50"
 *   "L50A" -> "L50"
 *   "L81B" -> "L81"
 * @param {string} comunicadoId - ID del comunicado (ej: L50A)
 * @returns {string} Familia base (ej: L50)
 */
function _extractFamily(comunicadoId) {
    if (!comunicadoId) return '';
    const match = String(comunicadoId).toUpperCase().trim().match(/^(L\d+)/);
    return match ? match[1] : String(comunicadoId).toUpperCase().trim();
}

/**
 * Calcula los predecesores esperados para un comunicadoId.
 * Ej: L50C → ["L50B", "L50A", "L50"]
 *     L50A → ["L50"]
 *     L50  → []
 */
function _calcularPredecesores(versionInfo) {
    const predecesores = [];
    if (versionInfo.index > 0) {
        // Agregar predecesores en orden descendente
        for (let i = versionInfo.index - 1; i >= 0; i--) {
            if (i === 0) {
                predecesores.push(versionInfo.base); // L50
            } else {
                predecesores.push(versionInfo.base + String.fromCharCode(64 + i)); // L50A, L50B, etc.
            }
        }
    }
    return predecesores;
}

/**
 * Busca candidatos relacionados en la BD.
 */
function _buscarCandidatosEnBD(refCta, cache) {
    const candidatos = [];

    try {
        // Buscar cuenta por refCta
        const cta = cache.cuentas?.find(c =>
            String(c.referencia).toUpperCase().trim() === refCta ||
            String(c.cuenta).toUpperCase().trim() === refCta
        );

        if (!cta) return [];

        // Buscar comunicados de esta cuenta
        const comsRelacionados = cache.comunicados?.filter(c =>
            String(c.idReferencia) === String(cta.id)
        ) || [];

        // Para cada comunicado, obtener header y líneas
        for (const com of comsRelacionados) {
            // Obtener datos generales
            const dg = cache.datosGenerales?.find(d => String(d.idComunicado) === String(com.id));

            // Construir header simplificado
            const header = {
                refCta: refCta,
                comunicadoId: com.comunicado,
                fechaDoc: dg?.fecha || com.fecha,
                descripcion: dg?.descripcion || `${refCta}-${com.comunicado}`,
                tipoRegistro: dg?.tipoRegistro || 'ORIGEN'
            };

            // Buscar líneas de presupuesto
            const lineas = _obtenerLineasDeComunicado(com.id, cache);

            candidatos.push({
                source: 'BD',
                header,
                lineas
            });
        }

    } catch (error) {
        console.error('[_buscarCandidatosEnBD] Error:', error);
    }

    return candidatos;
}

/**
 * Obtiene las líneas de presupuesto de un comunicado desde el cache.
 */
function _obtenerLineasDeComunicado(idComunicado, cache) {
    const lineas = [];

    try {
        // Buscar actualizaciones del comunicado
        const acts = cache.actualizaciones?.filter(a =>
            String(a.idComunicado) === String(idComunicado)
        ) || [];

        if (acts.length === 0) return [];

        // Tomar la última actualización (más reciente)
        const ultimaAct = acts[acts.length - 1];

        // Buscar líneas de esa actualización
        const lineasAct = cache.presupuestoLineas?.filter(l =>
            String(l.idActualizacion) === String(ultimaAct.id)
        ) || [];

        // Enriquecer con descripción
        for (const linea of lineasAct) {
            const desc = cache.descripcionLineas?.find(d =>
                String(d.id) === String(linea.idLinea)
            );

            lineas.push({
                concepto: desc?.descripcion || 'Sin descripción',
                categoria: linea.categoria || 'DAÑO FISICO',
                importe: parseFloat(linea.importe || 0)
            });
        }

    } catch (error) {
        console.error('[_obtenerLineasDeComunicado] Error:', error);
    }

    return lineas;
}

/**
 * Valida reglas matemáticas y de negocio críticas antes de aceptar la respuesta IA.
 * CAMBIO: Si hay diferencia entre total y suma de líneas, las LÍNEAS rigen (autocorrige totalPdf).
 */
function _validarLogicaNegocio(json) {
    if (!json.header || !json.lineas) return { esValido: false, mensaje: "Estructura JSON incompleta (falta header o lineas)" };

    // Regla Importe Cero = Cancelado (No es error)
    const totalDoc = parseFloat(json.header.totalPdf || 0);
    if (totalDoc === 0 && (!json.lineas || json.lineas.length === 0)) {
        return { esValido: true };
    }

    // Calcular Suma de Líneas
    const sumaLineas = json.lineas.reduce((sum, l) => sum + (parseFloat(l.importe) || 0), 0);
    const diff = Math.abs(totalDoc - sumaLineas);

    // Si hay diferencia, las líneas rigen. Autocorregir totalPdf.
    if (diff > 1.0 && sumaLineas > 0) {
        console.warn(`[Validación IA] Autocorrigiendo totalPdf: ${totalDoc} -> ${sumaLineas} (Diferencia: ${diff})`);
        json.header.totalPdf = sumaLineas;
        json.header.advertencias = json.header.advertencias || [];
        json.header.advertencias.push(`Total corregido: ${totalDoc.toFixed(2)} -> ${sumaLineas.toFixed(2)}`);
    }

    return { esValido: true };
}

/**
 * ==========================================================================
 * FASE 1: "EL CLASIFICADOR" - Extracción de Metadatos y Determinación de Estrategia
 * ==========================================================================
 * Prompt de clasificación documental que escanea SOLO el encabezado del PDF
 * para extraer las "huellas digitales" del documento y decidir la estrategia.
 * 
 * NO extrae tablas ni importes monetarios.
 * 
 * @param {string} base64Content - Contenido del PDF en Base64
 * @param {string} filename - Nombre del archivo
 * @returns {object} { header: {...}, tipoEstrategia } o null si falla
 */
function _extraerIdentificadoresRapido(base64Content, filename) {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) {
        console.error('[Fase 1 Clasificador] GEMINI_API_KEY no configurada.');
        return null;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    // =========================================================================
    // PROMPT FASE 1: EL CLASIFICADOR
    // =========================================================================
    const promptClasificador = `
**ROL:** Eres un Clasificador Documental Experto en Siniestros de Infraestructura (Conagua/Agroasemex).

**TAREA:** Escanea el ENCABEZADO del documento para extraer sus huellas digitales. NO extraigas tablas ni importes monetarios.

**REGLA DE ORO:** Ejecuta secuencialmente los siguientes 4 PASOS.

---

## SECUENCIA DE EJECUCIÓN FASE 1 (METADATOS)

### PASO 1: Identificación de Actores y Siniestro
*Objetivo: Saber quién, cuándo y por qué.*
* **1.1 Ajustador:** Busca logos o textos ("Charles Taylor", "Miller"). Normaliza el nombre.
* **1.2 Aseguradora:** Busca "AGROASEMEX" o el número de póliza.
* **1.3 Fecha del Documento:** Extrae la fecha de emisión del oficio (generalmente esquina superior derecha). Formato YYYY-MM-DD.
* **1.4 Fenómeno:** Busca la frase "Daños a... por el paso del [FENÓMENO]". Extrae la frase completa.
* **1.5 Fecha de Incidencia (FI):** Busca "F.I.", "Ocurrencia" o "Del... al...". Extrae el texto literal.
* **1.6 Distrito/Zona:** Busca "Distrito de Riego", "Dirección Local" o "Unidad". Normaliza.
* **1.7 Referencia Siniestro:** Busca códigos tipo "SCNA-XXXX/YYYY".

### PASO 2: Extracción de IDs Críticos (La Llave Maestra)
*Objetivo: Obtener las claves únicas para la base de datos.*
* **2.1 Referencia Ajustador:** Busca "Ref. CTA:", "Referencia:", "Ref. Miller".
* **2.2 Limpieza de Referencia:** Extrae SOLO la parte alfanumérica base (ej. **GL098774**). Si ves "GL098774-L50", córtalo y quédate con la base.
* **2.3 ID de Comunicado:** Busca la línea "Comunicado:" o el sufijo de la referencia.
* **2.4 Extracción ID:** Extrae el código corto (ej. **L50**, **L50A**, **L13B**). Mantén las letras sufijo, son vitales.
* **2.5 Validación:** Si Reference o Comunicado son nulos, devuelve \`"error": "ERROR DE LECTURA"\`.
* **2.6 Verificación Cruzada:** Asegúrate que el ID del comunicado no contradiga la referencia base.
* **2.7 Formato:** Devuelve strings limpios sin espacios extra.

### PASO 3: Determinación de Estrategia (Origen vs Actualización)
*Objetivo: Decidir si estamos creando o modificando datos.*
* **3.1 Análisis de Sufijo:** ¿El ID del comunicado termina en letra (A, B, C)? -> Señal de ACTUALIZACIÓN.
* **3.2 Análisis de Título:** Busca palabras: "(Actualización)", "(Adicional)", "(Alcance)", "(Complemento)".
* **3.3 Análisis Narrativo:** Lee el primer párrafo. Busca: "hacemos referencia a...", "sustituye", "modifica".
* **3.4 Veredicto:** SI (Sufijo Letra OR Palabras Clave) -> \`tipoEstrategia\` = "ACTUALIZACION". SI NO -> \`tipoEstrategia\` = "ORIGEN".
* **3.5 Sub-Clasificación:** Si es Actualización, identifica si es "Adicional" (suma) o "Modificatorio" (cambia).
* **3.6 Validación de Lógica:** Un documento "L50" nunca debe ser Actualización. Un "L50B" nunca debe ser Origen.

### PASO 4: Output JSON (Metadatos)
Genera un JSON estricto con la llave raíz \`"header"\`.

\`\`\`json
{
  "header": {
    "referenciaBase": "GL098774",
    "comunicadoId": "L50A",
    "tipoEstrategia": "ACTUALIZACION",
    "fechaDoc": "2025-06-10",
    "distritoRiego": "DIRECCIÓN LOCAL GUERRERO",
    "ajustador": "CHARLES TAYLOR ADJUSTING",
    "aseguradora": "AGROASEMEX",
    "fenomeno": "Huracán Otis",
    "siniestro": "SCNA-0226/2022"
  }
}
\`\`\`

**IMPORTANTE:** Responde SOLO con JSON válido, sin texto adicional.
`;

    const payload = {
        contents: [{
            parts: [
                { text: promptClasificador },
                { inline_data: { mime_type: "application/pdf", data: base64Content } }
            ]
        }],
        // FIX: Desactivar filtros de seguridad para contenido de siniestros (huracanes, daños, etc.)
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ],
        generationConfig: { response_mime_type: "application/json" }
    };

    try {
        console.log(`[Fase 1 Clasificador] Ejecutando clasificación para ${filename}...`);
        const response = UrlFetchApp.fetch(url, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
        });

        const code = response.getResponseCode();
        if (code !== 200) {
            console.error(`[Fase 1 Clasificador] Error HTTP ${code}:`, response.getContentText().substring(0, 300));
            return null;
        }

        const respJson = JSON.parse(response.getContentText());

        if (!respJson.candidates || respJson.candidates.length === 0) {
            console.error('[Fase 1 Clasificador] No hay candidatos en la respuesta');
            return null;
        }

        const rawContent = respJson.candidates[0]?.content?.parts?.[0]?.text || '';
        // FIX: Extracción robusta de JSON usando regex para ignorar texto extra
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('No se encontró un objeto JSON válido en la respuesta de Gemini (Fase 1).');
        }
        const cleanJson = jsonMatch[0];
        const result = JSON.parse(cleanJson);

        // Extraer campos para compatibilidad con el flujo existente
        const header = result.header || result;
        const refAjustador = header.referenciaBase || header.refAjustador;
        const comunicadoId = header.comunicadoId;
        const tipoEstrategia = header.tipoEstrategia || 'ORIGEN';

        console.log(`[Fase 1 Clasificador] ✓ Ref="${refAjustador}", Com="${comunicadoId}", Estrategia="${tipoEstrategia}"`);

        // Retornar en formato unificado
        return {
            refAjustador: refAjustador,
            comunicadoId: comunicadoId,
            tipoEstrategia: tipoEstrategia,
            header: header // Objeto completo con todos los metadatos
        };

    } catch (error) {
        console.error('[Fase 1 Clasificador] Error:', error.message);
        return null;
    }
}

/**
 * Consulta la BD para obtener registros relacionados con formato {header, lineas}.
 * Usa refAjustador + comunicadoId para filtro preciso.
 * @param {string} refAjustador - Referencia del ajustador (ej: GL098774)
 * @param {string} comunicadoId - ID del comunicado actual (ej: L50B)
 * @param {object} cache - Cache de catálogos pre-cargados
 * @returns {Array} Array de objetos {header, lineas} en el mismo formato de salida AI
 */
function _consultarContextoBD(refAjustador, comunicadoId, cache) {
    if (!refAjustador || !cache) return [];

    const contexto = '[_consultarContextoBD]';
    const refClean = String(refAjustador).toUpperCase().trim();

    // Calcular predecesores esperados usando función existente
    const versionActual = _parseVersionLocal(comunicadoId);
    const predecesoresEsperados = _calcularPredecesores(versionActual);

    // Incluir el comunicadoId actual también para detectar duplicados
    const comunicadosRelevantes = [comunicadoId, ...predecesoresEsperados].map(c => String(c).toUpperCase());

    console.log(`${contexto} Buscando contexto para ${refAjustador}-${comunicadoId}. Relevantes: ${comunicadosRelevantes.join(', ')}`);

    const registrosContexto = [];

    try {
        // 1. Buscar cuenta por refAjustador
        const cuenta = cache.cuentas?.find(c =>
            String(c.referencia || c.cuenta || '').toUpperCase().trim() === refClean
        );

        if (!cuenta) {
            console.log(`${contexto} No se encontró cuenta para ${refAjustador}`);
            return [];
        }

        // 2. Buscar comunicados de esta cuenta
        const comunicadosBD = cache.comunicados?.filter(c =>
            String(c.idReferencia) === String(cuenta.id)
        ) || [];

        // 3. Filtrar solo los comunicados relevantes (actual + predecesores)
        const comunicadosFiltrados = comunicadosBD.filter(c =>
            comunicadosRelevantes.includes(String(c.comunicado).toUpperCase().trim())
        );

        console.log(`${contexto} Encontrados ${comunicadosFiltrados.length} comunicados relevantes de ${comunicadosBD.length} totales`);

        // 4. Para cada comunicado, construir el objeto {header, lineas}
        for (const com of comunicadosFiltrados) {
            // Obtener datos generales
            const dg = cache.datosGenerales?.find(d => String(d.idComunicado) === String(com.id)) || {};

            // Obtener catalogs relacionados
            const estado = cache.estados?.find(e => String(e.id) === String(dg.idEstado)) || {};
            const distrito = cache.distritosRiego?.find(d => String(d.id) === String(dg.idDR)) || {};
            const siniestro = cache.siniestros?.find(s => String(s.id) === String(dg.idSiniestro)) || {};
            const aseguradora = cache.aseguradoras?.find(a =>
                String(a.id) === String(siniestro.idAseguradora || dg.idAseguradora)
            ) || {};

            // Obtener la última actualización
            const actualizaciones = cache.actualizaciones?.filter(a =>
                String(a.idComunicado) === String(com.id)
            ).sort((a, b) => Number(b.consecutivo) - Number(a.consecutivo)) || [];

            const ultimaAct = actualizaciones[0] || {};

            // Obtener líneas de presupuesto
            const lineasBD = cache.presupuestoLineas?.filter(l =>
                String(l.idActualizacion) === String(ultimaAct.id)
            ) || [];

            // Construir lineas con formato de salida AI
            // [FIX CRÍTICO 1] Incluir id_bd real para actualizaciones precisas
            const lineas = lineasBD.map(l => {
                const desc = cache.descripcionLineas?.find(d => String(d.id) === String(l.idLinea)) || {};
                let catFinal = String(l.categoria || 'DAÑO FISICO').toUpperCase();
                if (catFinal === '1') catFinal = 'DAÑO FISICO';
                if (catFinal === '2') catFinal = 'DESAZOLVES';

                return {
                    id_bd: l.idLinea, // <-- ID REAL para actualizaciones al registro correcto
                    concepto: desc.descripcion || 'Sin descripción',
                    categoria: catFinal,
                    importe: parseFloat(l.importe || 0)
                };
            });

            // Construir header con formato de salida AI
            const header = {
                refAjustador: refClean,
                ajustadorNombre: cache.ajustadores?.find(a =>
                    String(a.id) === String(cuenta.idAjustador)
                )?.nombreAjustador || '',
                comunicadoId: com.comunicado,
                tipoRegistro: dg.tipoRegistro || 'ORIGEN',
                descripcion: dg.descripcion || `${refClean}-${com.comunicado}`,
                fechaDoc: dg.fecha || '',
                estado: estado.estado || estado.nombre || '',
                refSiniestro: siniestro.siniestro || '',
                aseguradora: aseguradora.aseguradora || aseguradora.nombre || 'AGROASEMEX',
                fenomeno: siniestro.fenomeno || '',
                fi: siniestro.fi || '',
                fondo: siniestro.fondo || '',
                distritoRiego: distrito.distritoRiego || distrito.nombre || '',
                totalPdf: parseFloat(ultimaAct.monto || ultimaAct.montoCapturado || 0)
            };

            registrosContexto.push({ header, lineas });
        }

        // 5. [FIX CRÍTICO 2] ORDENAMIENTO DESCENDENTE (Del más nuevo al más viejo)
        // Esto asegura que si L30B y L30A tienen el mismo concepto, nos quedamos con el de L30B
        registrosContexto.sort((a, b) => {
            const vA = _parseVersionLocal(a.header.comunicadoId).index;
            const vB = _parseVersionLocal(b.header.comunicadoId).index;
            return vB - vA; // Descendente: C(3) antes que B(2) antes que A(1)
        });

        // 6. Excluir el comunicadoId actual si está presente (solo queremos predecesores)
        const resultado = registrosContexto.filter(r =>
            String(r.header.comunicadoId).toUpperCase() !== String(comunicadoId).toUpperCase()
        );

        // 7. [FIX CRÍTICO 3] CONSTRUCCIÓN ACUMULATIVA DE LÍNEAS ESPERADAS
        // Al recorrer del más nuevo al más viejo, "llenamos" los huecos:
        // 1. Entra todo lo de L30B
        // 2. Entra lo de L30A que NO estaba en L30B
        // 3. Entra lo de L30 que NO estaba en L30A ni L30B
        const expectedLines = [];
        for (const reg of resultado) {
            for (const linea of reg.lineas || []) {
                if (linea.concepto && linea.concepto !== 'Sin descripción') {
                    // Normalización clave para comparación robusta
                    const key = `${linea.concepto}|${linea.categoria}`.toUpperCase();

                    // Solo agregamos si NO existe ya (preservamos el valor más reciente)
                    if (!expectedLines.some(e => `${e.concepto}|${e.categoria}`.toUpperCase() === key)) {
                        expectedLines.push({
                            id_bd: linea.id_bd, // <-- Propagamos el ID real
                            concepto: linea.concepto,
                            categoria: linea.categoria || 'DAÑO FISICO',
                            importe_previo: linea.importe || 0,
                            comunicado_origen: reg.header.comunicadoId
                        });
                    }
                }
            }
        }

        console.log(`${contexto} ✓ Retornando ${resultado.length} registros de contexto BD, ${expectedLines.length} líneas esperadas`);

        // IMPORTANTE: Retornar objeto con ambas estructuras
        // Los consumidores que esperaban array deben actualizarse
        return {
            registros: resultado,
            expectedLines: expectedLines
        };

    } catch (error) {
        console.error(`${contexto} Error:`, error);
        return { registros: [], expectedLines: [] };
    }
}

/**
 * Envía PDF directamente a Gemini usando entrada multimodal.
 * Gemini 1.5/2.0 puede leer PDFs nativamente sin necesidad de OCR previo.
 * @param {string} base64Content - Contenido del PDF en Base64
 * @param {string} filename - Nombre del archivo
 * @param {object} catalogs - Catálogos de entidades para matching
 * @param {Array} existingConcepts - Conceptos de ubicación existentes del batch/BD
 * @param {Array} relatedRecords - Registros relacionados para carry-forward
 * @param {Array} expectedLines - Líneas esperadas para Schema Injection (extracción dirigida)
 * @param {boolean} esOrigen - Si true, es documento ORIGEN (extracción total); si false, es ACTUALIZACIÓN (diferencial)
 * @param {string} comunicadoId - ID del comunicado actual para aislamiento de familia
 */
function _callGeminiWithPdf(base64Content, filename, errorFeedback = null, catalogs = null, existingConcepts = [], relatedRecords = [], expectedLines = [], esOrigen = true, comunicadoId = null) {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY no configurada en Propiedades del Script.');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    // Construcción del Prompt Alineado al Excel/CSV
    let promptSystem = `
    # PROMPT MAESTRO (v6.3) — Auditor de Ingeniería para Extracción de Presupuestos (PDF → JSON)

    **Rol:** Eres un Auditor de Ingeniería experto y Agente de Procesamiento de Datos.  
    **Misión:** Extraer datos financieros/técnicos de reportes PDF para generar un JSON estructurado **idéntico** al registro de un auditor humano.  
    **Salida:** **EXCLUSIVAMENTE JSON** (sin texto adicional, sin explicaciones, sin markdown fuera del bloque de código).

    ## 0) ENTRADAS DISPONIBLES (Contexto de Ejecución)
    - **PDF**: Contenido completo del documento.
    - **CATÁLOGOS** (Opcional): Listas maestras para *entity resolution* (Ajustadores, Distritos, Fenómenos, Aseguradoras).
    - **REGISTRO_PREVIO** (Opcional): Objeto JSON del comunicado anterior (\`prev.header\`, \`prev.lineas\`).
    `;

    // =========================================================================
    // FLUJO BIFURCADO: Inyectar instrucciones según MODO
    // =========================================================================
    if (esOrigen) {
        // =====================================================================
        // FASE 2A: "EL CONSTRUCTOR" - MODO ORIGEN (Extracción Total)
        // =====================================================================
        console.log('[_callGeminiWithPdf] MODO: ORIGEN - Fase 2A El Constructor');
        promptSystem += `

## 🟢 FASE 2A: MODO ORIGEN (El Constructor)

**ROL:** Auditor de Presupuestos de Obra (Modo Creación).
**CONTEXTO:** Este es el documento MAESTRO (Origen). Debes extraer el 100% de las partidas. La base de datos está VACÍA para esta referencia.

---

### PASO 1: Escaneo de Tablas Financieras
*Objetivo: Identificar y procesar todas las tablas de presupuesto.*

* **1.1 Jerarquía de Tablas:** Prioridad: "Hoja Generadora" > "Presupuesto" > "Estimación".
* **1.2 Filas Válidas:** Extrae toda fila que tenga: Clave/Código, Descripción y Monto.
* **1.3 Columnas Fantasma:** Si hay columna "Anterior" y "Actual", toma SIEMPRE la "Actual" o "Total".
* **1.4 Identidad Geográfica:** Si la fila es un material ("Cemento"), busca el encabezado superior "UBICACIÓN:" y úsalo como concepto principal.
* **1.5 Desglose Individual:** Si un concepto se repite en varios tramos, extráelos por separado. **NO LOS SUMES**.
* **1.6 Limpieza Automática:** Ignora filas con: "Subtotal", "IVA", "Gran Total", "Suma".
* **1.7 Montos Cero:** Si una partida aparece con $0.00 en el presupuesto original, **ignórala** (probablemente formato vacío).

### PASO 2: Categorización de Líneas
*Objetivo: Clasificar cada concepto correctamente.*

* **2.1 DAÑO FISICO:** Reparaciones, reconstrucción, suministros de materiales, mano de obra.
* **2.2 DESAZOLVES:** Limpieza de canales, remoción de sedimentos, azolve.
* **2.3 Columnas Separadas:** Si el PDF tiene columnas "Daño Físico" y "Desazolves" separadas, genera UNA línea por cada columna con valor > 0.
* **2.4 Prioridad de Columnas:** Buscar "Importe Total", "Monto Autorizado", "Estimación CTA".
* **2.5 Evitar Columnas:** NO uses "Precio Unitario", "P.U.", "Reclamado", "Anterior".

### PASO 3: Normalización y Limpieza
*Objetivo: Preparar datos limpios.*

* **3.1 Montos:** Quita signos de pesos ($), comas. Usa formato numérico (e.g., 45000.50).
* **3.2 Descripciones:** Normaliza ubicaciones: "UR" → "Unidad de Riego", "DR" → "Distrito de Riego".
* **3.3 Validación:** Verifica que la suma de líneas ≈ total del documento.

### PASO 4: Output JSON
Genera el JSON con estructura \`{header, lineas}\`.

**Formato Esperado:**
\`\`\`json
{
  "header": {
    "refCta": "GL098774",
    "comunicadoId": "L50",
    "tipoRegistro": "ORIGEN",
    "fechaDoc": "2025-06-10",
    "totalPdf": 500000.00,
    "descripcion": "GL098774-L50"
  },
  "lineas": [
    {
      "concepto": "Unidad de Riego Aguas Blancas",
      "categoria": "DAÑO FISICO",
      "importe": 45000.50
    },
    {
      "concepto": "Unidad de Riego Coyuca",
      "categoria": "DESAZOLVES",
      "importe": 12000.00
    }
  ]
}
\`\`\`

**IMPORTANTE:** Extrae TODAS las partidas válidas. No omitas ninguna.
`;
    } else {
        // =====================================================================
        // FASE 2B: "EL CIRUJANO" - MODO ACTUALIZACIÓN (Extracción Diferencial)
        // =====================================================================
        console.log('[_callGeminiWithPdf] MODO: ACTUALIZACIÓN - Fase 2B El Cirujano');

        // =========================================================================
        // REGLAS ESPECIALES PARA ACTUALIZACIONES INFORMATIVAS O DE RECHAZO
        // =========================================================================
        promptSystem += `

## 🛑🛑🛑 REGLA SUPREMA: DETECCIÓN DE RECHAZOS (PRIORIDAD MÁXIMA - CASO L06A) 🛑🛑🛑

**⚠️ EJECUTAR ANTES DE CUALQUIER EXTRACCIÓN DE TABLAS ⚠️**

**PASO 0 (OBLIGATORIO): ANÁLISIS DE SENTIMIENTO DEL DOCUMENTO**

1. **ESCANEO COMPLETO:** Lee TODO el texto del documento PRIMERO, antes de mirar cualquier tabla.

2. **DETECCIÓN DE FRASES DE RECHAZO:** Si encuentras CUALQUIERA de estas frases:
   - "No estaríamos en condiciones de modificar"
   - "No estaríamos en condiciones"
   - "No procede" / "No procede lo solicitado"
   - "Se descarta" / "Se rechaza"
   - "Mantiene lo anterior" / "Se mantiene el dictamen"
   - "Sin soporte técnico" / "No cuenta con soporte"
   - "No autorizado" / "Improcedente"
   - "No es indemnizable" / "No aplica"
   - "Fuera del alcance de la póliza"

3. **ACCIÓN OBLIGATORIA SI DETECTAS RECHAZO:**
   - Define \`tipoAccion\` = **"INFORMATIVO"**
   - Define \`lineas\` = **[]** (array vacío, SIN EXCEPCIONES)
   - Define \`totalPdf\` = **0**
   - **IGNORA COMPLETAMENTE** cualquier tabla posterior:
     * "Anexo I"
     * "Formato de Inspección"
     * Tablas manuscritas con garabatos
     * Tablas con medidas (metros, km, m²) sin signos de pesos ($)

4. **PROHIBICIÓN ABSOLUTA:**
   - Bajo NINGUNA circunstancia extraigas montos de:
     * Medidas físicas (metros, kilómetros, espesores)
     * Tablas manuscritas de campo
     * Formatos de levantamiento o inspección
   - Si el texto dice "no procede" pero hay una tabla manuscrita, **EL TEXTO MANDA**.

---

### PASO CRÍTICO: DETECCIÓN DE "SIN CAMBIOS" (INFORMATIVO)
*Objetivo: No inventar cambios donde no los hay.*

* **REGLA 1: Rechazo de Adicionales:**
  - Si el documento discute reclamos adicionales (ej. "azolve", "nuevos tramos") pero concluye rechazo:
  - TU ACCIÓN: Devuelve \`lineas: []\` (Array vacío).
  - El sistema mantendrá automáticamente el presupuesto anterior.

* **REGLA 2: Formatos de Inspección (Handwritten):**
  - Los documentos pueden contener un "Anexo I" o "Formato de Inspección" manuscrito. **ESO NO ES UN PRESUPUESTO**.
  - Si ves garabatos, letras a mano, cotas numéricas (ej. "4.30m", "2.0m") o formatos de campo sin signos de pesos ($) claros en columnas de "Importe Total":
  - **NO LOS PROCESES**. Asume que no hay cambios financieros.

* **REGLA 3: Validación de Moneda:**
  - Solo extrae valores si la columna dice explícitamente "Importe", "Monto", "Total" o "$".
  - Nunca asumas que una columna sin encabezado monetario es dinero.

* **REGLA 4: Lenguaje de Rechazo Explícito (Refuerzo):**
  - Si detectaste lenguaje de rechazo en el PASO 0 Y no hay tabla de presupuesto nueva formal:
  - **DEVUELVE lineas: []** para marcar como INFORMATIVO.
  - **EL TEXTO DE RECHAZO SIEMPRE TIENE PRIORIDAD SOBRE CUALQUIER TABLA ANEXA.**
`;
    }

    promptSystem += `

    > **REGLA DE ORO:** Ejecuta secuencialmente los siguientes 8 PASOS. Cada paso consta de **exactamente 7 SUBPASOS** obligatorios. No omitas ninguno.

    ---

    ## REGLAS FUNDAMENTALES DE PROCESAMIENTO (Leer Antes de Ejecutar)

    ### RF1: Control de Versiones de Documentos (Priorización y Orden de Lectura)
    - Si recibes múltiples documentos con el mismo número de referencia base (ej. GL098774-L22 y GL098774-L22A), el documento que contenga una **letra al final del código** o la palabra **(Actualización)** tiene **prioridad absoluta** sobre el original.
    - En caso de contradicción en nombres de unidades, responsables o instrucciones técnicas, **descarta la información del documento antiguo** y utiliza exclusivamente la del más reciente.
    - El documento base (sin letra) establece la línea base; las actualizaciones (con letra A, B, C...) la reemplazan.
    - **ORDEN DE LECTURA OBLIGATORIO para ACTUALIZACIONES:**
        1. PRIMERO: Lee los anexos y correos electrónicos (páginas finales del PDF).
        2. SEGUNDO: Lee el cuerpo principal del oficio.
        3. Si los anexos contienen instrucciones que contradicen el cuerpo, **los anexos prevalecen**.

    ### RF2: Búsqueda de Conflictos y Alertas Críticas (No Alucinaciones)
    - **No te limites a extraer datos numéricos**. Busca activamente en el cuerpo del texto y en los anexos (especialmente si hay correos electrónicos) palabras clave como:
        - "trazo diferente", "riesgo de falla", "detener trabajos", "corrección", "inadmisible", "no autorizado", "inconformidad", "modificar", "cambiar ruta".
    - Si el área técnica de la dependencia manifiesta una inconformidad con la **ejecución física de la obra** (trazo, ruta, método constructivo), **agrega una advertencia** al array \`header.advertencias\` con prefijo "ALERTA CRÍTICA:" describiendo el problema LOGÍSTICO.
    - **PROHIBIDO GENERAR ADVERTENCIAS FALSAS**: 
        - NO reportes "Total corregido" si el monto NO cambió.
        - Si detectas una corrección de TRAZO pero el MONTO es idéntico, la advertencia debe decir: "ALERTA CRÍTICA: Corrección de trazo requerida (sin cambio de monto)".
        - Nunca confundas una corrección logística con una corrección económica.

    ### RF3: Validación de Identidad de Infraestructura (Por Firmante, NO por Contexto)
    - **REGLA ANTI-CONFUSIÓN GEOGRÁFICA**: El nombre del estado o Dirección Local se extrae de:
        1. El **membrete oficial** o encabezado del documento.
        2. El **firmante** del oficio (ej. "Director Local de Michoacán").
        3. La **dirección postal** de envío.
    - **PROHIBIDO** inferir la ubicación del contexto del fenómeno natural (ej. si el huracán afectó Guerrero, eso NO significa que el comunicado sea de Guerrero).
    - Si el documento dice "Huracán John por Guerrero" pero está firmado por "Dirección Local Michoacán", el estado es **MICHOACÁN**.
    - Si detectas un cambio de ubicación entre versiones, reporta: "Rectificación de Ubicación: [anterior] → [nuevo]".

    ### RF4: Análisis Multifuente Interno (Procesamiento de Anexos OBLIGATORIO)
    - **ANTES de generar cualquier línea de presupuesto**, debes leer TODAS las páginas del PDF, especialmente:
        - Páginas 5-10 que suelen contener correos electrónicos de la dependencia.
        - Anexos marcados como "Anexo I", "Anexo Técnico", etc.
    - Los comentarios técnicos enviados por personal de la Dirección Local (ej. Subdirectores Técnicos o de Enlace) **invalidan las apreciaciones preliminares del ajustador** si estas últimas no han sido corregidas en el texto principal.
    - **Prioridad de fuente**: Oficio Oficial > Correo de Dependencia > Reporte del Ajustador.
    - Si un anexo indica "trazo diferente al autorizado", esto debe reflejarse en \`advertencias\` como alerta crítica.

    ### RF5: Separación de Datos Económicos vs. Logísticos (Anti-Mezcla de Unidades)
    - **VALIDACIÓN MONETARIA OBLIGATORIA**:
        - El campo \`totalPdf\` y \`importe\` de las líneas SOLO pueden contener valores que provengan de columnas etiquetadas como: "Importe", "Total MXN", "Monto", "Costo", "Presupuesto", "$".
        - **PROHIBIDO** tomar valores de columnas como: "Largo", "Ancho", "Cantidad", "Metros", "M²", "Piezas", "Unidades".
        - Si ves un número como "90.00" junto a una unidad de medida (m, m², pzas), eso es una CANTIDAD, no un importe.
        - Los importes típicos de infraestructura están en el rango de $10,000 a $100,000,000. Si extraes un "total" de $90.00 o $150.00, **revisa si es un error**.
    - **Separación clara**:
        - **Datos Económicos**: Montos en pesos (MXN), importes, totales de presupuesto.
        - **Datos Logísticos**: Longitudes (m, km), áreas (m²), cantidades, trazos.
    - **Aunque el presupuesto no cambie entre versiones**, reporta cualquier cambio en la logística como: "Cambio logístico sin impacto económico: [descripción]".

    ### RF6: Ordenamiento Cronológico de Documentos (La Fecha Define la Verdad)
    - **ANTES de extraer datos**, identifica la **fecha de emisión** de cada documento (campo \`fechaDoc\`).
    - Si encuentras contradicciones entre un documento de junio y uno de septiembre, el de **septiembre (más reciente) invalida automáticamente** al anterior en los puntos donde coincidan.
    - **REGLA DE CRONOLOGÍA**:
        - Si procesas L50 (11 de febrero) y L50C (23 de septiembre), la información del L50C prevalece sobre L50 donde haya conflicto.
        - El orden de procesamiento de archivos NO importa; la **fecha de emisión** es el único criterio de vigencia.
    - Si el \`CONTEXTO HISTORICO\` contiene registros previos, compara sus fechas con la del documento actual:
        - **Documento actual más reciente** → Puede modificar/invalidar datos previos.
        - **Documento actual más antiguo** → Sus datos ya fueron superados por documentos posteriores (tratar con precaución).

    ### RF7: Sustitución Parcial por Ubicación (No Poner en Cero lo No Mencionado)
    - **REGLA CRÍTICA ANTI-ZEROING**: Cuando un comunicado de actualización (ej. L50C) menciona UNA ubicación específica en su cabecera o cuerpo (ej. "Unidad de Riego Aguas Blancas"), su tabla de costos **SOLO reemplaza el valor de ESA ubicación**.
    - **PROHIBIDO** poner en cero o eliminar las otras ubicaciones que NO se mencionan en el documento de actualización.
    - **Lógica de Actualización Parcial**:
        1. Si L50 original tiene 10 ubicaciones con montos.
        2. Y L50C solo menciona "UR Aguas Blancas" con monto $46,458.92.
        3. **RESULTADO**: Solo "UR Aguas Blancas" cambia a $46,458.92. Las otras 9 ubicaciones **mantienen sus montos del L50 original**.
    - **Cómo detectar alcance parcial**:
        - El documento menciona explícitamente UNA ubicación ("correspondiente a la UR...", "referente a...").
        - La tabla de costos tiene solo 1-2 filas (vs. tabla completa del original).
        - El asunto dice "Alcance", "Complemento" o "Corrección" (no "Reemplazo Total").
    - **Reporta en advertencias**: "Actualización parcial: Solo afecta a [ubicación mencionada]".

    ### RF8: Llave Compuesta (Referencia + ComunicadoId = Compartimentos Estancos)
    - **REGLA DE AISLAMIENTO**: Cada \`ComunicadoId\` (L50, L84, L22, etc.) es un **compartimento estanco**.
    - **NUNCA** sumes, mezcles o compares importes de un L50 con un L84, aunque compartan la misma Referencia de ajuste (ej. GL098774).
    - **Llave única de identificación**: \`Referencia + ComunicadoId\` (ej. "GL098774-L50" es distinto de "GL098774-L84").
    - **Actualiza solo líneas** siempre debe respetar las líneas correspondientes a comunicadoId del documento actual (ej L50, L50A, L50B comparten la misma familia, pero L84 es una familia diferente).
    - **Regla de Familias**:
        - L50, L50A, L50B, L50C = misma familia (el sufijo letra indica versión).
        - L84, L84A = otra familia completamente separada.
        - **PROHIBIDO** cruzar datos entre familias distintas.
    - Si procesas L50C, solo puedes modificar líneas de la familia L50, nunca de L84.

    ### RF9: Análisis de Exclusiones y Deducciones Narrativas
    - **EXPANDE el alcance de la extracción** más allá de las tablas numéricas.
    - Busca en los párrafos de "Apreciaciones", "Observaciones", "Notas" o correos anexos las siguientes palabras clave:
        - "no indemnizable", "absorbido", "rechazado", "excluido", "deducido", "no procedente", "no autorizado", "improcedente".
    - **Si encuentras una exclusión**:
        1. Identifica el concepto afectado (ej. "camino de acceso").
        2. Identifica el monto excluido si lo menciona.
        3. **NO incluyas ese concepto/monto** en las líneas de presupuesto, O
        4. Si ya está en la tabla, márcalo con importe = 0 y agrega advertencia: "Excluido: [concepto] - [razón]".
    - **Ejemplos de exclusiones**:
        - "El camino de acceso no es indemnizable" → Excluir de presupuesto.
        - "El monto de limpieza será absorbido por la contratista" → No contabilizar.
        - "Rechazamos el concepto de materiales de importación" → Marcar con 0.

    ---

    ## SECUENCIA DE EJECUCIÓN OBLIGATORIA (8 PASOS x 7 SUBPASOS)

    ### PASO 1: Identificación de Datos Generales y Entidades Base
    *Objetivo: Escaneo inicial del documento completo para identificar a los actores y fechas clave.*

    * **1.1 Lectura Total (Escaneo Profundo):
        - Escanea el documento completo (páginas principales + anexos). 
        - No concluyas temprano**: Suele haber tablas relevantes después del “Resumen”. 
        - Busca explícitamente páginas tituladas "HOJA GENERADORA" o "CÉDULA DE CUANTIFICACIÓN" hacia el final.

    * **1.2 Extracción de Fecha de Incidencia (FI):
        - Busca etiquetas como "Fecha de Incidencia", "F.I.", "Ocurrencia", o intervalos de fechas con "Del ... al ...".
        - Extrae el texto literal (ej. "Del 22 al 28 de septiembre de 2024"). NO lo conviertas a fecha ISO.
    
    * **1.3 Identificación de Fenómeno (Descripción Completa):
        - Busca la descripción COMPLETA del daño y el evento.
        - **CLAVE**: Busca la frase que empieza con "Daños a..." y termina con "por el paso del [FENOMENO]" o "debido a [FENOMENO]".
        - **EJEMPLO**: Si dice "Daños a infraestructura hidráulica... por el paso del Huracán John", extrae TODA la oración.
        - NO extraigas solo "Huracán John". Queremos la descripción completa del siniestro.
    
    * **1.4 Identificación de Distrito/Zona:
        - Busca "Distrito de Riego", "Dirección Local" o "Unidad". 
        - **NORMALIZACIÓN FORZADA**: Consulta la lista de "DISTRITOS DE RIEGO EXISTENTES".
        - Si el PDF dice "DIRECCIÓN LOCAL (DL) GUERRERO" y en la lista existe "DIRECCIÓN LOCAL GUERRERO", **USA EL DE LA LISTA**.
        - Ignora variaciones menores, abreviaturas entre paréntesis como "(DL)" o diferencias de espacios.
        - Tu objetivo es ENLAZAR con el existente, no crear uno nuevo.
    
    * **1.4.1 Extracción de Estado de la República (CRÍTICO):
        - **OBJETIVO**: Identificar el ESTADO DE MÉXICO donde ocurrió el siniestro.
        - **FUENTES** (en orden de prioridad):
            1. Busca la etiqueta "Estado:" o "Entidad:" en el encabezado del documento.
            2. Extrae del nombre del Distrito/Dirección Local (ej. "DIRECCIÓN LOCAL GUERRERO" → estado = "GUERRERO").
            3. Busca menciones geográficas en el cuerpo: "municipio de X, ESTADO" o "ubicado en ESTADO".
        - **NORMALIZACIÓN**: Consulta la lista de "ESTADOS EXISTENTES" del catálogo.
            - Si el PDF dice "Gro." o "Guerrero" y en la lista existe "GUERRERO", **USA EL DE LA LISTA**.
            - Extrae SOLO el nombre del estado (ej. "GUERRERO", "JALISCO", "SINALOA").
            - NO incluyas "Estado de" ni otros prefijos.
        - **REGLA DE FALLBACK**: Si no encuentras el estado explícitamente pero tienes el Distrito de Riego, infiere el estado del nombre del distrito (ej. "DR 001 PABELLON" está en Aguascalientes).
        - **NUNCA** dejes este campo como null si puedes inferirlo del contexto geográfico.

    * **1.5 Identificación de Aseguradora:
        - Busca referencias a "AGROASEMEX". 
        - Si el documento menciona otra aseguradora explícitamente, extráela. 
        - Si no, asume AGROASEMEX por defecto.
    
    * **1.6 Huella Digital del Ajustador (Visual):
        - Analiza el encabezado de la primera página. 
        - Busca logotipos o textos: "Charles Taylor", "CTA", "Miller International".
    
    * **1.7 Validación de Ajustador:
        - Compara lo encontrado en 1.6 contra el catálogo de \`ajustadores\` (si existe) para normalizar el nombre oficial (ej. "Charles Taylor Adjusting" o "Miller International").
    
    ### PASO 2: Resolución de Referencias y Ajustador
    *Objetivo: Obtener los IDs únicos del caso según la huella digital detectada.*

    * **2.1 Branching de Lógica (Bifurcación):
        - Determina el camino de extracción. 
        - Si es **CTA**, prioriza patrones "GL/AM". 
        - Si es **MILLER**, prioriza patrones "SR/No.". 
        - Si es otro, usa búsqueda genérica.
    
    * **2.2 Extracción de Referencias del Ajustador:
        - Busca el identificador único del caso.
        - Si es **CTA**, busca cerca de "Ref. CTA:" o "Referencia:". Busca códigos que empiecen por **GL**, **AM**, **CT** o **SINIESTRO**, despues de los dos puntos ":".
        - **EJEMPLO CRÍTICO**: Si dice "Ref. CTA: GL098774", tu extracción debe ser "GL098774".
        - **PROHIBIDO** extraer "CTA" o "Ref. CTA" como valor. Debes extraer el CÓDIGO.
        - Extrae la parte alfanumérica base **SIN** el guion del consecutivo (ej. de "GL098774-L50", extrae solo "GL098774").

        - Si es **MILLER**, busca "Ref. Miller:" o "Ref:". 
        - Extrae el código completo (ej. "SR-0226/2022").

    * **2.3 Extracción de la linea de Comunicado
        - Si es CTA, busca la línea "Comunicado:" o analiza el sufijo.
        - Elimina la parte "Ref. CTA:" o "Ref. Miller:" y el guion del consecutivo (ej. de "GL098774-L50") 
        - Extrae el código corto (ej. "L50" o "L50A").
    
        - Si es MILLER, busca la línea de fecha/folio con formato "No. [###]". 
        - Extrae solo el número (ej. "847").
    
    * **2.4 Extracción Ref. Siniestro (Universal):** 
        - Busca "Ref. AGROASEMEX:", "Siniestro:" o códigos con patrón "SCNA-".
        - Prioriza el formato "SCNA-XXXX/YYYY".
        - Asigna este valor a \`refSiniestro\`.
    
    * **2.5 Limpieza de IDs:** 
        - Verifica que \`comunicadoId\` no contenga la referencia base repetida. 
        - Si extrajiste "GL-L50", córtalo y deja solo "L50".
        - **CRÍTICO**: MANTÉN las letras sufijo (A, B, C...).
        - Ej: "GL-L50A" → "L50A". NO le quites la "A".

    ### PASO 3: Detección de Estatus y Tipo (Origen vs Actualización)
    *Objetivo: Clasificar si el documento es Origen o Actualización con evidencias.*

    * **3.1 Configuración Default:
        - Asume inicialmente que \`tipoRegistro\` = "ORIGEN" y \`tipoAccion\` = "NUEVO".

    * **3.2 Análisis de Sufijo (La Prueba de Fuego):
        - Analiza el \`comunicadoId\`.
        - ¿Es número base (ej. "L50")? Es candidato a ORIGEN.
        - ¿Termina en letra (ej. "L50A")? Es candidato a ACTUALIZACIÓN.

    * **3.3 Analisis de Evidencias de Actualizaciones 
    * Evidencia A (Títulos):
        - Busca en el asunto textos como: "(Actualización)", "(Adicional)", "(Alcance)", "(Complemento)".
    
    * Evidencia B (Verbos Intro):
        - Lee el primer párrafo buscando: "hacemos referencia a...", "alcance al reporte...", "continuación del reporte...".
    
    * Evidencia C (Cuerpo):
        - Busca palabras clave de modificación: "sustituye", "modifica", "cancela y reemplaza", "corrección".
    
    * **3.4 Veredicto de Estatus:
        - **SI** (Hay Evidencia A, B o C) **O** (El ID tiene sufijo de letra) → Cambia \`tipoRegistro\` = [ID del Comunicado]. 
        - **SI NO** → Mantén "ORIGEN".
    
    * **3.5 Determinación de Tipo de Acción:
        - Si es ORIGEN → "NUEVO". 
        - Si dice "Sustituye todo" → "REEMPLAZO_TOTAL". 
        - Si dice "Se agregan" → "SUSTITUCION_PARCIAL". 
        - Si no hay tablas Y NO hay montos narrativos claros → "INFORMATIVO".
        - Si el documento menciona "condicionado a", "pendiente de", "en espera de documentación", "sujeto a entrega" → "INFORMATIVO".
        - Si el monto mencionado es IDÉNTICO al del comunicado anterior (sin cambios) → "INFORMATIVO".
        - Si hay montos (tabla o narrativo) con valores DIFERENTES al anterior → "SUSTITUCION_PARCIAL" (Default seguro).
        
    * **3.6 Regla Especial para INFORMATIVO:
        - Cuando tipoAccion = "INFORMATIVO", el array \`lineas\` DEBE estar vacío [].
        - NO extraigas líneas con $0.00, eso indica que no hay cambios.
        - El sistema heredará automáticamente las líneas del comunicado anterior.

    ### PASO 4: Lógica Carry-Forward (Gestión Histórica)
    *Objetivo: Gestionar la historia con el registro previo si aplica.*

    * **4.1 Check Previo:
        - Si \`tipoRegistro\` NO es "ORIGEN", verifica si existen datos en \`REGISTRO_PREVIO\`. 
        - Si no existen, procesa solo lo actual.

    * **4.2 Definición Versión Anterior:
        - Si hay \`REGISTRO_PREVIO\`, usa su ID. 
        - Si no, infiérelo del ID actual (ej. Si actual es "L50B", el anterior lógico es "L50A").

    * **4.3 Regla de Preservación:
        - Si la acción es "SUSTITUCION_PARCIAL", asume que todas las líneas del \`REGISTRO_PREVIO\` siguen vivas, a menos que este PDF las mencione explícitamente.

    * **4.4 Regla de Reemplazo:
        - Si una ubicación del PDF actual **coincide por nombre** con una del \`REGISTRO_PREVIO\`, el **NUEVO MONTO SUSTITUYE AL ANTERIOR**. Nunca sumes; sustituye.

    * **4.5 Regla de Cancelación Explícita:
        - Si el PDF dice "Cancelado" para una línea específica, debe reportarse.

    * **4.6 Regla de Líneas Muertas (Importe Cero):
        - Si una línea tiene importe $0.00, repórtala con 0 (esto anula la suma matemática pero deja rastro de que se revisó).

    * **4.7 Construcción de Descripción (Con Contexto Histórico):**
        - Consulta el apartado 'CONTEXTO HISTÓRICO' (relatedRecords).
        - Busca si existe un registro previo de la misma familia (ej. Si procesas L50C, busca L50B, L50A o L50).
        - **SI EXISTE**: Toma la \`descripcion\` de ese registro previo y agrégale el \`comunicadoId\` actual.
             - Ejemplo: Si previo es "GL...-L50, L50A" y actual es "L50B" -> Output: "GL...-L50, L50A, L50B".
        - **SI NO EXISTE**: \`descripcion\` = "{refAjustador}-{comunicadoId}".

    ### PASO 5: Análisis de Presupuestos (Sabueso Geográfico)
    *Objetivo: Extraer montos y asignarles su identidad geográfica correcta.*

    * **5.1 Jerarquía de Fuente:
        - Prioridad A: Busca declaraciones explícitas en el cuerpo del texto como "estimar un monto preliminar de..." o "establecido preliminarmente un monto".   
        - Prioridad B: Busca tabla "RESUMEN GENERAL" o "PRESUPUESTO". 
        - Prioridad C: Si no hay A, busca "HOJA GENERADORA" o "CÉDULA DE CUANTIFICACIÓN".
        - Prioridad D: Si alguna de las columnas contiene "CONCEPTO" O "UBICACION"

    * **5.2 Mapeo de Columnas:**
        - Identifica columna Infraestructura ("Importe", "Daño Físico", "Total") e identifica columna Desazolve ("Limpieza", "Desazolve").

    * **5.3 Identidad Geográfica (CRÍTICO):**
        - Antes de extraer, define el SITIO. 
        - Si es Hoja Generadora y la fila dice "Cemento", **MIRA ARRIBA** (encabezado \`UBICACIÓN:\`).
        - Usa el sitio, no el material.

    * **5.4 Extracción de DAÑO FÍSICO:**
        - Extrae SIEMPRE el valor de la columna "Importe daño físico", INCLUSO si es $0.00.
        - Crea registro "DAÑO FISICO" con la Identidad Geográfica (Paso 5.3) y este importe.

    * **5.5 Extracción de DESAZOLVES:**
        - Extrae SIEMPRE el valor de la columna "Importe Remoción/Desazolves", INCLUSO si es $0.00.
        - Crea registro "DESAZOLVES" con la Identidad Geográfica (Paso 5.3) y este importe.

    * **5.6 Separación de Líneas (Split Multiplicativo) - REGLA OBLIGATORIA:**
        - **REGLA PRINCIPAL**: Por cada ubicación/concepto extraído, SIEMPRE debes generar **2 LÍNEAS**:
            1. Una línea con categoría "DAÑO FISICO"
            2. Una línea con categoría "DESAZOLVES"
        - Si la tabla solo muestra columna de Daño Físico sin Desazolve: Crea la línea de DESAZOLVES con importe = 0.
        - Si la tabla solo muestra columna de Desazolve sin Daño Físico: Crea la línea de DAÑO FISICO con importe = 0.
        - **MANDATO MATEMÁTICO**: Si hay 10 ubicaciones en la tabla, tu output debe tener **20 líneas** (10 DAÑO FISICO + 10 DESAZOLVES).
        - Nunca sumes los importes. Genera dos objetos independientes con la misma ubicación.
        - **PROHIBIDO** devolver solo 1 línea por ubicación. Siempre deben ser 2.
    
    * **5.7 Extracción Narrativa (PRIORIDAD D - Modo Rescate):**
        - Si no hay tablas claras o el documento es un OFICIO DE RECLAMO/ACTUALIZACIÓN, busca montos en el texto.
        - **Patrón Común**: "correspondiente a la Unidad de Riego (UR) [Nombre]... asciende a MX$[Monto]".
        - **Patrón Estimación**: "nos permitieron estimar un monto preliminar de [Monto]", "monto preliminar de [Monto]".
        - Asocia el monto encontrado ("asciende a", "estimado en", "solicitado por", "monto preliminar de", "reparación de los daños") con la ubicación mencionada.
        - **CATEGORIZACIÓN**: Si el texto menciona "reparación", "daños y estructura "reconstrucción" o es un monto global sin desglose, ASÍGNALO SIEMPRE A **"DAÑO FISICO"**. Solo usa "DESAZOLVES" si dice explícitamente "limpieza" o "desazolve".

    ### PASO 6: Consolidación y Limpieza (Detallado)
    *Objetivo: Refinar los datos crudos extraídos para asegurar consistencia y unicidad.*

    * **6.1 Agregación de Generadoras (Suma de Materiales):
        - Si extrajiste datos de "Hojas Generadoras" (donde hay 10 filas de materiales para 1 ubicación), **AGRUPA Y SUMA**. El output no debe tener "Cemento", "Varilla", "Excavación". Debe tener una sola línea por \`Concepto\` (Ubicación) y \`Categoría\` con la suma de sus componentes.

    * **6.2 Discriminación de Columnas (Anterior vs Actual):
        - Revisa si la tabla origen tenía columnas comparativas ("Contrato Anterior" vs "Importe Revisado"). Asegúrate de haber descartado los valores de "Anterior" y solo conservar los de "Actual/Revisado".

    * **6.3 ELIMINACIÓN DE MONTOS OBSOLETOS (Hard Filter):**
        - **ALERTA**: Este documento puede contener la historia del reclamo ("Apreciaciones iniciales $46k" vs "Nuevo Reclamo $1.4M").
        - **REGLA**: Si extraes DOS O MÁS montos para la misma ubicación (historial vs actual):
            1. Identifica cuál es "Preliminar/Inicial/Anterior" y cuál es "Solicitado/Nuevo/Actual".
            2. **ELIMINA EL PRELIMINAR**.
            3. Tu output FINAL para "Unidad de Riego Aguas Blancas" debe tener SOLO UNA LÍNEA (la del Nuevo Reclamo/Mayor valor).
        - **EXCEPCIÓN CRÍTICA**: Si SOLO encuentras un "monto preliminar" y no hay otro monto posterior, **MANTENLO**. Es la estimación vigente.
        - No devuelvas el historial. Solo el estado final.

    * **6.4 Normalización Numérica:
        - Recorre todos los importes extraídos. Elimina símbolos \`$\`, comas \`,\`, y textos \`MXN\`. Convierte todo a formato numérico puro (Float).

    * **6.5 Entity Resolution de Conceptos (Homologación):
        - Si tienes \`REGISTRO_PREVIO\`, compara los nombres de las ubicaciones. Si el PDF dice "Canal Lat. Coyuca" y el previo "Canal Lateral Coyuca de Benitez", renombra el nuevo para que coincida con el histórico (si la similitud es evidente).

    * **6.6 Validación de Integridad de Conceptos:
        - Verifica que el campo \`Concepto\` no contenga palabras prohibidas como "Suministro", "Acarreo" o "Lote". Si las contiene, significa que falló el Paso 5.3; intenta corregirlo usando el nombre del Distrito o el Título del documento.

    * **6.7 Limpieza de Líneas Vacías (EXTREMA PRECAUCIÓN):
        - **PROHIBIDO ELIMINAR** líneas con importe $0.00 si su categoría es "DAÑO FISICO" o "DESAZOLVES". 
        - Estos valores son estructurales y deben conservarse para el historial.
        - Solo elimina líneas si son \`null\` o basura de OCR.

    ### PASO 7: Integración Final y Auditoría (Detallado)
    *Objetivo: Ensamblar el JSON final y realizar las últimas validaciones matemáticas.*

    * **7.1 Ensamble del Header (Metadatos):
        - Compila en el objeto \`header\` todas las variables: \`refAjustador\`, \`ajustadorNombre\`, \`comunicadoId\`, \`tipoRegistro\`, \`versionAnterior\`, \`fechaDoc\`, \`estado\`, \`aseguradora\`, \`refSiniestro\`, \`fenomeno\`, \`fi\`, \`fondo\`, \`distritoRiego\`.

    * **7.2 Inyección de Acción y Descripción:
        - Inserta en el \`header\` los campos calculados: \`tipoAccion\` (del paso 3.7) y \`descripcion\` (del paso 4.7).

    * **7.3 Ensamble del Array de Líneas:
        - Compila el array \`lineas\` con los objetos resultantes de la consolidación del Paso 6 (\`concepto\`, \`categoria\`, \`importe\`).
        - **MANDATO IMPERATIVO**: Debes incluir en este array final TODAS las líneas que aparezcan en la tabla del documento, **incluyendo explícitamente aquellas con importe $0.00**.
        - Si la tabla lista el concepto con $0.00, el JSON debe tener \`{"importe": 0.0}\`. NO las ocultes.

    * **7.4 Cálculo Matemático del Total (Re-Check):
        - Calcula una variable interna \`sumaCalculada\` sumando los importes del array \`lineas\` final. **IGNORA** el "Gran Total" impreso en el PDF si difiere de tu suma; tu suma es la verdad matemática de los datos extraídos. Asigna esto a \`header.totalPdf\`.

    * **7.5 Generación de Advertencias (Logs):
        - Crea el array \`header.advertencias\`. Si consolidaste Hojas Generadoras, agrega: "Extracción agrupada desde Hojas Generadoras". Si corregiste un ID, agrega: "ID corregido". Si usaste un catálogo, agrega: "Entidad normalizada por catálogo".

    * **7.6 Validación de Estructura JSON:
        - Verifica que no falte ninguna llave obligatoria definida en el Paso 8. Asegura que los tipos de datos sean correctos (números como números, strings como strings).

    * **7.7 Sello de Calidad (Regla de Salida):
        - Si \`tipoAccion\` es "INFORMATIVO", el array \`lineas\` puede estar vacío. En cualquier otro caso, si \`lineas\` está vacío, revisa nuevamente el Paso 5 (algo salió mal).
|
    ### PASO 8: Output (JSON Estricto)
    *Objetivo: Generar el entregable final sin ruido.*

    * **8.1 Definición de Raíz:
        - El JSON debe tener una raíz con dos llaves: \`"header"\` y \`"lineas"\`.
        
    * **8.2 Definición de Header:
        - Debe contener estrictamente: \`refAjustador\` (El CÓDIGO, no el nombre), \`ajustadorNombre\`, \`comunicadoId\`, \`tipoRegistro\`, \`versionAnterior\`, \`ubicacionEspecifica\`, \`tipoAccion\`, \`descripcion\`, \`fechaDoc\`, \`estado\`, \`refSiniestro\`, \`aseguradora\`, \`fenomeno\`, \`fi\`, \`fondo\`, \`distritoRiego\`, \`distritoRiegoAccion\`, \`totalPdf\`, \`advertencias\`.

    * **8.3 Definición de Líneas:
        - Debe ser un array de objetos con: \`"concepto"\`, \`"categoria"\`, \`"importe"\`.

    * **8.4 Formato de Categorías:
        - Las categorías permitidas son SOLO: \`"DAÑO FISICO"\` o \`"DESAZOLVES"\`.

    * **8.5 Formato de Fecha:
        - Usa siempre \`YYYY-MM-DD\`. Si no hay fecha exacta, usa \`null\`.

    * **8.6 Restricción de Texto:
        - No incluyas explicaciones, saludos ni markdown de bloque de código si no se pide explícitamente, pero para este prompt, asume salida cruda.

    * **8.7 Disparo de Salida:
        - Genera el JSON final ahora.

    {
    "header": {
        "refAjustador": "string (The Alphanumeric Code e.g. GL098774. NOT 'CTA')",
        "ajustadorNombre": "string",
        "comunicadoId": "string",
        "tipoRegistro": "string",
        "versionAnterior": "string",
        "ubicacionEspecifica": "string",
        "tipoAccion": "string (NUEVO|REEMPLAZO_TOTAL|SUSTITUCION_PARCIAL|INFORMATIVO)",
        "descripcion": "string",
        "fechaDoc": "YYYY-MM-DD",
        "estado": "string",
        "refSiniestro": "string",
        "aseguradora": "string",
        "fenomeno": "string",
        "fi": "string",
        "fondo": "string",
        "distritoRiego": "string",
        "distritoRiegoAccion": "Actualiza|Mantener|Sin Dato",
        "totalPdf": 0.00,
        "advertencias": ["string"]
    },
    "lineas": [
        {
        "concepto": "string",
        "categoria": "DAÑO FISICO|DESAZOLVES",
        "importe": 0.00
        }
    ]
    }
    \`\`\`
    `;

    if (catalogs) {
        promptSystem += `

        ## CATÁLOGOS VÁLIDOS (Entity Resolution):
        REGLA CRÍTICA: Para cada campo catalogado, BUSCA coincidencias en la lista. 
        Si encuentras algo SIMILAR (aunque varíe en redacción, abreviaturas o acentos), USA EL VALOR EXISTENTE.
        Ejemplos de matching:
        - "Dir. Local Campeche" = "DIRECCIÓN LOCAL CAMPECHE" -> Usa: "DIRECCIÓN LOCAL CAMPECHE"
        - "DTT 011" = "DISTRITO DE TEMPORAL 011" -> Usa el existente
        - "Agroasemex" = "AGROASEMEX" -> Usa: "AGROASEMEX"

`;
        if (catalogs.distritos && catalogs.distritos.length > 0)
            promptSystem += `- DISTRITOS DE RIEGO EXISTENTES: ${JSON.stringify(catalogs.distritos.slice(0, 100))}
`;
        if (catalogs.ajustadores && catalogs.ajustadores.length > 0)
            promptSystem += `- AJUSTADORES EXISTENTES: ${JSON.stringify(catalogs.ajustadores.slice(0, 50))}
`;
        if (catalogs.siniestros && catalogs.siniestros.length > 0)
            promptSystem += `- SINIESTROS EXISTENTES: ${JSON.stringify(catalogs.siniestros.slice(0, 50))}
`;
        if (catalogs.fenomenos && catalogs.fenomenos.length > 0)
            promptSystem += `- FENÓMENOS EXISTENTES: ${JSON.stringify(catalogs.fenomenos.slice(0, 100))}
`;
        if (catalogs.aseguradoras && catalogs.aseguradoras.length > 0)
            promptSystem += `- ASEGURADORAS EXISTENTES: ${JSON.stringify(catalogs.aseguradoras.slice(0, 50))}
`;
        if (catalogs.estados && catalogs.estados.length > 0)
            promptSystem += `- ESTADOS EXISTENTES (DE LA REPÚBLICA MEXICANA): ${JSON.stringify(catalogs.estados)}
`;

        promptSystem += `
**PRIORIDAD**: Si un valor del PDF coincide (incluso parcialmente) con un catálogo existente, DEVUELVE EL VALOR DEL CATÁLOGO, no el texto literal del PDF.`;
    }

    // Inyectar conceptos de ubicación existentes para Entity Resolution
    if (existingConcepts && existingConcepts.length > 0) {
        promptSystem += `

## CONCEPTOS DE UBICACION EXISTENTES (ENTITY RESOLUTION - CRITICO)
Los siguientes conceptos/ubicaciones YA EXISTEN en el sistema. Si extraes un concepto SIMILAR a alguno de esta lista, USA EL NOMBRE EXACTO de la lista:

${existingConcepts.map(c => `- "${c}"`).join('\n')}

REGLA DE MATCHING:
- "Unidad de Riego (UR) Aguas Blancas" -> USA: "Unidad de Riego Aguas Blancas"
- "UR Coyuquilla" -> USA: "Unidad de Riego Coyuquilla Norte"
- Solo crea un nombre NUEVO si NO hay coincidencia razonable con la lista.`;
    }

    // Inyectar CONTEXTO DE BASE DE DATOS (Formato Unificado {header, lineas})
    // Este es el mismo formato que la IA debe generar, para consistencia total
    if (relatedRecords && relatedRecords.length > 0) {
        promptSystem += `

## CONTEXTO DE BASE DE DATOS (REGISTROS EXISTENTES - FORMATO UNIFICADO)
Los siguientes registros ya existen en la base de datos para la misma cuenta.
Tienen el **MISMO FORMATO** que debes generar en tu salida.

### USOS PERMITIDOS:
1. **Construir \`header.descripcion\`** - El historial debe acumularse (ej: "GL...-L50, L50A, L50B")
2. **Entity Resolution de conceptos** - Si un concepto del PDF es similar a uno existente, USA EL NOMBRE EXISTENTE
3. **Detectar tipoRegistro** - Si el comunicadoId actual es actualización de uno en esta lista

### PROHIBICIONES ESTRICTAS:
- ❌ **NUNCA** copies líneas de estos registros al output
- ❌ **NUNCA** sumes o fusiones importes de estos registros con el PDF
- ❌ Tu extracción de líneas debe ser 100% del PDF actual

\`\`\`json
${JSON.stringify(relatedRecords.slice(0, 5), null, 2)}
\`\`\`

**EJEMPLO DE USO CORRECTO:**
Si procesas "L50B" y el contexto tiene L50A con descripcion "GL098774-L50, L50A":
→ Tu \`header.descripcion\` debe ser "GL098774-L50, L50A, L50B"

Si procesas un concepto "Canal Lat. Coyuca" y en el contexto existe "Canal Lateral Coyuca":
→ Tu línea debe usar "Canal Lateral Coyuca" (el nombre normalizado)`;
    }

    // =========================================================================
    // REGLA DE AISLAMIENTO DE FAMILIAS (RF8.1) - Inyección crítica
    // =========================================================================
    const familiaActual = _extractFamily(comunicadoId);
    if (familiaActual) {
        promptSystem += `

## ⚠️ REGLA CRÍTICA: AISLAMIENTO DE FAMILIAS (RF8.1)

**CONTEXTO ACTUAL:**
- Este documento pertenece a la familia: **${familiaActual}**
- ComunicadoId actual: **${comunicadoId}**
- SOLO puedes usar información de registros de esta misma familia para construir la descripción

**REGLA PARA CONSTRUIR \`header.descripcion\`:**
- La descripción debe construirse ÚNICAMENTE con comunicados de la misma familia ${familiaActual}
- Familias permitidas: ${familiaActual}, ${familiaActual}A, ${familiaActual}B, ${familiaActual}C, etc.
- NUNCA incluyas IDs de otras familias (L80, L81, etc. si estás procesando ${familiaActual})

**EJEMPLO CORRECTO:**
- Si procesas ${familiaActual}C y el contexto tiene ${familiaActual}A:
  - descripcion = "GL...-${familiaActual}, ${familiaActual}A, ${familiaActual}C" ✅
- NUNCA: "GL...-L80, L81, ${familiaActual}C" ❌ (mezcla de familias)

**PROHIBICIONES ESTRICTAS:**
- ❌ PROHIBIDO usar descripciones de otras familias (L80 ≠ L81 ≠ L50)
- ❌ PROHIBIDO mezclar narrativas de diferentes familias
- ❌ PROHIBIDO heredar contexto de una familia a otra

**VERIFICACIÓN FINAL:**
- Antes de generar la descripción, verifica que TODOS los IDs listados pertenezcan a la familia ${familiaActual}
- Si ves IDs de otras familias en el contexto, IGNÓRALOS completamente
`;
    }

    // =========================================================================
    // FASE 2B: "EL CIRUJANO" - Prompt Completo para Modo Actualización
    // Solo se inyecta cuando NO es origen Y hay líneas esperadas
    // =========================================================================
    if (!esOrigen && expectedLines && expectedLines.length > 0) {
        console.log(`[_callGeminiWithPdf] FASE 2B: Inyectando ${expectedLines.length} partidas vigentes para análisis diferencial`);
        promptSystem += `

## ⚡ FASE 2B: MODO ACTUALIZACIÓN (El Cirujano)

**ROL:** Auditor de Ajustes Financieros (Modo Diferencial).
**CONTEXTO:** Estamos actualizando el presupuesto. Ya existen partidas en la base de datos.
**MISIÓN:** Detectar SOLO los CAMBIOS entre el PDF y las partidas existentes.

---

### PARTIDAS VIGENTES EN BASE DE DATOS:
\`\`\`json
${JSON.stringify(expectedLines.map((l, i) => ({
            id_bd: l.id_bd || (i + 100),
            concepto: l.concepto,
            categoria: l.categoria,
            importe_actual: l.importe_previo || 0
        })), null, 2)}
\`\`\`

---

### PASO 5: Mapeo y Detección (El Radar)
*Objetivo: Cruzar el PDF contra las Partidas Vigentes.*

* **5.1 Lectura de Contexto:** Tienes arriba las "PARTIDAS VIGENTES" (id_bd, concepto, importe_actual).
* **5.2 Búsqueda de Coincidencias:** Busca cada concepto del contexto dentro del PDF.
* **5.3 Manejo de "No Encontrado":** Si una partida del contexto NO aparece en el PDF → acción **"MANTENER"** con \`importe: null\`. (NO es cero, es null = sin cambios).
* **5.4 Detección de Nuevos:** Si encuentras una partida en el PDF que NO está en el contexto → acción **"CREAR"**.
* **5.5 Prioridad de Columnas:** Ignora "Importe Anterior" o "Reclamado". Busca "Importe Revisado", "Autorizado", "CTA".
* **5.6 Validación de Moneda:** NO extraigas "Precios Unitarios" como importes. Verifica la columna.
* **5.7 Agrupación de Generadoras:** Si el PDF desglosa materiales para una partida existente, suma los materiales y presenta el TOTAL.

### PASO 6: Lógica de Estado (El Juez) - REGLAS CRÍTICAS
*Objetivo: Determinar la acción exacta basándose en la evidencia del texto.*

| Situación en Texto | Acción | Importe Salida |
|-----------|--------|---------|
| ID existe Y monto cambió | **ACTUALIZAR** | nuevo monto |
| ID existe Y NO aparece en PDF | **MANTENER** | \`null\` |
| "Cancelado", "Improcedente", "No autorizado" | **CANCELAR** | \`0\` |
| **Valor $0.00 en tabla (sin nota de cancelación)** | **MANTENER** | \`null\` |
| Concepto NUEVO (no en contexto) | **CREAR** | monto del PDF |
| "Se solicita bitácora", "Pendiente de acreditar", "Sujeto a revisión" | **MANTENER** | \`null\` |
| "Se confirma existencia de material" pero "falta soporte" | **MANTENER** | \`null\` |
| No se menciona la ubicación | **MANTENER** | \`null\` |

* **6.1 REGLA DE ESTADOS CONDICIONADOS (CRÍTICO):**
    - Si el texto contiene frases como:
      - "pendiente de acreditar"
      - "sujeto a revisión"
      - "se solicita bitácora" / "se solicita planos"
      - "pendiente de información"
      - "en espera de documentación"
      - "condicionado a entrega de..."
      - "necesario contar con..."
    - **PROHIBIDO** poner \`importe: 0\`. Eso significaría CANCELACIÓN.
    - Tu acción debe ser **"MANTENER"** con \`importe: null\`.
    - El sistema heredará automáticamente el monto del comunicado anterior.

* **6.2 REGLA DE DESAZOLVES (Split Obligatorio):**
    - Si el documento discute "limpieza", "remoción" o "material de azolve":
    - Busca en el contexto (Partidas Vigentes) si existe una línea con categoría **"DESAZOLVES"**.
    - Si el texto pide planos/bitácoras para liberar el pago → Tu acción es **"MANTENER"**.
    - **PROHIBIDO** poner importe 0 si solo están pidiendo documentación.

* **6.3 REGLA DE HERENCIA DUAL (Split Multiplicativo):**
    - Si en el contexto (Partidas Vigentes) una ubicación tiene 2 líneas (Daño Físico + Desazolves):
    - Y el PDF menciona la ubicación de forma general (ej. "En el Vado Saca Cosechas..."):
    - Debes reportar el estado de **AMBAS** líneas en tu JSON de salida.
    - Ejemplo: Si solo hablan de desazolve, reporta:
      - Desazolves: MANTENER/ACTUALIZAR según corresponda
      - Daño Físico: MANTENER (con \`importe: null\`)

* **6.4 DIFERENCIA CRÍTICA ENTRE CANCELAR Y MANTENER:**
    - \`"CANCELAR"\` con \`importe: 0\` = La partida fue RECHAZADA, no se pagará NUNCA.
    - \`"MANTENER"\` con \`importe: null\` = La partida sigue VIGENTE, esperando documentación.
    - Si el documento NO RECHAZA explícitamente la partida, usa MANTENER.

* **6.5 Resolución de Conflictos:** Si hay dos montos (resumen vs detalle), el Detalle manda.
* **6.6 No Inventar:** Si no estás seguro de un concepto, NO lo incluyas.
* **6.7 Verificar IDs:** Devuelve el \`id_bd\` correcto del JSON de entrada.

* **6.8 REGLA DE JERARQUÍA DE TABLAS (Resumen vs Detalle):**
    - **CONFLICTO:** Si la Tabla Resumen dice "Daño Físico: $0.00" pero la Tabla Detallada muestra materiales, **EL RESUMEN MANDA SOBRE EL TOTAL**.
      - Significa que esos materiales ya no se cobran o son informativos.
      - Acción: **MANTENER** con \`null\` (o 0 si dice Cancelado).
    
    - **EXTRACCIÓN DE UBICACIONES:**
      - **NUNCA** extraigas líneas de la Tabla Resumen (ej. no quiero una línea llamada "Total" o "Suma").
      - Extrae líneas SOLO de la Tabla Detallada donde aparezcan las ubicaciones (ej. "Río Marabasco km 8+400").

* **6.9 REGLA MAESTRA DE ALCANCE (SCOPE):**
    *Objetivo: Diferenciar qué se actualiza y qué se mantiene intacto.*
    
    - **Paso A: Identificar Ubicación Activa:**
      - ¿Qué ubicación menciona el encabezado o el detalle? (Ej. "Tramo El Rincón").

    - **Paso B: Aplicar Lógica Diferencial:**
      | Situación | Acción JSON | Importe |
      | :--- | :--- | :--- |
      | Ubicación Activa + Tabla Resumen dice $0.00 | **ACTUALIZAR** | \`0\` (Cero Real confirmado por Resumen) |
      | Ubicación Activa + Tabla Resumen dice $X | **ACTUALIZAR** | \`X\` (Monto del Detalle validado) |
      | Ubicación **NO** mencionada en este PDF | **MANTENER** | \`null\` (Protección histórica) |

* **6.10 REGLA DE CONFIRMACIÓN CONTEXTUAL (Suma Coincidente):**
    *Objetivo: Detectar comunicados informativos donde no hay cambios reales.*
    
    - **Paso A: Detección de Confirmación:**
      - Si el PDF menciona un monto total para una ubicación (ej. "Río Tamaulipas: $2,000,000").
      - Y en las PARTIDAS VIGENTES esa ubicación tiene líneas que SUMAN ese monto.
        - Ejemplo: Río Tamaulipas DAÑO FÍSICO = $1,000,000 + Río Tamaulipas DESAZOLVES = $1,000,000 = $2,000,000.
      - **INTERPRETACIÓN:** El comunicado es INFORMATIVO. No hay cambios individuales.

    - **Paso B: Acción para Confirmación:**
      | Situación | Acción JSON | Importe |
      | :--- | :--- | :--- |
      | Total PDF = Suma de líneas existentes | **MANTENER** TODAS las líneas | \`null\` (copiar del anterior) |
      | Total PDF ≠ Suma de líneas existentes | Aplicar lógica normal (6.9) | según corresponda |

    - **EJEMPLO:**
      - BD tiene: "Río Tamaulipas" con Daño=$1M, Desazolve=$1M (Total=$2M).
      - PDF L05B dice: "Se confirma importe de $2,000,000 para Río Tamaulipas".
      - **Salida Correcta (INFORMATIVO):**
        1. Río Tamaulipas (Daño Físico): MANTENER → null
        2. Río Tamaulipas (Desazolves): MANTENER → null
      - El sistema heredará automáticamente $1M y $1M del L05A.

### PASO 7: Normalización
* **7.1 Montos:** Sin signos de peso, sin comas. Formato numérico.
* **7.2 Categorías:** "DAÑO FISICO" o "DESAZOLVES".
* **7.3 Validación:** \`null\` = No tocar. \`0\` = Cancelar/Cero.

### PASO 8: Output JSON (Deltas)
Genera el JSON con estructura \`{header, lineas}\`. Cada línea debe tener \`accion\`.

**Formato Esperado:**
\`\`\`json
{
  "header": {
    "refCta": "GL098774",
    "comunicadoId": "L50B",
    "tipoRegistro": "Actualización",
    "totalPdf": 150000.00,
    "descripcion": "GL098774-L50, L50A, L50B"
  },
  "lineas": [
    {
      "id_bd": 105,
      "concepto": "Unidad de Riego Aguas Blancas",
      "categoria": "DAÑO FISICO",
      "accion": "ACTUALIZAR",
      "importe": 55000.50,
      "razon": "Ajuste en generadora pág 4"
    },
    {
      "id_bd": 106,
      "concepto": "Unidad de Riego Coyuca",
      "categoria": "DESAZOLVES",
      "accion": "MANTENER",
      "importe": null,
      "razon": "No mencionado en este comunicado"
    },
    {
      "id_bd": 107,
      "concepto": "Canal Principal",
      "categoria": "DAÑO FISICO",
      "accion": "CANCELAR",
      "importe": 0,
      "razon": "Marcado como cancelado en PDF"
    },
    {
      "id_bd": null,
      "concepto": "Nueva Ubicación Adicional",
      "categoria": "DAÑO FISICO",
      "accion": "CREAR",
      "importe": 8500.00,
      "razon": "Concepto nuevo en este comunicado"
    }
  ]
}
\`\`\`

**REGLAS CRÍTICAS:**
- Si el concepto NO aparece en el PDF → \`"accion": "MANTENER"\` + \`"importe": null\`
- Si el concepto tiene $0.00 explícito o dice "Cancelado" → \`"accion": "CANCELAR"\` + \`"importe": 0\`
- NUNCA inventes importes. Si no lo ves, no lo reportes.
`;
    }

    // =========================================================================
    // REGLAS ESPECIALES PARA ACTUALIZACIONES INFORMATIVAS (L03A, L04A, etc.)
    // Se inyectan SOLO cuando NO es origen (modo actualización)
    // =========================================================================
    if (!esOrigen) {
        promptSystem += `

    ### PASO CRÍTICO: REGLAS PARA ACTUALIZACIONES INFORMATIVAS (L03A, L04A, etc.)
    *Objetivo: No destruir el presupuesto anterior si el documento solo pide requisitos.*

    * **REGLA 1: NO INTERPRETAR "PENDIENTE" COMO CERO ($0.00)**
        - Si el texto dice: "es necesario contar con bitácoras", "sujeto a revisión", "se solicita información", "pendiente de acreditar".
        - TU ACCIÓN DEBE SER: **"MANTENER"**.
        - TU IMPORTE DEBE SER: **null** (No pongas 0.00, pon null).
        - Razón: $0.00 significa "cancelado/rechazado". null significa "sin cambios por ahora".

    * **REGLA 2: HERENCIA DUAL (EL SPLIT OBLIGATORIO)**
        - **Situación:** El documento L03A menciona "Vado Saca Cosechas" (o cualquier ubicación).
        - **Contexto:** En la base de datos (ver 'PARTIDAS VIGENTES' arriba) esa ubicación tiene 2 líneas: "DAÑO FÍSICO" y "DESAZOLVES".
        - **Instrucción:** Si el documento NO cancela explícitamente ninguna, DEBES REPORTAR AMBAS.
        - Aunque el texto solo hable de "material de azolve", tú debes devolver:
            1. { "concepto": "Vado Saca Cosechas...", "categoria": "DAÑO FISICO", "accion": "MANTENER", "importe": null }
            2. { "concepto": "Vado Saca Cosechas...", "categoria": "DESAZOLVES", "accion": "MANTENER", "importe": null }
    
    * **REGLA 3: PROHIBIDO FUSIONAR**
        - Nunca mezcles "Daño Físico" y "Desazolves" en una sola línea si en el origen estaban separadas.
        - Si en PARTIDAS VIGENTES hay N líneas para una ubicación, tu output debe tener al menos N líneas para esa ubicación.

    * **REGLA 4: CUENTA LAS LÍNEAS DEL CONTEXTO**
        - ANTES de generar tu respuesta, CUENTA cuántas líneas hay en "PARTIDAS VIGENTES".
        - Tu output DEBE tener AL MENOS esa cantidad de líneas (una por cada partida vigente).
        - Cada línea del contexto debe aparecer en tu output con alguna acción (MANTENER/ACTUALIZAR/CANCELAR).

    * **REGLA 5: SIN TABLA DE MONTOS = NULL (NO CERO)**
        - Si el PDF NO contiene una tabla con montos nuevos/actualizados:
        - TODAS las líneas deben tener **"accion": "MANTENER"** y **"importe": null**.
        - NO pongas 0.00. Eso significa CANCELACIÓN.
        - Si el PDF solo tiene texto narrativo (sin tabla de precios), usa null para TODAS las líneas.
        - La palabra clave JSON es: null (sin comillas, no es string).

    * **REGLA 6: DIFERENCIA CRÍTICA - CUÁNDO USAR 0 vs null**
        | Situación en PDF | importe en JSON |
        |------------------|-----------------|
        | PDF dice "Cancelado", "Improcedente", "Rechazado" | **0** |
        | PDF tiene tabla con nuevo monto $X | **X** (el nuevo monto) |
        | PDF NO tiene tabla de montos | **null** |
        | PDF pide documentación: "se solicita bitácora" | **null** |
        | PDF menciona ubicación pero sin monto nuevo | **null** |
        | PDF NO menciona la ubicación | **null** |

    * **REGLA 7: CASO NARRATIVO (PDF SIN TABLAS DE DESGLOSE FINANCIERO)**
        - **Detección:** El documento es SOLO TEXTO INFORMATIVO, no contiene ninguna tabla con desglose de precios, presupuesto ni montos financieros.
        - **Frases Clave:** "será necesario contar con un dictamen", "se solicita presupuesto", "pendiente de cuantificación", "se remitirá estimación".
        - **Acción Obligatoria:** Devuelve un array VACÍO de líneas: \`"lineas": []\`
        - **NO INVENTES DATOS:** Si no hay tabla financiera, no hay líneas que extraer.
        - **El Sistema Backend:** Detectará el array vacío y MANTENDRÁ automáticamente las líneas del comunicado anterior.
        - **Ejemplo de Salida:**
        \`\`\`json
        {
          "header": { "refCta": "...", "comunicadoId": "L01A", "tipoRegistro": "Actualización", "tipoAccion": "INFORMATIVO", "totalPdf": 0, "descripcion": "..." },
          "lineas": []
        }
        \`\`\`

    * **REGLA 8: CASO CONCEPTOS NUEVOS (ADICIONALES - L01B, L50B, etc.)**
        - **Detección:** El documento contiene tablas con conceptos que NO EXISTEN en "PARTIDAS VIGENTES".
        - **Ejemplos:** PDF trae "Compuertas radiales", "Chumaceras" pero el contexto tiene "Canal Principal", "Desazolves".
        - **Acción Obligatoria:** Cada concepto nuevo debe tener \`"accion": "CREAR"\` y \`"id_bd": null\`.
        - **NO FUSIONES:** No intentes hacer match forzado entre conceptos incompatibles.
        - **Genera Ambos:** Si el PDF trae conceptos nuevos Y el contexto tiene conceptos existentes no mencionados:
            1. Los conceptos nuevos del PDF: \`"accion": "CREAR"\`
            2. Los conceptos del contexto no mencionados: \`"accion": "MANTENER", "importe": null\`
        - **Resultado:** El sistema guardará AMBOS conjuntos (los nuevos + los anteriores heredados).
        - **Ejemplo de Salida Mixta:**
        \`\`\`json
        {
          "header": { "refCta": "...", "comunicadoId": "L01B", "tipoRegistro": "Actualización", "tipoAccion": "SUSTITUCION_PARCIAL", "totalPdf": 150000 },
          "lineas": [
            { "id_bd": null, "concepto": "Compuertas Radiales", "categoria": "DAÑO FISICO", "accion": "CREAR", "importe": 80000 },
            { "id_bd": null, "concepto": "Chumaceras", "categoria": "DAÑO FISICO", "accion": "CREAR", "importe": 70000 },
            { "id_bd": 105, "concepto": "Canal Principal", "categoria": "DAÑO FISICO", "accion": "MANTENER", "importe": null },
            { "id_bd": 106, "concepto": "Desazolves Lateral Norte", "categoria": "DESAZOLVES", "accion": "MANTENER", "importe": null }
          ]
        }
        \`\`\`

    * **REGLA 9: RESUMEN DE ACCIONES (DECISIÓN RÁPIDA)**
        | Situación | tipoAccion Header | Acción Líneas |
        |-----------|-------------------|---------------|
        | PDF sin tabla financiera (solo texto) | **INFORMATIVO** | \`"lineas": []\` (vacío) |
        | PDF con conceptos 100% nuevos | **SUSTITUCION_PARCIAL** | CREAR para nuevos, MANTENER para existentes |
        | PDF actualiza montos de conceptos existentes | **ACTUALIZACION** | ACTUALIZAR los que cambian |
        | PDF cancela conceptos | **ACTUALIZACION** | CANCELAR con importe 0 |
        | PDF mezcla todo (actualiza + crea + cancela) | **SUSTITUCION_PARCIAL** | Cada línea según corresponda |
    `;
    }

    // =========================================================================
    // INYECCIÓN DE REGLAS COMUNES (Pasos 5, 6, 7, 8)
    // Se aplican tanto a ORIGEN como a ACTUALIZACIÓN
    // =========================================================================
    promptSystem += `

---
## REGLAS DE EXTRACCIÓN Y FORMATO (OBLIGATORIAS)
${PROMPT_CORE_EXTRACTION}
`;

    if (errorFeedback) {
        promptSystem += `

ATENCIÓN: TU INTENTO ANTERIOR FALLÓ CON ESTE ERROR: "${errorFeedback}".
REVISA TUS CÁLCULOS Y EL FORMATO JSON.`;
    }

    // Payload con PDF como inline_data (multimodal)
    const payload = {
        contents: [{
            parts: [
                { text: promptSystem },
                {
                    inline_data: {
                        mime_type: "application/pdf",
                        data: base64Content
                    }
                },
                { text: `Analiza el documento PDF adjunto (${filename}) y extrae los datos según el formato especificado.` }
            ]
        }],
        // FIX: Desactivar filtros de seguridad para contenido de siniestros (huracanes, daños, destrucción, colapso, etc.)
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ],
        generationConfig: {
            response_mime_type: "application/json"
        }
    };

    const options = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
    };

    // Loop de reintentos con backoff exponencial para Rate Limit (429)
    let rateLimitRetries = 0;

    while (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        const response = UrlFetchApp.fetch(url, options);
        const code = response.getResponseCode();
        const text = response.getContentText();

        console.log(`[Gemini API] Response code: ${code}`);

        if (code === 200) {
            // Éxito - Procesar respuesta
            try {
                const respJson = JSON.parse(text);

                // =====================================================================
                // LOG DE CONSUMO DE TOKENS (Prompt + PDF + Contexto BD)
                // =====================================================================
                if (respJson.usageMetadata) {
                    const usage = respJson.usageMetadata;
                    console.log(`[📊 TOKENS] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                    console.log(`[📊 TOKENS] 📥 Prompt (Sistema + PDF + Contexto): ${usage.promptTokenCount || 'N/A'} tokens`);
                    console.log(`[📊 TOKENS] 📤 Respuesta IA: ${usage.candidatesTokenCount || 'N/A'} tokens`);
                    console.log(`[📊 TOKENS] 📊 TOTAL: ${usage.totalTokenCount || 'N/A'} tokens`);
                    console.log(`[📊 TOKENS] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                }

                // Verificar si hay candidatos válidos
                if (!respJson.candidates || respJson.candidates.length === 0) {
                    console.error('[Gemini API] No hay candidatos en la respuesta:', text);
                    throw new Error('Gemini no devolvió candidatos. Posible contenido bloqueado o error interno.');
                }

                const candidate = respJson.candidates[0];

                // Verificar si el candidato fue bloqueado
                if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'BLOCKED') {
                    console.error('[Gemini API] Contenido bloqueado:', candidate);
                    throw new Error(`Contenido bloqueado por políticas de seguridad: ${candidate.finishReason}`);
                }

                if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
                    console.error('[Gemini API] Estructura de respuesta inesperada:', text);
                    throw new Error('Estructura de respuesta Gemini inválida.');
                }

                const rawContent = candidate.content.parts[0].text;
                console.log(`[Gemini API] Respuesta recibida: ${rawContent.substring(0, 200)}...`);

                // FIX: Extracción robusta de JSON usando regex para ignorar texto extra
                const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
                if (!jsonMatch) {
                    throw new Error('No se encontró un objeto JSON válido en la respuesta de Gemini.');
                }
                const cleanJson = jsonMatch[0];
                const parsedResult = JSON.parse(cleanJson);

                // COMPATIBILIDAD (v6.3): Mapear refAjustador -> refCta para el resto del sistema
                if (parsedResult.header && parsedResult.header.refAjustador && !parsedResult.header.refCta) {
                    parsedResult.header.refCta = parsedResult.header.refAjustador;
                }

                return parsedResult;

            } catch (parseError) {
                console.error('[Gemini API] Error parseando respuesta:', parseError.message);
                console.error('[Gemini API] Respuesta cruda:', text.substring(0, 500));
                throw new Error(`Error parseando respuesta Gemini: ${parseError.message}`);
            }
        }

        if (code === 429) {
            rateLimitRetries++;
            const waitTime = BASE_429_WAIT_MS * Math.pow(2, rateLimitRetries - 1);
            console.warn(`[Gemini 429] Rate Limit alcanzado (Intento ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}). Esperando ${waitTime / 1000}s...`);
            Utilities.sleep(waitTime);
        } else {
            console.error(`[Gemini API] Error HTTP ${code}:`, text.substring(0, 500));
            throw new Error(`Gemini API Error (${code}): ${text.substring(0, 300)}`);
        }
    }

    throw new Error(`Rate Limit persistente (429). Se agotaron ${MAX_RATE_LIMIT_RETRIES} reintentos.`);
}
