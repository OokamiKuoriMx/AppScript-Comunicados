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

        ## 🚨 REGLA PRIORITARIA - EXTRACCIÓN DE LÍNEAS DE PRESUPUESTO 🚨
        
        **ANTES de analizar el header**, BUSCA en el documento una tabla de "Resumen de presupuestos" que contenga columnas como:
        - "DAÑO FÍSICO" (o similar: "Importe daño físico", "Daño Material")
        - "REMOCIÓN Y DESAZOLVE" (o similar: "Desazolves", "Remoción")
        - "CONCEPTO" o "NOMBRE DE INVENTARIO"
        
        **PARA CADA FILA de esa tabla**, genera UNA o DOS líneas en el array "lineas":
        
        - SI columna "DAÑO FÍSICO" > 0 → { "concepto": "[NOMBRE]", "categoria": "DAÑO FISICO", "importe": [valor] }
        - SI columna "REMOCIÓN/DESAZOLVE" > 0 → { "concepto": "[MISMO NOMBRE]", "categoria": "DESAZOLVES", "importe": [valor] }
        
        **❌ NUNCA** uses la columna "IMPORTE" o "TOTAL" como importe de línea.
        **❌ NUNCA** generes el array "lineas" vacío si hay una tabla de resumen.
        **✅ SIEMPRE** genera al menos 1 línea si hay tabla de presupuestos.

        ## PASO 0: DETECCIÓN DEL TIPO DE AJUSTADOR
        
        **PRIMERO**, identifica qué ajustador emitió el documento para aplicar las reglas correctas:
        
        ### INDICADORES DE CHARLES TAYLOR ADJUSTING:
        - Logo "Charles Taylor" o "CTA" en el encabezado
        - Referencias con prefijo "GL", "AM", "CT" (ej: "Ref. CTA: GL061410")
        - Comunicados en formato "GL...-L05" donde L05 es el consecutivo
        - Línea "Comunicado: GL061410-L05 (Estado, Municipio)"
        
        ### INDICADORES DE MILLER INTERNATIONAL:
        - Logo "miller International" en el encabezado
        - Texto "Technical Loss Adjusters"
        - Referencias en formato "Ref. Miller: SR-164-2022"
        - Referencias de siniestro "Ref. AGROASEMEX: SCNA-0017/2022"
        - Número de comunicado junto a la fecha: "No. 847"
        - Campo "Localidad afectada:" con distrito de riego explícito
        
        ---
        
        ## REGLAS PARA MILLER INTERNATIONAL
        
        Si detectas que es un documento de Miller International, aplica estas reglas:
        
        1. **comunicadoId**: 
           - Busca "No. XXX" en el encabezado, junto a la fecha
           - Ejemplo: "Ciudad de México, 19 de octubre de 2022 / No. 847"
           - comunicadoId = "847" (solo el número)
           - ⚠️ IGNORA el campo "Asunto:", NO contiene el comunicado
        
        2. **refCta (Referencia del Ajustador)**:
           - Busca "Ref. Miller: XXX"
           - Ejemplo: "Ref. Miller: SR-164-2022"
           - refCta = "SR-164-2022"
        
        3. **refSiniestro**:
           - Busca "Ref. AGROASEMEX: XXX" o similar
           - Ejemplo: "Ref. AGROASEMEX: SCNA-0017/2022"
           - refSiniestro = "SCNA-0017/2022"
        
        4. **distritoRiego**:
           - Busca "Localidad afectada: XXX"
           - Ejemplo: "Localidad afectada: Distrito de Riego 009, Valle de Juarez, Chihuahua"
           - distritoRiego = "Distrito de Riego 009, Valle de Juarez, Chihuahua"
        
        5. **estado**:
           - Extrae del final de "Localidad afectada" (después de la última coma)
           - Ejemplo: "...Valle de Juarez, Chihuahua" → estado = "CHIHUAHUA"
        
        6. **ajustadorNombre**: 
           - = "MILLER INTERNATIONAL"
        
        7. **aseguradora**:
           - Extrae del campo "Ref. AGROASEMEX" el nombre de la aseguradora
           - = "AGROASEMEX"
        
        8. **descripcion (HISTORIAL)**:
           - Para origen: "{refCta}-{comunicadoId}"
           - Ejemplo: "SR-164-2022-847"
        
        9. **⚠️ REGLA CRÍTICA - EXTRACCIÓN DE LÍNEAS EN MILLER**:
        
           Las tablas de Miller tienen estas columnas:
           | N° | NOMBRE DE INVENTARIO | **DAÑO FÍSICO** | **REMOCIÓN Y DESAZOLVE** | IMPORTE |
           
           **DEBES GENERAR DOS LÍNEAS SEPARADAS** por cada fila (si el importe > 0):
           
           **LÍNEA 1: DAÑO FÍSICO**
           - concepto: [NOMBRE DE INVENTARIO, ej: "CANAL RODEO"]
           - categoria: "DAÑO FISICO"
           - importe: [Valor de columna "DAÑO FÍSICO"] → 995719.34
           
           **LÍNEA 2: DESAZOLVES** (SOLO si el valor > 0)
           - concepto: [MISMO NOMBRE DE INVENTARIO]
           - categoria: "DESAZOLVES"
           - importe: [Valor de columna "REMOCIÓN Y DESAZOLVE"] → 12149.26
           
           **EJEMPLO COMPLETO** para la tabla:
           | P-01 | Canal Rodeo | $995,719.34 | $12,149.26 | $1,007,868.60 |
           | P-02 | Presa Derivadora Parían | $96,795.73 | $17,227.73 | $114,023.46 |
           | P-03 | Camino de operación lateral Tejabán | $27,029.59 | $0.00 | $27,029.59 |
           
           "lineas": [
               { "concepto": "CANAL RODEO", "categoria": "DAÑO FISICO", "importe": 995719.34 },
               { "concepto": "CANAL RODEO", "categoria": "DESAZOLVES", "importe": 12149.26 },
               { "concepto": "PRESA DERIVADORA PARÍAN", "categoria": "DAÑO FISICO", "importe": 96795.73 },
               { "concepto": "PRESA DERIVADORA PARÍAN", "categoria": "DESAZOLVES", "importe": 17227.73 },
               { "concepto": "CAMINO DE OPERACIÓN LATERAL TEJABÁN", "categoria": "DAÑO FISICO", "importe": 27029.59 }
           ]
           
           **❌ NUNCA HAGAS ESTO (INCORRECTO)**:
           - ❌ Una sola línea con el importe TOTAL ($1,007,868.60)
           - ❌ Ignorar la columna de REMOCIÓN Y DESAZOLVE
           - ❌ Sumar ambas columnas en una sola línea
        
        ---
        
        ## REGLAS PARA CHARLES TAYLOR (REGLAS ORIGINALES)
        
        Si detectas que es un documento de Charles Taylor, aplica estas reglas:

        ### ANÁLISIS CONTEXTUAL (LEE TODO EL DOCUMENTO PRIMERO)
        
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

        1. **IDENTIFICACIÓN DEL CONSECUTIVO (comunicadoId)**:
        
        ⚠️ **PROCESO DE EXTRACCIÓN - SIGUE ESTOS PASOS EXACTOS**:
        
        **PASO 1**: Encuentra "Ref. CTA:" o similar en el documento.
           - Ejemplo: "Ref. CTA: GL061410" → Esta es la REFERENCIA DEL AJUSTADOR (refCta)
           - También puede ser: "AM...", "CT...", u otros prefijos
        
        **PASO 2**: Encuentra la línea "Comunicado:" que contiene la referencia + guión + consecutivo.
           - Ejemplo: "Comunicado: GL061410-L05 (Chiapas, Villa Comaltitlán)"
        
        **PASO 3**: ELIMINA la referencia y el guión, CONSERVA SOLO el consecutivo.
           - Del ejemplo "GL061410-L05":
             - ❌ ELIMINAR: "GL061410-" (la referencia con guión)
             - ✅ CONSERVAR: "L05" (el CONSECUTIVO)
        
        **RESULTADO**:
        - refCta = "GL061410" (la referencia del ajustador, sin el guión)
        - comunicadoId = "L05" (SOLO el consecutivo, empieza con "L")
        
        **MÁS EJEMPLOS**:
        | Comunicado en PDF | refCta | comunicadoId (CONSECUTIVO) |
        |-------------------|--------|---------------------------|
        | GL061410-L05      | GL061410 | L05 |
        | GL061410-L05A     | GL061410 | L05A |
        | AM090123-L30B     | AM090123 | L30B |
        | CT070059-L02      | CT070059 | L02 |
        
        **VALIDACIÓN FINAL**:
        - ❌ Si comunicadoId contiene "GL", "AM", "CT" u otro prefijo de referencia, ESTÁS EQUIVOCADO
        - ✅ comunicadoId SIEMPRE empieza con "L" seguido de número(s) y letra opcional

        2. **tipoRegistro (VERSIÓN)**: **DETECTAR SI ES ACTUALIZACIÓN**:
        
        ⚠️ **BUSCA EN TODO EL DOCUMENTO, NO SOLO EN EL ENCABEZADO**:
        
        **SEÑAL 1**: En la línea de "Comunicado:" aparece **(Actualización)** entre paréntesis.
           - Ejemplo: "Comunicado: GL061410-L05A **(Actualización)** (Chiapas, Villa Comaltitlán)"
           - → tipoRegistro = "L05A" (el consecutivo)
        
        **SEÑAL 2**: En el CUERPO del documento hay texto como "sustituyen" o "sustituye":
           - ⚠️ **IMPORTANTE**: La línea de Comunicado puede NO decir "(Actualización)" pero el texto del documento SÍ lo indica.
           
           - **EJEMPLO REAL**:
             - Encabezado: "Comunicado: GL069426-L19A (Chiapas, Tapachula)" ← NO dice Actualización
             - Pero en el cuerpo dice: "Es importante mencionar que los montos antes citados **sustituyen** a los presentados en nuestro comunicado GL069426-L19"
             - → tipoRegistro = "L19A" (porque dice "sustituyen" en el texto)
             - → versionAnterior = "L19" (extraído de "sustituyen a... GL069426-L19")
           
           - Otro ejemplo: "...presupuestos revisados, mismos que **sustituyen** a los presentados en nuestro comunicado GL061410-L05"
           - → tipoRegistro = "L05A"
           - → versionAnterior = "L05"
        
        **SI NO HAY NINGUNA SEÑAL** (ni en encabezado NI en el cuerpo):
           - No dice "(Actualización)" en ningún lado
           - No hay frases con "sustituye" o "sustituyen" en TODO el documento
           - → tipoRegistro = **"ORIGEN"**
        
        **RESUMEN**:
        | Qué buscar | Dónde buscar | tipoRegistro |
        |------------|--------------|--------------|
        | "(Actualización)" | Línea Comunicado | = comunicadoId |
        | "sustituyen a" / "sustituye al" | Cuerpo del documento | = comunicadoId |
        | Ninguna señal | - | = "ORIGEN" |

        3. **versionAnterior** (Solo si es ACTUALIZACIÓN):
           - Busca el comunicado anterior que es "sustituido" o "reemplazado".
           - Ejemplo: "sustituyen a los presentados en nuestro comunicado **GL061410-L05**"
             - Extraer SOLO el consecutivo: **"L05"** (NO "GL061410-L05")
           - Si no menciona explícitamente, deja vacío.

        - **ubicacionEspecifica**: Si el documento menciona que solo afecta una ubicación/tramo específico.
            - Busca frases como: "área hidráulica del río **Marabasco** en el tramo **El Rincón**"
            - Esta ubicación DEBE incluirse en el concepto de TODAS las líneas.
            - Formato: "Río {Nombre}, Tramo {Tramo} - {Concepto Original}"

        - **tipoAccion (TIPO DE DOCUMENTO)**:
            - Analiza el contexto del documento para determinar el tipo:
            
            ⚠️ **REGLA PRIORITARIA**: Si hay CUALQUIER tabla con columnas de montos/importes → **NO es INFORMATIVO**
            
            - **"INFORMATIVO"**: Comunicado SIN NINGUNA tabla de presupuesto/montos.
                - **SOLO usar cuando**:
                  - ❌ NO hay NINGUNA tabla con columnas de "Importe", "daño físico MX$", "desazolves MX$", "Importe MX$"
                  - ❌ NO hay NINGÚN monto total en el documento (ej: "$10,107,333.30", "MX$12,034,248.34")
                  - ✅ SOLO hay texto narrativo SIN números de presupuesto
                  - ✅ Hay tabla con columnas "Ubicación" y "Comentario" (sin montos)
                  - ✅ El documento menciona "actas de entrega", "estado de avance" SIN dar montos nuevos
                - **RESULTADO**: 
                  - tipoAccion = "INFORMATIVO"
                  - lineas = [] (array vacío)
                  - totalPdf = 0
                  
            - **SI HAY TABLA DE PRESUPUESTO O MONTOS → usar REEMPLAZO_TOTAL o SUSTITUCION_PARCIAL**
            
            - **"REEMPLAZO_TOTAL"**: El documento reemplaza COMPLETAMENTE al anterior.
                - Indicadores: "revisión integral", "sustituye en su totalidad", múltiples ubicaciones/tramos.
                - Se mantienen las ubicaciones/tramos especificos del origen, pero se cambian los montos de las ubicaciones o en su caso se adicionan ubicaciones nuevas.
                - Extrae TODAS las líneas del presupuesto nuevo.
                
            - **"SUSTITUCION_PARCIAL"**: SOLO reemplaza UNA ubicación/tramo específico.
                - Indicadores: "para esta ubicación en particular", "solo el tramo X".
                - Se mantiene la ubicación/tramo especifico del origen, pero se cambia el monto de la ubicación o en su caso se adiciona una nueva ubicación.

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
            - Si es Nuevo Origen (Ej L04): "GL097117-L04"   
            - Si es Nuevo Origen con sufijo (Ej L04C): "GL097117-L04C"
            - Si es Actualización (Ej L04C): "GL097117-L04, L04C".
            - Formato: "{REF_CTA}-{RAIZ}, {VERSION_ANTERIOR}, {VERSION_ACTUAL}"
            - Ejemplo para L30A: "GL070059-L30, L30A".
            - Ejemplo para L30B: "GL070059-L30, L30A, L30B".
            - Ejemplo para L30C: "GL070059-L30, L30A, L30B, L30C".

        - **distritoRiego**: 
            - Extracción: Localizar frases relacionadas con daños en infraestructura, por ejemplo: "daños registrados en infraestructura perteneciente al Distrito de Temporal Tecnificado 018 (DTT 018) Huixtla...".
            - Identificación: Extraer el nombre del distrito mencionado (ej. "Distrito de Temporal Tecnificado 018 (DTT 018) Huixtla").
            - Validación y Normalización: Comparar el texto extraído con el catálogo de distritos de riego.
            - Coincidencia parcial: Si se detecta similitud por contexto (ej. "DTT 018 Huixtla"), realizar el cruce.
            - Regla del nombre más completo:
                - Caso A (Enriquecimiento): Si el nombre extraído del documento es más completo que el del catálogo, utilizar y actualizar con el nombre extraído (ej. sustituir "DTT 018 Huixtla" por "Distrito de Temporal Tecnificado 018 (DTT 018) Huixtla").
                - Caso B (Estandarización): Si el catálogo ya posee el nombre completo y el documento usa una abreviatura, mantener el nombre oficial del catálogo.
            - Valor por defecto: Si no se menciona ningún distrito, asignar "SIN DATO".
            - Nota: Este campo es descriptivo y no determina la unicidad del comunicado.

        -  **distritoRiegoAccion**: 
            - Determina la acción a realizar en el catálogo basándose en la calidad del nombre extraído.
            - Valores permitidos:
                - "Actualiza": Se usa cuando el nombre extraído del documento es más completo o preciso que el que existe en la lista de distritos (ej. la lista tiene siglas y el documento el nombre completo).
                - "Mantener": Se usa cuando el nombre de la lista es igual o más completo que el del documento, o cuando solo se requiere validación.
            - Nota: Este campo es descriptivo y no determina la unicidad del comunicado.

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
        
        4. **⚠️ REGLA CRÍTICA - BÚSQUEDA DE TABLA CON DOS CATEGORÍAS**:
        
        **PASO 1: BUSCA** en el documento una tabla que tenga columnas con estos nombres o similares:
        - "DAÑO FÍSICO" o "Importe daño físico" o "Daño Material"
        - "REMOCIÓN Y DESAZOLVE" o "Importe Remoción" o "Desazolves" o "Desazolve"
        - "IMPORTE" o "TOTAL" (columna de suma)
        
        **PASO 2: CUANDO ENCUENTRES ESA TABLA**, para CADA FILA que tenga un concepto/ubicación:
        
        SI la columna "DAÑO FÍSICO" tiene valor > 0:
        → GENERA una línea con categoria = "DAÑO FISICO" y ese importe
        
        SI la columna "REMOCIÓN Y DESAZOLVE" tiene valor > 0:
        → GENERA OTRA línea con categoria = "DESAZOLVES" y ese importe
        
        **NUNCA** uses la columna "IMPORTE" (el total) como importe de línea.
        **SIEMPRE** usa los valores de las columnas separadas.
        
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
        
        **EJEMPLO 2 - CHARLES TAYLOR CON UNA SOLA FILA**:
        Si la tabla tiene UNA sola fila de concepto pero DOS columnas de importe:
        | N° | CONCEPTO | DAÑO FÍSICO | REMOCIÓN Y DESAZOLVE | IMPORTE |
        | P-01 | Canal Principal Margen Izquierda | $3,085,059.14 | $657,268.25 | $3,742,327.39 |
        
        DEBES GENERAR **DOS LÍNEAS**:
        "lineas": [
            { "concepto": "CANAL PRINCIPAL MARGEN IZQUIERDA", "categoria": "DAÑO FISICO", "importe": 3085059.14 },
            { "concepto": "CANAL PRINCIPAL MARGEN IZQUIERDA", "categoria": "DESAZOLVES", "importe": 657268.25 }
        ]
        
        **EJEMPLO 3 - DESCRIPCIÓN LARGA DE OBRA**:
        | N° | CONCEPTO | DAÑO FÍSICO | REMOCIÓN Y DESAZOLVE | IMPORTE |
        | P-01 | Obra de Protección a base de Tablaestaca Margen Derecha del Río Atoyac | $6,612,752.18 | $27,792.33 | $6,640,544.51 |
        
        DEBES GENERAR **DOS LÍNEAS**:
        "lineas": [
            { "concepto": "OBRA DE PROTECCIÓN A BASE DE TABLAESTACA MARGEN DERECHA DEL RÍO ATOYAC", "categoria": "DAÑO FISICO", "importe": 6612752.18 },
            { "concepto": "OBRA DE PROTECCIÓN A BASE DE TABLAESTACA MARGEN DERECHA DEL RÍO ATOYAC", "categoria": "DESAZOLVES", "importe": 27792.33 }
        ]
        
        ⚠️ **NO HAGAS ESTO (INCORRECTO)**:
        - ❌ Una sola línea con importe total (suma de ambas columnas)
        - ❌ Ignorar la columna de REMOCIÓN Y DESAZOLVE aunque sea pequeña
        - ❌ Líneas separadas por concepto (Preliminares, Demoliciones, etc.)
        - ❌ Incluir "- DAÑO FÍSICO" en el concepto

        ## FORMATO JSON ESPERADO (Alineado a CSV):
        {
        "header": {
            "refCta": "string (SIEMPRE empieza con 'GL'. Ej: GL070059, GL061410)",
            "ajustadorNombre": "string (CHARLES TAYLOR ADJUSTING)",
            "comunicadoId": "string (SIEMPRE empieza con 'L', NUNCA con 'GL'. Ej: L05, L05A, L30B. ❌NUNCA: GL06, GL070059)", 
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
            "distritoRiegoAccion": "string ("Actualiza", "Mantener", o "Sin Dato" si no se menciona)",
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

