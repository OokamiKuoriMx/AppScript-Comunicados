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
 * @param {object|string} payload - Objeto {content, filename} o content string (legacy).
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
                    const cache = _loadCatalogsCache();

                    // Extract distinctive lists to guide AI
                    // Fenomenos might need to be extracted from Siniestros or a separate table if it exists. 
                    // Assuming 'siniestros' table has 'fenomeno' column or similar description.
                    // Checking TABLE_DEFINITIONS or guessing based on user request.
                    // User said "siniestros ajustadores fenomenos existentes".

                    catalogsContext = {
                        ajustadores: [...new Set(cache.ajustadores.map(a => a.nombre || a.nombreAjustador).filter(Boolean))],
                        siniestros: [...new Set(cache.siniestros.map(s => s.siniestro).filter(Boolean))],
                        // Fenomenos often live in Siniestros description or separte catalog. 
                        // I'll grab unique 'fenomeno' from siniestros table if available, or just map descriptions.
                        fenomenos: [...new Set(cache.siniestros.map(s => s.fenomeno).filter(Boolean))],
                        distritos: [...new Set(cache.distritosRiego.map(d => d.distritoRiego).filter(Boolean))],
                        aseguradoras: [...new Set(cache.aseguradoras.map(a => a.aseguradora || a.nombre).filter(Boolean))]
                    };
                } catch (errCatalogs) {
                    console.warn(`[${contexto}] No se pudieron cargar catálogos para contexto AI:`, errCatalogs);
                }

                const jsonResponse = _callGeminiWithPdf(base64Content, filename, lastError, catalogsContext);

                // Validar Lógica de Negocio básica (Suma)
                const validacion = _validarLogicaNegocio(jsonResponse);

                if (validacion.esValido) {
                    resultadoFinal = jsonResponse;
                    break; // Éxito
                } else {
                    // Fallo lógico (la suma no cuadra, etc), reintentar con feedback
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
        return {
            success: true,
            data: {
                header: resultadoFinal.header,
                lineas: resultadoFinal.lineas
            },
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
 * Valida reglas matemáticas y de negocio críticas antes de aceptar la respuesta IA.
 * CAMBIO: Si hay diferencia entre total y suma de líneas, las LÍNEAS rigen (autocorrige totalPdf).
 */
function _validarLogicaNegocio(json) {
    if (!json.header || !json.lineas) return { esValido: false, mensaje: "Estructura JSON incompleta (falta header o lineas)" };

    // Regla Importe Cero = Cancelado (No es error)
    const totalDoc = parseFloat(json.header.totalPdf || 0);
    if (totalDoc === 0 && (!json.lineas || json.lineas.length === 0)) {
        // Es un documento cancelado válido
        return { esValido: true };
    }

    // Calcular Suma de Líneas
    const sumaLineas = json.lineas.reduce((sum, l) => sum + (parseFloat(l.importe) || 0), 0);
    const diff = Math.abs(totalDoc - sumaLineas);

    // NUEVO: Si hay diferencia, las líneas rigen. Autocorregir totalPdf.
    if (diff > 1.0 && sumaLineas > 0) {
        console.warn(`[Validación IA] Autocorrigiendo totalPdf: ${totalDoc} -> ${sumaLineas} (Diferencia: ${diff})`);
        json.header.totalPdf = sumaLineas;
        json.header.advertencias = json.header.advertencias || [];
        json.header.advertencias.push(`Total corregido: ${totalDoc.toFixed(2)} -> ${sumaLineas.toFixed(2)}`);
    }

    return { esValido: true };
}

/**
 * NUEVA: Envía PDF directamente a Gemini usando entrada multimodal.
 * Gemini 1.5/2.0 puede leer PDFs nativamente sin necesidad de OCR previo.
 */
function _callGeminiWithPdf(base64Content, filename, errorFeedback = null, catalogs = null) {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY no configurada en Propiedades del Script.');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    // Construcción del Prompt Alineado al Excel/CSV
    let promptSystem = `
        Eres un Auditor de Ingeniería experto.
        Tu misión es extraer datos de reportes técnicos (PDFs) para generar un registro idéntico al que realizaría un auditor humano en un Excel.

        ## PASO 0: ANÁLISIS CONTEXTUAL (LEE TODO EL DOCUMENTO PRIMERO)
        
        Antes de extraer datos, LEE y COMPRENDE el contexto completo del documento:
        
        1. **¿Es un comunicado ORIGEN o una ACTUALIZACIÓN?**
           - Busca palabras clave: "Actualización", "sustituye", "revisado", "anexo actualizado"
           - Si menciona comunicados anteriores (ej: "sustituye al L30A"), es ACTUALIZACIÓN
        
        2. **¿Sustituye TODO el presupuesto o solo PARTE?**
           - "para esta ubicación en particular" → SUSTITUCION_PARCIAL
           - "revisión integral" o múltiples ubicaciones → REEMPLAZO_TOTAL
        
        3. **¿Cuál es la ubicación/tramo afectado?**
           - Busca en el texto: "área hidráulica del río X", "tramo Y", títulos como "P04 - Río X, GPS Y"
           - Esta ubicación es el CONCEPTO de la línea, no los detalles (Preliminares, Acarreo)
        
        4. **¿Cuál es el monto total del presupuesto revisado?**
           - Busca la columna "PRESUPUESTO REVISADO" o el TOTAL final
           - IGNORA los desgloses (Precios Unitarios con UNIDAD, CANTIDAD, P.U.)

        ## REGLAS CRÍTICAS DE TRANSFORMACIÓN:

        1. **IDENTIFICACIÓN DE LINAJE (ComunicadoId y TipoRegistro)**:
        
        - **comunicadoId**: El identificador del comunicado (formato: L + número + letra opcional).
            - Extrae del texto "Comunicado: REFERENCIA-ID" la parte después del guión.
            - Si el PDF dice "Comunicado: GL061410-L05A" → comunicadoId = **"L05A"** (NO "GL061410").
            - Si el PDF dice "Comunicado: GL070059-L30" → comunicadoId = **"L30"**.
            - Si el PDF dice "Comunicado L04B" → comunicadoId = **"L04B"**.
            - **REGLA**: El comunicadoId SIEMPRE empieza con "L" + número. NUNCA es "GL..." (eso es refCta).

        - **tipoRegistro (VERSIÓN)**: **REGLA CRÍTICA** - Determina si es ORIGEN o ACTUALIZACION:
            - **PASO 1**: Busca palabras clave de actualización: **"Actualización"**, **"Adicional"**, **"sustituye al"**, **"modifica el"**.
            - **PASO 2**: 
                - Si APARECEN palabras clave de actualización → tipoRegistro = comunicadoId completo (ej: "L05A", "L30B").
                - Si NO aparecen palabras clave → tipoRegistro = **"ORIGEN"**.
            - **NOTA IMPORTANTE**: El sufijo (A, B, C...) es OPCIONAL y NO determina por sí solo si es actualización. Un comunicado "L05A" puede ser ORIGEN si no hay palabras clave de actualización en el documento.
            - **EJEMPLOS**:
                - "Comunicado GL061410-L05" sin mención de "Actualización" → tipoRegistro: **"ORIGEN"**
                - "Comunicado GL061410-L05A" sin mención de "Actualización" → tipoRegistro: **"ORIGEN"** (el sufijo NO implica actualización)
                - "Comunicado GL061410-L05A (Actualización)" → tipoRegistro: **"L05A"** (porque dice "Actualización")
                - "Comunicado GL070059-L30B" con texto "sustituye al L30A" → tipoRegistro: **"L30B"** (porque dice "sustituye")

        - **versionAnterior (VERSIÓN SUSTITUIDA)**: Si el documento menciona explícitamente a cuál sustituye.
            - Busca frases como: "sustituye al presentado en nuestro comunicado GL070059-**L30A**"
            - Extrae la versión mencionada (Ej: "L30A").
            - Si no menciona, deja vacío.

        - **ubicacionEspecifica**: Si el documento menciona que solo afecta una ubicación/tramo específico.
            - Busca frases como: "área hidráulica del río **Marabasco** en el tramo **El Rincón**"
            - Esta ubicación DEBE incluirse en el concepto de TODAS las líneas.
            - Formato: "Río {Nombre}, Tramo {Tramo} - {Concepto Original}"

        - **tipoAccion (TIPO DE SUSTITUCIÓN)**:
            - Analiza el contexto del documento para determinar el alcance:
            - **"REEMPLAZO_TOTAL"**: El documento reemplaza COMPLETAMENTE al anterior.
                - Indicadores: "revisión integral", "sustituye en su totalidad", múltiples ubicaciones/tramos.
                - Extrae TODAS las líneas del presupuesto nuevo.
            - **"SUSTITUCION_PARCIAL"**: SOLO reemplaza UNA ubicación/tramo específico.
                - Indicadores: "para esta ubicación en particular", "solo el tramo X".
                
                **REGLA CRÍTICA PARA SUSTITUCION_PARCIAL**:
                
                1. **BUSCA LA UBICACIÓN EN EL TEXTO CONTEXTUAL** (NO en la tabla):
                   - Lee el párrafo que describe el monto, ejemplo:
                     "hemos establecido un monto de MX$2,479,657.51... para resarcir los daños en el **bordo del río Arenas**"
                   - Extrae: ubicación = "BORDO DEL RÍO ARENAS"
                   - Extrae: importe = 2479657.51
                
                2. **IGNORA COMPLETAMENTE LA TABLA DE DESGLOSES**:
                   - Las tablas con Preliminares, Demoliciones, Terracerías, Estructuras son PARTIDAS de precios unitarios
                   - ❌ NUNCA extraigas estas como líneas
                   - ✅ El importe ya está en el texto contextual
                
                3. **EXTRAE UNA SOLA LÍNEA**:
                   - concepto = La ESTRUCTURA de riego (ej: "BORDO DEL RÍO ARENAS", "RÍO PALIZADA MARGEN IZQUIERDA")
                   - importe = El monto total del texto (ej: $2,479,657.51)
                   - categoria = "DAÑO FISICO"

        - **descripcion (HISTORIAL)**: Construye la cadena de trazabilidad.
            - Formato: "{REF_CTA}-{RAIZ}, {VERSION_ANTERIOR}, {VERSION_ACTUAL}"
            - Ejemplo para L30A: "GL070059-L30, L30A".
            - Ejemplo para L30B: "GL070059-L30, L30A, L30B".
            - Si es Nuevo Origen (Ej L04): "GL097117-L04".

        2. **CATEGORIZACIÓN INTELIGENTE (Inferencia)**:
        - El PDF NO tiene columna "Categoría", debes DEDUCIRLA del texto del 'concepto'.
        - Reglas:
            - "Desazolve", "Limpieza", "Extracción" -> **"DESAZOLVES"**
            - "Mampostería", "Concreto", "Enrocamiento", "Bordo", "Camino", "Estructura" -> **"DAÑO FISICO"**
            - "Supervisión" -> **"SUPERVISION"**
        - **NUNCA** dejes este campo vacío.

        3. **FILTRADO DE TABLAS (Limpieza)**:
        - **IGNORA** tablas de "Precios Unitarios" (que tengan columnas de materiales, maquinaria, P.U.).
        - **EXTRAE SOLO** las tablas de "Resumen" o "Presupuesto" que describan tramos o ubicaciones (Ríos, Márgenes).
        - Ignora filas de subtotales o encabezados de tramo que no tengan importe propio.
        
        4. **⚠️ REGLA CRÍTICA - TABLAS CON DOS COLUMNAS DE IMPORTE**:
        
        CUANDO VEAS UNA TABLA CON ESTAS DOS COLUMNAS:
        | Concepto | **Importe daño físico MX$** | **Importe Remoción, desazolves MX$** | Importe MX$ |
        
        DEBES GENERAR **DOS LÍNEAS SEPARADAS** usando los TOTALES de cada columna:
        
        **LÍNEA 1: DAÑO FÍSICO**
        - concepto: [UBICACIÓN del texto, ej: "BORDO DEL RÍO ARENAS"]
        - categoria: "DAÑO FISICO"
        - importe: [TOTAL de columna "Importe daño físico"] → 2379831.72
        
        **LÍNEA 2: DESAZOLVES** 
        - concepto: [MISMA UBICACIÓN]
        - categoria: "DESAZOLVES"
        - importe: [TOTAL de columna "Importe Remoción, desazolves"] → 99825.79
        
        **EJEMPLO COMPLETO** para la tabla que muestras:
        "lineas": [
            { "concepto": "BORDO DEL RÍO ARENAS", "categoria": "DAÑO FISICO", "importe": 2379831.72 },
            { "concepto": "BORDO DEL RÍO ARENAS", "categoria": "DESAZOLVES", "importe": 99825.79 }
        ]
        
        **NO HAGAS ESTO (INCORRECTO)**:
        - ❌ Una sola línea con importe total 2,479,657.51
        - ❌ Líneas separadas por concepto (Preliminares, Demoliciones, etc.)
        - ❌ Incluir "- DAÑO FÍSICO" en el concepto

        ## FORMATO JSON ESPERADO (Alineado a CSV):
        {
        "header": {
            "refCta": "string (Ej: GL070059)",
            "ajustadorNombre": "string (CHARLES TAYLOR ADJUSTING)",
            "comunicadoId": "string (RAIZ: L30)", 
            "tipoRegistro": "string (CRÍTICO: 'ORIGEN' si NO hay palabras Actualización/Adicional, o 'L30A'/'L30B' si SÍ las hay)",
            "versionAnterior": "string (Versión que sustituye, Ej: L30A. Vacío si es ORIGEN)",
            "ubicacionEspecifica": "string (Río Marabasco, Tramo El Rincón. Vacío si aplica a todo)",
            "tipoAccion": "string (REEMPLAZO_TOTAL o SUSTITUCION_PARCIAL)",
            "descripcion": "string (HISTORIAL: GL...-L30, L30A)",
            "fechaDoc": "YYYY-MM-DD",
            "estado": "string (Ej: COLIMA)",
            "refSiniestro": "string",
            "aseguradora": "string (Ej: AGROASEMEX)",
            "fenomeno": "string (Ej: DAÑOS EN INFRAESTRUCTURA HIDROAGRÍCOLA A CONSECUENCIA DE LOS EFECTOS DEL HURACÁN KAY)",
            "fi": "string (Fecha de Incidencia. Busca 'F/I:' en el texto y TRANSCRIBE LITERALMENTE tal como aparece. Ej: '03 de diciembre de 2020'. NO convertir a formato fecha)",
            "fondo": "string (Ej: FONDEN, CADENA, o vacío si no se menciona)",
            "distritoRiego": "string (Busca: 'Dirección Local [Estado]', 'Distrito de Riego', 'DTT', 'Distrito de Temporal'. Transcribe LITERAL. Ej: 'Dirección Local Campeche', 'DTT 011 MARGARITAS COMITAN')", 
            "totalPdf": number,
            "advertencias": ["string"]
        },
        "lineas": [
            {
            "concepto": "string (Descripción de la obra/tramo Ej: RÍO ARMERÍA MARGEN IZQUIERDA, TRAMO MADRID (LOS SALAZAR))",
            "categoria": "string (DAÑO FISICO o DESAZOLVES)",
            "importe": number
            }
        ]
        }
        `;

    if (catalogs) {
        promptSystem += `\n\n## CATÁLOGOS VÁLIDOS (Entity Resolution):
REGLA CRÍTICA: Para cada campo catalogado, BUSCA coincidencias en la lista. 
Si encuentras algo SIMILAR (aunque varíe en redacción, abreviaturas o acentos), USA EL VALOR EXISTENTE.
Ejemplos de matching:
- "Dir. Local Campeche" ≈ "DIRECCIÓN LOCAL CAMPECHE" → Usa: "DIRECCIÓN LOCAL CAMPECHE"
- "DTT 011" ≈ "DISTRITO DE TEMPORAL 011" → Usa el existente
- "Agroasemex" ≈ "AGROASEMEX" → Usa: "AGROASEMEX"

`;
        if (catalogs.distritos && catalogs.distritos.length > 0)
            promptSystem += `- DISTRITOS DE RIEGO EXISTENTES (usa estos si el texto del PDF coincide parcialmente): ${JSON.stringify(catalogs.distritos.slice(0, 100))}\n`;
        if (catalogs.ajustadores && catalogs.ajustadores.length > 0)
            promptSystem += `- AJUSTADORES EXISTENTES: ${JSON.stringify(catalogs.ajustadores.slice(0, 50))}\n`;
        if (catalogs.siniestros && catalogs.siniestros.length > 0)
            promptSystem += `- SINIESTROS EXISTENTES: ${JSON.stringify(catalogs.siniestros.slice(0, 50))}\n`;
        if (catalogs.fenomenos && catalogs.fenomenos.length > 0)
            promptSystem += `- FENÓMENOS EXISTENTES: ${JSON.stringify(catalogs.fenomenos.slice(0, 100))}\n`;
        if (catalogs.aseguradoras && catalogs.aseguradoras.length > 0)
            promptSystem += `- ASEGURADORAS EXISTENTES: ${JSON.stringify(catalogs.aseguradoras.slice(0, 50))}\n`;

        promptSystem += `\n**PRIORIDAD**: Si un valor del PDF coincide (incluso parcialmente) con un catálogo existente, DEVUELVE EL VALOR DEL CATÁLOGO, no el texto literal del PDF.`;
    }

    if (errorFeedback) {
        promptSystem += `\n\n⚠️ ATENCIÓN: TU INTENTO ANTERIOR FALLÓ CON ESTE ERROR: "${errorFeedback}". \nREVISA TUS CÁLCULOS Y EL FORMATO JSON.`;
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

                // Limpieza de Markdown ```json ... ``` si la IA lo incluye
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

