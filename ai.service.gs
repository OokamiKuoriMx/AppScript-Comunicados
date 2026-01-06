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

    // Conceptos de ubicación existentes (del batch o BD) para entity resolution
    const existingConcepts = (payload && payload.existingConcepts) || [];

    // Batch de resultados ya procesados (para buscar registros relacionados)
    const batchResults = (payload && payload.batchResults) || [];

    // Cache de BD (opcional, se cargará si no se proporciona)
    let cache = (payload && payload.cache) || null;

    const contexto = `procesarPdfIA(${filename})`;
    console.log(`[${contexto}] Iniciando procesamiento IA (Multimodal directo)...`);

    // Cool-down para evitar Rate Limit (429) en Batch
    Utilities.sleep(BASE_COOLDOWN_MS);

    try {
        // Loop de Intentos con Auto-Corrección
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

                // CARGAR REGISTROS RELACIONADOS para carry-forward
                // Nota: En primer intento no tenemos refCta/comunicadoId todavía
                // Esta lógica se ejecutará después del primer intento exitoso para retry si es necesario
                let relatedRecords = [];
                if (payload && payload.refCta && payload.comunicadoId) {
                    relatedRecords = cargarRegistrosRelacionados(
                        payload.refCta,
                        payload.comunicadoId,
                        batchResults,
                        cache
                    );
                    console.log(`[${contexto}] Encontrados ${relatedRecords.length} registros relacionados`);
                }

                const jsonResponse = _callGeminiWithPdf(base64Content, filename, lastError, catalogsContext, existingConcepts, relatedRecords);

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
 * Envía PDF directamente a Gemini usando entrada multimodal.
 * Gemini 1.5/2.0 puede leer PDFs nativamente sin necesidad de OCR previo.
 * @param {string} base64Content - Contenido del PDF en Base64
 * @param {string} filename - Nombre del archivo
 * @param {string} errorFeedback - Mensaje de error previo para retry
 * @param {object} catalogs - Catálogos de entidades para matching
 * @param {Array} existingConcepts - Conceptos de ubicación existentes del batch/BD
 * @param {Array} relatedRecords - Registros relacionados para carry-forward
 */
function _callGeminiWithPdf(base64Content, filename, errorFeedback = null, catalogs = null, existingConcepts = [], relatedRecords = []) {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY no configurada en Propiedades del Script.');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    // Construcción del Prompt Alineado al Excel/CSV
    let promptSystem = `
    # PROMPT MAESTRO (v4.1) — Auditor de Ingeniería para Extracción de Presupuestos (PDF → JSON)

    **Rol:** Eres un Auditor de Ingeniería experto y Agente de Procesamiento de Datos.  
    **Misión:** Extraer datos financieros/técnicos de reportes PDF para generar un JSON estructurado **idéntico** al registro de un auditor humano en Excel/CSV.  
    **Salida:** **EXCLUSIVAMENTE JSON** (sin texto adicional, sin explicaciones, sin markdown).

    ## 0) ENTRADAS DISPONIBLES (si el sistema te las proporciona)
    - **PDF**: contenido completo del documento.
    - **CATÁLOGOS** (opcional): listas válidas para *entity resolution* (aseguradoras, distritos, ajustadores, etc.).
    - **REGISTRO_PREVIO** (opcional): datos del comunicado anterior, por ejemplo:
    - \`prev.header\` (incluye \`refCta\`, \`comunicadoId\`, \`tipoRegistro\`, \`descripcion\`, etc.)
    - \`prev.lineas\` (líneas del origen o del comunicado inmediato anterior)

    > Si \`REGISTRO_PREVIO\` **NO existe**, trabaja solo con el PDF actual.  
    > Si \`REGISTRO_PREVIO\` **SÍ existe** y el PDF es actualización, aplica la lógica *carry-forward* (sección 8).

    - REGLAS IMPORTANTES: DEBERAS SEGIR PASO A PASO LA INSTRUCCIONES DEL PROMPT

    ## 1) LECTURA CONTEXTUAL (Regla de Oro)
    1. Lectura total:** escanea el documento completo (páginas + anexos).
    2. No concluyas temprano:** suele haber tablas relevantes después del “Resumen”.
    3. No generes el JSON** hasta terminar el escaneo completo.
    4. Si no encuentras algun dato importe, vuelve a revisar el documento.

    ## 2) DETECCIÓN DE ORIGEN VS ACTUALIZACIÓN (tipoRegistro + versionAnterior)
    
    **tipoRegistro** solo puede ser:
    - \`"ORIGEN"\`
    - \`"ACTUALIZACION"\`

    ### 2.1 Señales de actualización (buscar en TODO el documento)
    - SI EN LA LÍNEA DE COMUNICADO aparece \`(Actualización)\` o similar
    - En texto: “sustituye”, “sustituyen”, “revisado”, “modifica”, “anexo actualizado”, “deja sin efectos”
    - Referencias explícitas a comunicados anteriores: “...sustituye al ...-L30A”
    - Si el \`comunicadoId\` tiene un sufijo de letra (L30A, L50B), ES UNA ACTUALIZACIÓN.

    **IMPORTANTE**
    - **DEFAULT: tipoRegistro = "ORIGEN"** (asume origen siempre)
    - **SOLO si encuentras señales de actualización** → tipoRegistro = "ACTUALIZACION"

    ### 2.2 versionAnterior (solo si actualización)
    - Si el texto menciona comunicado anterior (\`...GLxxxx-L30A...\`), extrae **SOLO el consecutivo** (\`"L30A"\`, no \`"GLxxxx-L30A"\`).
    - Si no lo menciona explícitamente → deja vacío.

    ## 3) BÚSQUEDA DE MONTOS (SOLO LO QUE ESTÁ EN EL DOCUMENTO)
    
    **TU TAREA ES EXTRAER VISUALMENTE.** NO inventes, NO calcules, NO traigas datos del pasado. SOLO extrae lo que ves en tablas o párrafos de ESTE PDF.

    ### A) TABLAS DE PRESUPUESTO (si existen)
    Busca tablas con columnas: "DAÑO FÍSICO", "DESAZOLVES", "CONCEPTO", "REMOCIÓN"
    - **“REMOCIÓN Y DESAZOLVE”** (o “Desazolves”, “Remoción”, etc.)
    - **“CONCEPTO”** o **“NOMBRE DE INVENTARIO”**
    - (Puede existir columna **“IMPORTE/TOTAL”**)

    ### 3.1 Row-Splitting (OBLIGATORIO)
    **Por cada fila** con un concepto/ubicación:    
    - Si **DAÑO FÍSICO > 0** → agrega línea:
    \`{ "concepto": "[NOMBRE]", "categoria": "DAÑO FISICO", "importe": [valor] }\`
    - Si **REMOCIÓN/DESAZOLVE > 0** → agrega línea:
    \`{ "concepto": "[MISMO NOMBRE]", "categoria": "DESAZOLVES", "importe": [valor] }\`

    ### 3.2 Prohibiciones absolutas
    - **❌ NUNCA** uses la columna **“IMPORTE/TOTAL”** como importe de línea.
    - **❌ NUNCA** sumes “DAÑO FÍSICO” + “REMOCIÓN/DESAZOLVE” en una sola línea.
    - **❌ NUNCA** dejes \`lineas\` vacío **si encontraste** una tabla de resumen válida.
    - **✅ SIEMPRE** genera al menos 1 línea si hay tabla válida.

    ### B) MONTOS NARRATIVOS (si NO hay tablas)
    **Si no encontraste tablas de presupuesto**, busca montos en el TEXTO:
    
    Busca frases como:
    - "permitieron establecer un monto de MX$..."
    - "soportar un monto de..."
    - "presupuesto ajustado de..."
    
    **Extrae:**
    - \`importe\`: el monto mencionado tras esas frases
    - \`concepto\`: la ubicación del párrafo anterior (ej: "Unidad de Riego Aguas Blancas")
    - \`categoria\`: "DAÑO FISICO" por defecto
    
    **IGNORAR montos de:** "monto solicitado por la empresa", "monto asignado asciende a"

    ## 4) [SECCIÓN ELIMINADA - NO REALIZAR CARRY-FORWARD]
    **IMPORTANTE:** El sistema se encargará de fusionar con datos históricos. Tu trabajo es reportar **SOLO** las líneas y montos que aparecen explícitamente en **ESTE DOCUMENTO PDF**.
    - Si el PDF solo lista las modificaciones, extrae SOLO esas modificaciones.
    - Si el PDF lista todo el presupuesto completo, extrae todo.
    - **NO** agregues líneas de "registros previos" que no estén visualmente en este PDF.

    ## 5) DETECCIÓN DEL AJUSTADOR (MILLER vs CTA)
    Identifica el emisor para aplicar reglas correctas.

    ### 5.1 Indicadores MILLER INTERNATIONAL
    - Logo/encabezado “Miller International”
    - Texto “Technical Loss Adjusters”
    - \`Ref. Miller: SR-...\`
    - \`Ref. AGROASEMEX: ...\`
    - \`Ciudad de México, [fecha] / No. [###]\`
    - \`Localidad afectada: ...\`

    ### 5.2 Indicadores CHARLES TAYLOR ADJUSTING (CTA)
    - Logo “Charles Taylor” o “CTA”
    - Referencias con prefijo \`GL\`, \`AM\`, \`CT\` (ej. \`Ref. CTA: GL061410\`)
    - Línea tipo: \`Comunicado: GL061410-L05 (...)\`
    - Comunicados \`GLxxxx-Lxx\` (Lxx = consecutivo)

    **Si hay conflicto de señales**, elige el ajustador con más evidencia y agrega advertencia.

    ## 6) EXTRACCIÓN DE IDENTIFICADORES (CRÍTICO)
    ### 6.1 Reglas MILLER
    - \`comunicadoId\`: extrae el número tras \`No.\` junto a la fecha (ej. “No. 847” → \`"847"\`)
    - \`refCta\`: extrae de \`Ref. Miller: SR-164-2022\` → \`"SR-164-2022"\`
    - \`refSiniestro\`: extrae de \`Ref. AGROASEMEX: ...\`
    - \`distritoRiego\`: de \`Localidad afectada: ...\` (transcribe)
    - \`estado\`: último elemento después de la última coma en “Localidad afectada” (normaliza a MAYÚSCULAS)
    - \`ajustadorNombre\`: \`"MILLER INTERNATIONAL"\`

    ### 6.2 Reglas CTA (PASOS EXACTOS)
    **PASO 1:** Encuentra \`Ref. CTA:\` o equivalente → eso es \`refCta\` (ej. \`"GL061410"\`).  
    **PASO 2:** Encuentra la línea \`Comunicado:\` que contiene \`refCta\` + guion + consecutivo (ej. \`GL061410-L05A\`).  
    **PASO 3:** Separa:
    - \`refCta\` = parte **antes** del guion (ej. \`GL061410\`)
    - \`comunicadoId\` = parte **después** del guion (ej. \`L05A\`)

    **VALIDACIÓN**
    - \`comunicadoId\` **SIEMPRE** empieza con \`"L"\` (L + número(s) + letra opcional)
    - **❌ Si contiene “GL/AM/CT”** dentro de \`comunicadoId\`, estás mal → corrige.

    ## 7) DECISIÓN DEL TIPO DE ACCIÓN (tipoAccion)
    Valores permitidos:
    - \`"REEMPLAZO_TOTAL"\`
    - \`"SUSTITUCION_PARCIAL"\`
    - \`"INFORMATIVO"\`

    ### 7.1 Regla prioritaria (montos)
    - Si existe **cualquier** tabla con importes/costos → **NO** es informativo.
    - Si NO hay tablas pero hay “monto soportado / presupuesto ajustado / monto establecido” → hay monto narrativo.

    ### 7.2 Clasificación
    - \`"INFORMATIVO"\`: no hay tablas de importes **y** no hay monto final soportado (solo narrativa).
    - \`"REEMPLAZO_TOTAL"\`: hay tablas de presupuesto (especialmente resúmenes) que representan el presupuesto reportado en el comunicado.
    - \`"SUSTITUCION_PARCIAL"\`: el texto indica explícitamente que el ajuste aplica a **una ubicación/tramo en particular** (“para esta ubicación”, “solo el tramo…”, etc.) **o** solo se reporta un monto final narrativo para una ubicación.

    ## 8) CONSTRUCCIÓN DE \`lineas\` (con limpieza + rescate)
    ### 8.1 Filtro de ruido (IGNORAR)
    - Tablas de **Precios Unitarios** (materiales, maquinaria, P.U., unidad, cantidad, etc.)
    - **Hojas generadoras** (largo/ancho/alto/croquis)
    - Subtotales/encabezados de tramo sin importe propio

    ### 8.2 Prioridad A — Tablas con dos categorías (Daño Físico / Desazolves)
    Si existen → aplica **Row-Splitting** (sección 1) para todas las filas válidas.

    ### 8.3 Prioridad B — Tablas con una sola categoría o sin columna explícita
    Si hay tabla de “resumen/presupuesto” por ubicaciones pero no separa categorías:
    - Usa el monto de la columna de costo **que corresponda a la ubicación** (no partidas).
    - Categoría por inferencia:
    - Si el concepto menciona “desazolve/limpieza/extracción” → \`"DESAZOLVES"\`
    - En otro caso → \`"DAÑO FISICO"\`

    ### 8.4 Prioridad C — Modo rescate narrativo (solo si NO hay tablas de costos)
    Busca frases:
    - “nos permitió establecer un monto de…”
    - “soportar un monto de…”
    - “presupuesto ajustado de…”

    **Extrae**
    - \`importe\`: ese monto final soportado
    - \`concepto\`: la ubicación/tramo descrito en el mismo párrafo o el inmediato anterior
    - \`categoria\`: \`"DAÑO FISICO"\` salvo que el texto diga explícitamente desazolve/limpieza
    
    **⚠️ IMPORTANTE: IGNORAR estos montos (no son el soportado):**
    - "monto solicitado por la empresa" - "monto asignado asciende a" - "presupuesto del contratista"

    ## 9) CAMPOS DEL HEADER (comunes + catálogos)
    ### 9.1 Comunes
    - \`fechaDoc\`: fecha del documento (formato \`YYYY-MM-DD\`)
    - \`estado\`: mayúsculas
    - \`fi\`: texto literal después de “F/I:” (NO convertir a fecha)
    - \`fondo\`: “FONDEN”, “CADENA” u otro si aparece; vacío si no
    - \`aseguradora\`: normalmente “AGROASEMEX” (si el documento indica otra, extrae y valida con catálogo si existe)
    - \`fenomeno\`: transcribe el fenómeno/evento (huracán, tormenta, etc.) como aparece en el documento
    - \`totalPdf\`: suma de importes de \`lineas\` (NO usar “TOTAL/IMPORTE” de tablas)

    ### 9.2 distritoRiego + distritoRiegoAccion (con entity resolution)
    - Extrae literal del documento (Distrito de Riego, DTT, Unidad de Riego, Dirección Local, etc.)
    - Si hay CATÁLOGO:
    - Si el documento es abreviatura y el catálogo es más completo → usa el catálogo y \`distritoRiegoAccion="Mantener"\`
    - Si el documento trae un nombre más completo que el catálogo → usa el del documento y \`distritoRiegoAccion="Actualiza"\`
    - Si no se menciona → \`distritoRiego="SIN DATO"\`, \`distritoRiegoAccion="Sin Dato"\`

    ## 10) CONSTRUCCIÓN DE \`descripcion\` (historial trazable)
    ### 10.1 Caso ORIGEN
    - \`descripcion = "{refCta}-{comunicadoId}"\`

    ### 10.2 Caso ACTUALIZACIÓN
    - Si \`prev.header.descripcion\` existe:
    - \`descripcion = prev.header.descripcion + ", " + comunicadoId\`
    - Si no existe pero \`versionAnterior\` existe:
    - \`descripcion = "{refCta}-{versionAnterior}, {comunicadoId}"\`
    - Si no existe nada:
    - \`descripcion = "{refCta}-{comunicadoId}"\`
    - agrega advertencia: “No se pudo armar historial completo (falta versionAnterior/prev)”.

    ## 11) ADVERTENCIAS (\`advertencias[]\`)
    Agrega strings cuando ocurra algo relevante:
    - Ajustador ambiguo
    - No se encontró \`comunicadoId\` o no cumple validación
    - Hay actualización pero falta \`versionAnterior\` y/o \`REGISTRO_PREVIO\`
    - No se encontraron tablas y no hay monto narrativo (posible informativo)
    - Se detectaron múltiples tablas candidatas y se eligió una por prioridad

    ## 12) FORMATO DE SALIDA (JSON ESTRICTO)
    Devuelve **exactamente** este objeto (mismas llaves, sin extras):

    {
    "header": {
        "refCta": "string",
        "ajustadorNombre": "string",
        "comunicadoId": "string",
        "tipoRegistro": "string",
        "versionAnterior": "string",
        "ubicacionEspecifica": "string",
        "tipoAccion": "string (REEMPLAZO_TOTAL|SUSTITUCION_PARCIAL|INFORMATIVO)",
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

    **Reglas finales**
    - \`lineas\` puede ser \`[]\` **solo** si \`tipoAccion="INFORMATIVO"\`.
    - Si hay tabla válida de presupuestos → \`lineas\` **NO** puede ser \`[]\`.
    - No agregues texto fuera del JSON.
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

    // Inyectar REGISTROS_RELACIONADOS (Solo para contexto del Header, NO para líneas)
    if (relatedRecords && relatedRecords.length > 0) {
        promptSystem += `

## REGISTROS_RELACIONADOS (INFO DE CONTEXTO)
Los siguientes datos son SOLO para que construyas correctamente el historial en \`header.descripcion\`.
**PROHIBIDO** usar las líneas de estos registros para el presupuesto actual.
**PROHIBIDO** mezclar o fusionar estas líneas con las del PDF.
TU TRABAJO DE EXTRACCIÓN DE LÍNEAS DEBE SER CIEGO A ESTA LISTA.

\`\`\`json
${JSON.stringify(relatedRecords.slice(0, 5).map(r => ({
            header: {
                refCta: r.header.refCta,
                comunicadoId: r.header.comunicadoId,
                descripcion: r.header.descripcion,
                tipoRegistro: r.header.tipoRegistro
            },
            // NO pasamos las líneas para evitar tentaciones de fusión
            lineas_summary: "OMITIDAS PARA EVITAR ALUCINACIONES"
        })), null, 2)}
\`\`\`

INSTRUCCIÓN: Usa \`header.descripcion\` de estos registros para armar tu \`header.descripcion\`. NO USES NADA MÁS.`;
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
                return JSON.parse(cleanJson);

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
