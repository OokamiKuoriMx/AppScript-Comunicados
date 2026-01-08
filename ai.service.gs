/**
 * ============================================================================
 * SERVICIO DE INTELIGENCIA ARTIFICIAL (Gemini 1.5 Flash)
 * Descripción: Procesa archivos PDF usando OCR y LLM para extracción estructurada.
 * ============================================================================
 */

// Configuración - TIER DE PAGO
const GEMINI_MODEL = 'gemini-2.0-flash-001';  // Modelo estable para producción (con facturación)
const MAX_RETRIES = 5;                     // Reintentos para errores de validación/parseo
const MAX_RATE_LIMIT_RETRIES = 3;          // Reintentos para Rate Limit (menos necesarios con pago)
const BASE_COOLDOWN_MS = 1000;             // 1 segundo entre archivos (tier de pago tiene límites altos)
const BASE_429_WAIT_MS = 5000;             // 5 segundos base si hay 429 (raro con pago)

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
                        aseguradoras: [...new Set(cache.aseguradoras.map(a => a.aseguradora || a.nombre).filter(Boolean))]
                    };
                } catch (errCatalogs) {
                    console.warn(`[${contexto}] No se pudieron cargar catálogos para contexto AI:`, errCatalogs);
                }

                // COMBINAR CONTEXTO: BD + Batch (formato unificado {header, lineas})
                // registrosContextoBD ya está calculado arriba con el nuevo formato
                // También agregar registros del batch actual que tengan la misma refCta
                let registrosContextoUnificado = [...registrosContextoBD];

                if (batchResults && batchResults.length > 0 && payload.refCta) {
                    const refClean = String(payload.refCta).toUpperCase().trim();
                    const batchRelevantes = batchResults
                        .filter(r => {
                            const rRef = String(r.rawPayload?.header?.refCta || r.header?.refCta || '').toUpperCase().trim();
                            return rRef === refClean;
                        })
                        .map(r => ({
                            header: r.rawPayload?.header || r.header || {},
                            lineas: r.rawPayload?.lineas || r.lineas || []
                        }));

                    registrosContextoUnificado.push(...batchRelevantes);
                    console.log(`[${contexto}] Agregados ${batchRelevantes.length} registros del batch al contexto`);
                }

                console.log(`[${contexto}] Total contexto unificado: ${registrosContextoUnificado.length} registros`);

                // =========================================================================
                // FLUJO BIFURCADO: Determinar modo ORIGEN vs ACTUALIZACIÓN
                // =========================================================================
                // REGLA CLAVE:
                // - Si expectedLines.length === 0 → MODO ORIGEN (extracción total)
                // - Si expectedLines.length > 0  → MODO ACTUALIZACIÓN (extracción diferencial)
                // =========================================================================
                const esOrigen = expectedLines.length === 0;
                console.log(`[${contexto}] MODO DE EXTRACCIÓN: ${esOrigen ? 'ORIGEN (Línea Base)' : 'ACTUALIZACIÓN (Diferencial)'} [${expectedLines.length} líneas previas]`);

                const jsonResponse = _callGeminiWithPdf(base64Content, filename, lastError, catalogsContext, existingConcepts, registrosContextoUnificado, expectedLines, esOrigen);

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

    // Parsear versión actual para determinar predecesores esperados
    const versionActual = _parseVersionLocal(comunicadoId);
    const predecesoresEsperados = _calcularPredecesores(versionActual);
    console.log(`${contexto} Buscando candidatos para ${refCta}-${comunicadoId}. Predecesores: ${predecesoresEsperados.join(', ')}`);

    const candidatos = [];

    // 1. Buscar en batch actual (prioridad 1)
    if (batchResults && batchResults.length > 0) {
        const batchCandidatos = batchResults
            .filter(r => {
                const rRef = String(r.rawPayload?.header?.refCta || r.header?.refCta || '').toUpperCase().trim();
                return rRef === refClean;
            })
            .map(r => ({
                source: 'BATCH',
                header: r.rawPayload?.header || r.header || {},
                lineas: r.rawPayload?.lineas || r.lineas || []
            }));

        candidatos.push(...batchCandidatos);
        console.log(`${contexto} Encontrados ${batchCandidatos.length} candidatos en batch`);
    }

    // 2. Buscar en BD (prioridad 2)
    if (cache) {
        const dbCandidatos = _buscarCandidatosEnBD(refClean, cache);
        candidatos.push(...dbCandidatos);
        console.log(`${contexto} Encontrados ${dbCandidatos.length} candidatos en BD`);
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
 * PASADA 1: Extracción rápida de identificadores del PDF.
 * Prompt mínimo para obtener solo refAjustador y comunicadoId.
 * @param {string} base64Content - Contenido del PDF en Base64
 * @param {string} filename - Nombre del archivo
 * @returns {object} { refAjustador, comunicadoId } o null si falla
 */
function _extraerIdentificadoresRapido(base64Content, filename) {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) {
        console.error('[Quick Extract] GEMINI_API_KEY no configurada.');
        return null;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const promptQuick = `
Analiza este documento PDF y extrae SOLO los siguientes dos campos:

1. **refAjustador**: El código de referencia del ajustador (ej: GL098774, AM012345, SR-0226/2022).
   - Busca cerca de "Ref. CTA:", "Referencia:", "Ref. Miller:".
   - Extrae SOLO el código alfanumérico, NO incluyas "CTA" ni "Ref.".
   - Ejemplo: Si dice "Ref. CTA: GL098774-L50", extrae "GL098774".

2. **comunicadoId**: El identificador del comunicado (ej: L50, L50A, 847).
   - Busca cerca de "Comunicado:", o es el sufijo después del guión en la referencia.
   - Si el PDF dice "GL098774-L50A", el comunicadoId es "L50A".
   - MANTÉN las letras sufijo (A, B, C...).

Responde SOLO con JSON válido, sin explicaciones:
{
  "refAjustador": "string",
  "comunicadoId": "string"
}
`;

    const payload = {
        contents: [{
            parts: [
                { text: promptQuick },
                { inline_data: { mime_type: "application/pdf", data: base64Content } }
            ]
        }],
        generationConfig: { response_mime_type: "application/json" }
    };

    try {
        console.log(`[Quick Extract] Ejecutando Pasada 1 para ${filename}...`);
        const response = UrlFetchApp.fetch(url, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
        });

        const code = response.getResponseCode();
        if (code !== 200) {
            console.error(`[Quick Extract] Error HTTP ${code}:`, response.getContentText().substring(0, 300));
            return null;
        }

        const respJson = JSON.parse(response.getContentText());

        if (!respJson.candidates || respJson.candidates.length === 0) {
            console.error('[Quick Extract] No hay candidatos en la respuesta');
            return null;
        }

        const rawContent = respJson.candidates[0]?.content?.parts?.[0]?.text || '';
        const cleanJson = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
        const result = JSON.parse(cleanJson);

        console.log(`[Quick Extract] ✓ refAjustador="${result.refAjustador}", comunicadoId="${result.comunicadoId}"`);
        return result;

    } catch (error) {
        console.error('[Quick Extract] Error:', error.message);
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
            const lineas = lineasBD.map(l => {
                const desc = cache.descripcionLineas?.find(d => String(d.id) === String(l.idLinea)) || {};
                let catFinal = String(l.categoria || 'DAÑO FISICO').toUpperCase();
                if (catFinal === '1') catFinal = 'DAÑO FISICO';
                if (catFinal === '2') catFinal = 'DESAZOLVES';

                return {
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

        // 5. Ordenar por cercanía de versión (predecesor más cercano primero)
        registrosContexto.sort((a, b) => {
            const idA = String(a.header.comunicadoId).toUpperCase();
            const idB = String(b.header.comunicadoId).toUpperCase();
            const indexA = comunicadosRelevantes.indexOf(idA);
            const indexB = comunicadosRelevantes.indexOf(idB);
            return indexA - indexB;
        });

        // 6. Excluir el comunicadoId actual si está presente (solo queremos predecesores)
        const resultado = registrosContexto.filter(r =>
            String(r.header.comunicadoId).toUpperCase() !== String(comunicadoId).toUpperCase()
        );

        // 7. NUEVO: Construir lista plana de conceptos esperados para Schema Injection
        // Esta lista se inyecta al prompt para que la IA busque importes ESPECÍFICOS
        const expectedLines = [];
        for (const reg of resultado) {
            for (const linea of reg.lineas || []) {
                if (linea.concepto && linea.concepto !== 'Sin descripción') {
                    // Evitar duplicados por concepto+categoria
                    const key = `${linea.concepto}|${linea.categoria}`;
                    if (!expectedLines.some(e => `${e.concepto}|${e.categoria}` === key)) {
                        expectedLines.push({
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
 */
function _callGeminiWithPdf(base64Content, filename, errorFeedback = null, catalogs = null, existingConcepts = [], relatedRecords = [], expectedLines = [], esOrigen = true) {
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
        // MODO ORIGEN: Extracción Total (Línea Base)
        console.log('[_callGeminiWithPdf] MODO: ORIGEN - Extracción Total de Partidas');
        promptSystem += `

## 🟢 MODO ORIGEN (LÍNEA BASE - EXTRACCIÓN TOTAL)

**CONTEXTO:** Este es el DOCUMENTO ORIGINAL. Debes extraer TODAS las partidas válidas del presupuesto.

### INSTRUCCIONES DE EXTRACCIÓN TOTAL:
1. **IDENTIFICA** la tabla principal de conceptos/presupuesto en el PDF
2. **EXTRAE** CADA fila que contenga: Ubicación/Concepto y Monto
3. **IGNORA** (no extraigas):
   - Filas de subtotales, sumas acumuladas, "TOTAL", "IVA"
   - Encabezados de página repetidos
   - Tablas de "Resumen Financiero" (solo queremos el desglose detallado)
4. **SEPARA** las columnas de "Daño Físico" y "Desazolves" en líneas independientes

### REGLA IMPORTANTE PARA ORIGEN:
- **EXTRAE TODO** lo que veas en la tabla de presupuesto
- Si encuentras conceptos duplicados (mismo concepto en varios tramos), EXTRÁELOS TODOS como partidas individuales
- NO omitas líneas aunque tengan importe $0.00 (son estructurales)
`;
    } else {
        // MODO ACTUALIZACIÓN: Se inyectará Schema Injection más adelante
        console.log('[_callGeminiWithPdf] MODO: ACTUALIZACIÓN - Extracción Diferencial');
    }

    promptSystem += `

    > **REGLA DE ORO:** Ejecuta secuencialmente los siguientes 8 PASOS. Cada paso consta de **exactamente 7 SUBPASOS** obligatorios. No omitas ninguno.

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
        - Si hay montos (tabla o narrativo) → "SUSTITUCION_PARCIAL" (Default seguro).

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

    * **5.6 Separación de Líneas (Split Multiplicativo):**
        - Si una fila tiene columnas para Daño Físico y Desazolves, **DEBES DUPLICAR** la extracción.
        - **MANDATO MATEMÁTICO**: Si hay 10 ubicaciones en la tabla y ambas columnas existen, tu output debe tener **20 líneas** (10 de daño + 10 de desazolve).
        - Nunca sumes los importes. Genera dos objetos independientes con la misma ubicación.
        - Si el importe es 0 en una columna, agrega la línea con importe 0.
    
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
    // SCHEMA INJECTION: Extracción Dirigida de Importes (SOLO MODO ACTUALIZACIÓN)
    // Solo se inyecta cuando NO es origen Y hay líneas esperadas
    // =========================================================================
    if (!esOrigen && expectedLines && expectedLines.length > 0) {
        console.log(`[_callGeminiWithPdf] MODO ACTUALIZACIÓN: Inyectando ${expectedLines.length} líneas para Schema Injection`);
        promptSystem += `

## ⚡ EXTRACCIÓN DIRIGIDA (SCHEMA INJECTION - PRIORIDAD MÁXIMA)

**CONTEXTO CRÍTICO:** Para esta referencia, YA EXISTEN los siguientes conceptos en la BD.
Tu tarea es **BUSCAR EL IMPORTE ESPECÍFICO** de cada uno de estos conceptos en el PDF.

### LISTA DE CONCEPTOS CONOCIDOS (BUSCAR EN PDF):
${expectedLines.map((l, i) => `${i + 1}. "${l.concepto}" (${l.categoria}) [Importe previo: $${l.importe_previo?.toFixed(2) || '0.00'}]`).join('\n')}

### INSTRUCCIONES DE EXTRACCIÓN DIRIGIDA:
1. **ESCANEA** el PDF buscando EXACTAMENTE estos conceptos (o variaciones menores de nombre)
2. Para cada concepto encontrado en el PDF, extrae el **IMPORTE TOTAL/FINAL** (NO el Precio Unitario)
3. Si un concepto de la lista NO aparece en este PDF específico, **NO LO INCLUYAS** en el output
   - ⚠️ NO inventes importes. Si no lo ves en el PDF, no lo reportes.
4. Si encuentras un concepto NUEVO (no en la lista), agrégalo normalmente

### COLUMNAS A EVITAR (NO SON EL IMPORTE FINAL):
❌ "Precio Unitario", "P.U."
❌ "Estimación Anterior", "Importe Anterior"
❌ "Acumulado", "Previous Amount"
❌ "Reclamado" (puede ser diferente al autorizado)

### COLUMNAS CORRECTAS (BUSCAR):
✅ "Importe", "Total", "Importe Revisado"
✅ "Importe Daño Físico", "Importe Desazolves"
✅ "Monto Autorizado", "Estimación CTA"

### REGLA DE COINCIDENCIA:
- Si el PDF dice "UR Aguas Blancas" y la lista tiene "Unidad de Riego Aguas Blancas", SON LO MISMO
- Usa el nombre de la lista (el normalizado) en tu output, no el literal del PDF
`;
    }

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

                // Limpieza de Markdown si la IA lo incluye
                let cleanJson = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
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
