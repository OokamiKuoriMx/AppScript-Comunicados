/**
 * ============================================================================
 * MÓDULO: IMPORTACIÓN INTELIGENTE (Versión Batch - High Performance)
 * Descripción: Procesa archivos planos (CSV) para generar estructura relacional.
 * Optimizado para leer una vez y escribir en lotes ordenados.
 * ============================================================================
 */

/**
 * API PÚBLICA: Previsualizar Importación (Solo Lectura)
 * Devuelve los datos parseados y validados para que el usuario confirme.
 */
function previsualizarImportacion(fileContent) {
    const contexto = 'previsualizarImportacion';
    console.log(`[${contexto}] Iniciando previsualización...`);

    try {
        // 1. REUTILIZAR PARSER Y CACHE
        const loteAgrupado = parseImportFile(fileContent);
        const cache = _loadCatalogsCache();

        // 2. SIMULAR VALIDACIÓN
        // 2. SIMULAR VALIDACIÓN
        validarLote(loteAgrupado, cache);

        // ORDENAMIENTO INTELIGENTE (Smart Batch Ordering) - Replicado para consistencia visual
        loteAgrupado.sort((a, b) => {
            const refA = String(a.header.refCta || '').trim();
            const refB = String(b.header.refCta || '').trim();
            if (refA !== refB) return refA.localeCompare(refB);
            const vA = _parseVersion(a.header.comunicadoId);
            const vB = _parseVersion(b.header.comunicadoId);
            if (vA.base !== vB.base) return vA.base.localeCompare(vB.base);
            if (vA.index !== vB.index) return vA.index - vB.index;
            const dateA = a.header.fechaDoc ? new Date(a.header.fechaDoc).getTime() : 0;
            const dateB = b.header.fechaDoc ? new Date(b.header.fechaDoc).getTime() : 0;
            return dateA - dateB;
        });

        // 3. ENRIQUECER PARA VISTA PREVIA
        // Pasamos 'loteAgrupado' completo como contexto para resolver padres en el mismo lote
        const previewData = loteAgrupado.map(doc => _analizarDocumento(doc, cache, loteAgrupado));

        const resumen = {
            total: previewData.length,
            validos: previewData.filter(d => d.esValido && d.status !== 'OMITIDO').length,
            omitidos: previewData.filter(d => d.esValido && d.status === 'OMITIDO').length,
            errores: previewData.filter(d => !d.esValido).length
        };

        return {
            success: true,
            data: {
                resumen: resumen,
                filas: previewData
            }
        };

    } catch (error) {
        console.error(`Error en ${contexto}:`, error);
        const msg = (error instanceof Error) ? error.message : String(error);
        return { success: false, message: msg || 'Error desconocido en previsualización' };
    }
}

/**
 * API PÚBLICA: Analiza un payload JSON (salida de IA) para generar el objeto de previsualización.
 * @param {Object} payload - Datos extraídos por la IA (header + lineas)
 * @param {Array} batchContext - Documentos previamente procesados del mismo lote (para detectar padres)
 */
function analizarExtraccionIA(payload, batchContext = []) {
    const contexto = 'analizarExtraccionIA';
    console.log(`[${contexto}] Inicio. Payload recibido:`, JSON.stringify(payload).substring(0, 500));
    console.log(`[${contexto}] BatchContext: ${batchContext.length} documentos previos`);

    try {
        if (!payload || !payload.header) {
            console.error(`[${contexto}] Payload inválido - no tiene header`);
            throw new Error('Payload inválido: falta header');
        }

        console.log(`[${contexto}] Header: refCta=${payload.header.refCta}, comunicado=${payload.header.comunicadoId}, tipo=${payload.header.tipoRegistro}`);

        const cache = _loadCatalogsCache();
        console.log(`[${contexto}] Cache cargado. Cuentas: ${cache.cuentas.length}, Comunicados: ${cache.comunicados.length}`);

        // Simular estructura de documento interno
        const doc = {
            header: payload.header,
            lineas: payload.lineas || [],
            validacion: { esValido: true, status: 'OK' }
        };

        // Convertir batchContext a formato esperado por _analizarDocumento
        const batchDocs = batchContext.map(ctx => ({
            header: ctx.rawPayload?.header || ctx.header || {},
            lineas: ctx.rawPayload?.lineas || ctx.lineas || [],
            validacion: { esValido: true, status: 'OK' }
        }));

        const analisisRow = _analizarDocumento(doc, cache, batchDocs);
        console.log(`[${contexto}] Análisis completado:`, JSON.stringify(analisisRow).substring(0, 300));

        return { success: true, data: analisisRow };

    } catch (e) {
        console.error(`[${contexto}] ERROR:`, e.message, e.stack);
        return { success: false, message: e.message || 'Error desconocido en análisis' };
    }
}

/**
 * Lógica central de análisis y comparativa con BD.
 */
function _analizarDocumento(doc, cache, batchDocs = []) {
    const h = doc.header;
    const v = doc.validacion;
    const esValido = v.esValido && v.status !== 'OMITIDO';

    // SANITIZACIÓN CRÍTICA DEL ID
    // Asegurar que trabajamos con "L30A" y no "GL070059-L30A" para que los Match de BD funcionen
    if (h.comunicadoId && h.comunicadoId.includes('-')) {
        const parts = h.comunicadoId.split('-');
        const cleanId = parts[parts.length - 1].trim();
        console.log(`[Import] Sanitizando ID: ${h.comunicadoId} -> ${cleanId}`);
        h.comunicadoId = cleanId;
    }

    // VALIDACIÓN ESTRICTA: comunicadoId DEBE empezar con "L" (el consecutivo)
    // Las referencias del ajustador (GL, AM, CT, etc.) NUNCA deben estar en comunicadoId
    if (h.comunicadoId) {
        const idUpper = String(h.comunicadoId).toUpperCase().trim();

        // Regex para detectar si empieza con un prefijo de referencia (2+ letras seguidas de números)
        // Ejemplos: GL061410, AM090123, CT070059
        const esReferenciaAjustador = /^[A-Z]{2,}\d+/.test(idUpper);

        if (esReferenciaAjustador) {
            console.error(`[Import] ERROR: comunicadoId "${h.comunicadoId}" parece ser una referencia de ajustador, no el consecutivo.`);

            // Intentar extraer el consecutivo correcto (L + números + letra opcional)
            // Busca patrones como "-L05", "-L05A" dentro del string
            const matchConsecutivo = idUpper.match(/L\d+[A-Z]?(?:\s|$|-|,|\))/);
            if (matchConsecutivo) {
                h.comunicadoId = matchConsecutivo[0].replace(/[\s\-,\)]/g, '');
                console.log(`[Import] Corregido comunicadoId a: ${h.comunicadoId}`);
            } else {
                // Intento alternativo: buscar cualquier "L" + números al final
                const matchFinal = idUpper.match(/L\d+[A-Z]?$/);
                if (matchFinal) {
                    h.comunicadoId = matchFinal[0];
                    console.log(`[Import] Corregido comunicadoId (método 2) a: ${h.comunicadoId}`);
                } else {
                    // No podemos corregirlo - marcar como error
                    doc.validacion.esValido = false;
                    doc.validacion.status = 'ERROR';
                    doc.validacion.motivo = `La IA devolvió una referencia de ajustador (${h.comunicadoId}) en lugar del consecutivo. El consecutivo debe ser "L" + número (ej: L05, L05A).`;
                }
            }
        }
        // Validar formato final: debe ser "L" + número + letra opcional
        else if (!idUpper.match(/^L\d+[A-Z]?$/)) {
            console.warn(`[Import] ADVERTENCIA: comunicadoId "${h.comunicadoId}" no cumple formato esperado (L + número + letra opcional)`);
            h.advertencias = h.advertencias || [];
            h.advertencias.push(`Formato de comunicadoId inusual: ${h.comunicadoId}`);
        }
    }

    // Detección de "Nuevos" Catálogos
    let statusAjustador = _checkStatus(cache.ajustadores, ['nombreAjustador', 'nombre'], (h.ajustadorNombre || h.ajustador));
    if (h.ajustadorAmbiguo) {
        statusAjustador = { status: 'AMBIGUO', valor: h.valorOriginalAjustador || h.ajustadorNombre, advertencia: 'Ambigüedad detectada por IA' };
    }

    let statusAseguradora = _checkStatus(cache.aseguradoras, 'descripción', (h.aseguradoraNombre || h.aseguradora));
    if (h.aseguradoraAmbigua) {
        statusAseguradora = { status: 'AMBIGUO', valor: h.valorOriginalAseguradora || h.aseguradoraNombre, advertencia: 'Ambigüedad detectada por IA' };
    }

    const analisis = {
        cuenta: _checkStatus(cache.cuentas, ['referencia', 'cuenta'], h.refCta),
        siniestro: _checkStatus(cache.siniestros, 'siniestro', h.refSiniestro),
        ajustador: statusAjustador,
        distrito: _checkStatusDistrito(cache.distritosRiego, h.distritoRiego, h.distritoRiegoAccion),
        aseguradora: statusAseguradora,
        advertencias: h.advertencias || []
    };

    // Enhanced Comunicado Analysis
    let statusCom = 'NUEVO';
    let changes = [];
    let existingCom = null;
    let dgActual = null;
    let resEstadoId = null;
    let posibleDuplicadoId = null;  // Variable de scope para detección de duplicados
    let advertencia = null;

    // 1. Find Account ID
    const refClean = String(h.refCta || '').trim().toUpperCase();
    const cta = cache.cuentas.find(c =>
        String(c.referencia).toUpperCase().trim() === refClean ||
        String(c.cuenta).toUpperCase().trim() === refClean
    );

    console.log(`[Import] Buscando cuenta: refClean="${refClean}", encontrada=${!!cta}${cta ? ` (id=${cta.id})` : ''}`);

    if (!cta) {
        console.log(`[Import] ADVERTENCIA: Cuenta "${refClean}" NO encontrada en cache. Cuentas disponibles: ${cache.cuentas.map(c => c.referencia).slice(0, 10).join(', ')}`);
    }

    if (cta) {
        // =================================================================================
        // NUEVA LÓGICA DE VALIDACIÓN (2025-12-30) - Basada en Clave: RefCta + ComunicadoID
        // =================================================================================
        // Clave de búsqueda: RefCta + ComunicadoID (raíz, ej. L30)
        const _cleanIdFunc = (val) => String(val || '').toUpperCase().replace(/\s+/g, '').trim();
        const comunicadoIdClean = _cleanIdFunc(h.comunicadoId);

        // Parsear versión del comunicado para detectar si tiene sufijo
        const versionInfo = _parseVersion(comunicadoIdClean);
        const tieneSufijo = versionInfo.index > 0; // L50A/B/C tienen index > 0

        // Determinar si es ORIGEN o ACTUALIZACION
        // REGLA CLAVE: 
        // - Sin sufijo (L50, L30, etc.) → SIEMPRE es ORIGEN (es el documento base)
        // - Con sufijo (L50A, L50B, etc.) → Es ACTUALIZACIÓN si existe padre
        let esOrigen = false;

        if (!tieneSufijo) {
            // Sin sufijo = SIEMPRE es origen (no importa lo que diga la IA)
            esOrigen = true;
            console.log(`[Import] ${comunicadoIdClean} NO tiene sufijo → Tratando como ORIGEN (documento base)`);
        } else {
            // Tiene sufijo: verificar si la IA lo marcó como ORIGEN o verificar padre en BD
            esOrigen = !h.tipoRegistro || h.tipoRegistro === 'ORIGEN';

            // Si la IA dice ORIGEN pero el ID tiene sufijo, verificar si existe padre
            if (esOrigen) {
                const baseId = versionInfo.base;
                const posiblePadre = cache.comunicados.find(c => {
                    if (String(c.idReferencia) !== String(cta.id)) return false;
                    return _parseVersion(c.comunicado).base === baseId;
                });

                if (posiblePadre) {
                    console.log(`[Import] CORRECCIÓN: ${comunicadoIdClean} tiene sufijo y padre "${posiblePadre.comunicado}" existe en BD → Tratando como ACTUALIZACIÓN`);
                    esOrigen = false;
                } else {
                    console.log(`[Import] ${comunicadoIdClean} tiene sufijo pero NO existe padre "${baseId}" en BD → Tratando como ORIGEN (caso raro)`);
                }
            } else {
                console.log(`[Import] ${comunicadoIdClean} tiene sufijo y IA dice actualización → Tratando como ACTUALIZACIÓN`);
            }
        }

        console.log(`[Import] Procesando: RefCta=${refClean}, ComunicadoID=${comunicadoIdClean}, TipoRegistro=${h.tipoRegistro}, esOrigen=${esOrigen}, tieneSufijo=${tieneSufijo}`);

        // CORRECCIÓN FORZADA DE DESCRIPCIÓN PARA ORIGEN
        // Si es ORIGEN, la descripción debe ser limpia (Ref-Com), ignorando cualquier historial alucinado por la IA
        if (esOrigen) {
            const descLimpia = `${refClean}-${comunicadoIdClean}`;
            if (h.descripcion !== descLimpia) {
                console.log(`[Import] Corrección de descripción ORIGEN: "${h.descripcion}" -> "${descLimpia}"`);
                h.descripcion = descLimpia;
            }
        }

        if (esOrigen) {
            // =========================================================================
            // CASO 1: ES ORIGEN (L30 con tipoRegistro='ORIGEN')
            // =========================================================================
            // Verificar si la clave (RefCta + ComunicadoID) ya existe en BD
            existingCom = cache.comunicados.find(c =>
                String(c.idReferencia) === String(cta.id) &&
                _cleanIdFunc(c.comunicado) === comunicadoIdClean
            );

            if (existingCom) {
                // EXISTE en BD → OMITIR (evitar duplicados)
                statusCom = 'OMITIDO';
                doc.validacion.motivo = `El comunicado ${h.comunicadoId} ya existe en la Base de Datos`;
                console.log(`[Import] ORIGEN ${h.comunicadoId} ya existe en BD → OMITIDO`);
            } else {
                // NO EXISTE → NUEVO REGISTRO
                statusCom = 'NUEVO';
                console.log(`[Import] ORIGEN ${h.comunicadoId} es NUEVO`);
            }

        } else {
            // =========================================================================
            // CASO 2: ES ACTUALIZACION (L30A, L30B con tipoRegistro != 'ORIGEN')
            // =========================================================================
            // Buscar obligatoriamente el PADRE (clave raíz) en Lote o BD
            const versionActual = _parseVersion(h.comunicadoId);
            const baseId = versionActual.base;
            console.log(`[Import] Buscando padre para actualización ${h.comunicadoId} (base: ${baseId})`);

            // A) Buscar padre en LOTE ACTUAL (Prioridad 1 - Para Vista Previa de batch)
            let padreEnLote = null;
            if (batchDocs && batchDocs.length > 0) {
                // Filtrar todos los posibles padres (misma base)
                const candidatosLote = batchDocs.filter(d => {
                    const dHeader = d.header;
                    const dRefClean = String(dHeader.refCta || '').trim().toUpperCase();
                    if (dRefClean !== refClean) return false;
                    const ver = _parseVersion(dHeader.comunicadoId);
                    return ver.base === baseId && ver.index < versionActual.index; // Debe ser anterior (L50 o L50A para L50B)
                });

                // Ordenar descendente para tomar el más reciente (el inmediato anterior)
                if (candidatosLote.length > 0) {
                    candidatosLote.sort((a, b) => {
                        const vA = _parseVersion(a.header.comunicadoId).index;
                        const vB = _parseVersion(b.header.comunicadoId).index;
                        return vB - vA; // Mayor a menor
                    });
                    padreEnLote = candidatosLote[0];
                    console.log(`[Import] Padre seleccionado en LOTE: ${padreEnLote.header.comunicadoId} (de ${candidatosLote.length} candidatos)`);
                }
            }

            // B) Buscar padre en BD
            const padreEnDB = cache.comunicados.find(c => {
                if (String(c.idReferencia) !== String(cta.id)) return false;
                return _parseVersion(c.comunicado).base === baseId;
            });

            // DEBUG: Log comunicados disponibles para esta cuenta
            const comsParaEstaCta = cache.comunicados.filter(c => String(c.idReferencia) === String(cta.id));
            console.log(`[Import] Comunicados en BD para cta.id=${cta.id}: ${comsParaEstaCta.map(c => c.comunicado).join(', ') || 'NINGUNO'}`);
            console.log(`[Import] Buscando base "${baseId}" → padreEnDB=${padreEnDB ? padreEnDB.comunicado : 'NO ENCONTRADO'}`);

            if (padreEnLote) {
                // Padre encontrado en LOTE → ACTUALIZACION (EN LOTE)
                statusCom = 'ACTUALIZACION_LOTE';
                existingCom = {
                    id: 'PENDIENTE',
                    comunicado: padreEnLote.header.comunicadoId,
                    tipoRegistro: padreEnLote.header.tipoRegistro,
                    simulado: true
                };
                console.log(`[Import] Padre encontrado en LOTE: ${padreEnLote.header.tipoRegistro || 'ORIGEN'} → ${h.tipoRegistro}`);

                // Construir historial de descripción para LOTE también
                const nuevaDescripcion = _construirHistorial(cache, cta, h.comunicadoId);
                // FIX: No sobrescribir si ya viene descripción de la IA
                if (nuevaDescripcion && !h.descripcion) {
                    h.descripcion = nuevaDescripcion;
                    console.log(`[Import] ACTUALIZACION_LOTE: Descripción construida: "${nuevaDescripcion}"`);
                }


            } else if (padreEnDB) {
                // Padre encontrado en BD → ACTUALIZACION (EN BD)
                statusCom = 'ACTUALIZACION_BD';
                existingCom = padreEnDB;
                console.log(`[Import] Padre encontrado en BD: ${padreEnDB.comunicado} → ${h.tipoRegistro}`);

                // Construir historial de descripción
                const nuevaDescripcion = _construirHistorial(cache, cta, h.comunicadoId);
                // FIX: No sobrescribir si ya viene descripción de la IA (User Request)
                if (nuevaDescripcion && !h.descripcion) {
                    h.descripcion = nuevaDescripcion;
                }

            } else {
                // Padre NO EXISTE en ningún lado → ERROR
                statusCom = 'ERROR_SIN_PADRE';
                doc.validacion.esValido = false;
                doc.validacion.status = 'ERROR';
                doc.validacion.motivo = `No se puede importar ${h.tipoRegistro}: No existe el comunicado padre (${h.comunicadoId}) ni en el lote actual ni en la BD`;
                console.log(`[Import] ERROR: No existe padre para ${h.tipoRegistro}`);
            }
        }

        // =========================================================================
        // ESTRATEGIA DE MERGE / CARRY-FORWARD (BACKEND SAFETY NET)
        // Garantizar que NUNCA se eliminen líneas del padre en una actualización.
        // Si la IA devolvió pocas líneas (ej. solo el cambio), fusionamos con el padre.
        // =========================================================================
        if (statusCom === 'ACTUALIZACION_LOTE' || statusCom === 'ACTUALIZACION_BD') {
            try {
                let lineasPadre = [];
                if (statusCom === 'ACTUALIZACION_LOTE' && padreEnLote) {
                    lineasPadre = padreEnLote.rawPayload.lineas || []; // Usar rawPayload.lineas del batch
                } else if (statusCom === 'ACTUALIZACION_BD' && padreEnDB) {
                    // Llamar a función global (definida en ai.service.gs o importacion.server.gs)
                    // Si no está disponible, implementar lógica simple de extracción aquí
                    if (typeof _obtenerLineasDeComunicado === 'function') {
                        lineasPadre = _obtenerLineasDeComunicado(padreEnDB.id, cache);
                    } else {
                        // Fallback si la función no es accesible (copia local de la lógica)
                        const acts = cache.actualizaciones.filter(a => String(a.idComunicado) === String(padreEnDB.id)) || [];
                        if (acts.length > 0) {
                            const ultAct = acts.sort((a, b) => b.consecutivo - a.consecutivo)[0];
                            const lns = cache.presupuestoLineas.filter(l => String(l.idActualizacion) === String(ultAct.id));
                            lineasPadre = lns.map(l => {
                                const desc = cache.descripcionLineas.find(d => String(d.id) === String(l.idLinea));
                                return {
                                    concepto: desc ? desc.descripcion : 'Sin descripción',
                                    categoria: l.categoria || 'DAÑO FISICO',
                                    importe: parseFloat(l.importe || 0)
                                };
                            });
                        }
                    }
                }

                if (lineasPadre.length > 0 && doc.lineas) {
                    console.log(`[Import] Iniciando MERGE: Padre (${lineasPadre.length} líneas) vs IA (${doc.lineas.length} líneas)`);

                    const _norm = (s) => String(s || '').toUpperCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
                    const keyFunc = (c, cat) => `${_norm(c)}|${_norm(cat)}`;

                    // Indexar líneas nuevas (IA)
                    const updatesMap = new Map();
                    doc.lineas.forEach(l => updatesMap.set(keyFunc(l.concepto, l.categoria), l));

                    // 1. Fusionar sobre la base del padre (ACTUALIZAR o CONSERVAR)
                    const lineasFinales = lineasPadre.map(lp => {
                        const k = keyFunc(lp.concepto, lp.categoria);
                        if (updatesMap.has(k)) {
                            const up = updatesMap.get(k);
                            updatesMap.delete(k); // Marcar como procesado
                            return { ...lp, importe: up.importe }; // Actualizar importe
                        }
                        return lp; // Conservar original
                    });

                    // 2. Agregar líneas nuevas (las que sobraron en updatesMap)
                    updatesMap.forEach(nuevo => lineasFinales.push(nuevo));

                    doc.lineas = lineasFinales;
                    console.log(`[Import] MERGE COMPLETADO: Resultado final ${lineasFinales.length} líneas.`);
                }
            } catch (e) {
                console.error('[Import] Error en MERGE strategy:', e);
            }
        }

        // Validar si es una versión obsoleta (Ej: Subir L30 cuando ya existe L30A)
        if (statusCom !== 'OMITIDO' && statusCom !== 'ERROR_SIN_PADRE') {
            const checkObsoleto = _validarVersionObsoleta(cache, cta.id, h.comunicadoId);
            if (checkObsoleto.esObsoleto) {
                return {
                    ref: h.refCta,
                    comunicado: h.comunicadoId,
                    tipo: h.tipoRegistro,
                    fecha: h.fechaDoc ? new Date(h.fechaDoc).toISOString().split('T')[0] : '',
                    monto: h.totalPdf,
                    sumaLineas: v.sumaLineas,
                    status: 'ERROR',
                    esValido: false,
                    motivo: checkObsoleto.mensaje,
                    analisis: {
                        comunicado: { status: 'OBSOLETO', valor: h.comunicadoId, debug: { msg: checkObsoleto.mensaje } }
                    },
                    rawPayload: { header: h, lineas: doc.lineas || [] }
                };
            }
        }

        // 3. NUEVO: Verificación de Contenido Duplicado (Líneas)
        // Si no es el mismo ID, pero tiene las mismas líneas/monto -> ALERTA DE DUPLICADO
        let posibleDuplicadoId = null;
        if (!existingCom && statusCom !== 'ACTUALIZACION') {
            // Buscar en DB records con el Mismo Monto y Mismo Numero de Lineas (heurística rápida)
            const totalPayload = parseFloat(h.totalPdf || 0);
            const lineasPayload = doc.lineas ? doc.lineas.length : 0;

            // Iterar comunicados de la cuenta
            const candidatos = cache.comunicados.filter(c => String(c.idReferencia) === String(cta.id));

            for (const c of candidatos) {
                // Necesitamos Datos Generales para el monto? O Lineas?
                // Cache.datosGenerales tiene monto? No, comunicados tiene 'monto' usualmente?
                // En DB, 'comunicados' tiene id, referencia, fecha... 'total'?
                // Vamos a cache.datosGenerales que tiene totales.
                const dg = cache.datosGenerales.find(d => String(d.idComunicado) === String(c.id));
                if (dg) {
                    // Comparar Monto (con tolerancia pequeña)
                    if (Math.abs(dg.total - totalPayload) < 0.1) {
                        // MISMO MONTO. Podría ser duplicado.
                        // Si tuvieramos lineas en cache sería ideal, pero es caro.
                        // Asumimos advertencia por monto idéntico.
                        posibleDuplicadoId = c.comunicado;
                        break;
                    }
                }
            }
        }

        if (existingCom) {
            // 3. Deep Compare for Smart Update
            dgActual = cache.datosGenerales.find(dg => String(dg.idComunicado) === String(existingCom.id));

            if (!dgActual) {
                statusCom = 'REEMPLAZAR'; // Existe Com pero no DG (Raro, pero forzamos update/insert DG)
            } else {
                // Comparacion profunda de campos clave
                let hasChanges = false;

                // Descripcion (Ahora comparamos contra la generada automáticamente)
                if (h.descripcion && normalizarTexto(h.descripcion) !== normalizarTexto(dgActual.descripcion)) {
                    hasChanges = true;
                    changes.push('Descripción (Autogenerada)');
                }

                // Fecha
                if (h.fechaDoc) {
                    const dateCSV = new Date(h.fechaDoc).toISOString().split('T')[0];
                    const dateDB = dgActual.fecha ? new Date(dgActual.fecha).toISOString().split('T')[0] : '';
                    if (dateCSV !== dateDB) {
                        hasChanges = true;
                        changes.push(`Fecha (${dateDB} -> ${dateCSV})`);
                    }
                }

                // Edo
                resEstadoId = _resolveIdFromCache(cache.estados, h.estado, 'estado');
                if (resEstadoId) {
                    if (String(resEstadoId) !== String(dgActual.idEstado)) {
                        hasChanges = true;
                        // Intentar obtener nombre anterior
                        const edoAnt = cache.estados.find(e => String(e.id) === String(dgActual.idEstado));
                        changes.push(`Estado (${edoAnt ? edoAnt.estado : '??'} -> ${h.estado})`);
                    }
                } else if (h.estado) {
                    hasChanges = true;
                    changes.push(`AVISO: Estado '${h.estado}' no encontrado`);
                }


                // Distrito
                const idDRNuevo = _resolveIdFromCache(cache.distritosRiego, h.distritoRiego, 'distritoRiego');
                if (idDRNuevo) {
                    if (String(idDRNuevo) !== String(dgActual.idDR)) {
                        hasChanges = true;
                        changes.push('Distrito');
                    }
                } else if (h.distritoRiego) {
                    hasChanges = true;
                    changes.push(`AVISO: Distrito '${h.distritoRiego}' no encontrado`);
                }

                // Siniestro
                const idSiniestroNuevo = _resolveIdFromCache(cache.siniestros, h.refSiniestro, 'siniestro');
                if (idSiniestroNuevo) {
                    if (String(idSiniestroNuevo) !== String(dgActual.idSiniestro)) {
                        hasChanges = true;
                        changes.push('Siniestro');
                    }
                } else if (h.refSiniestro) {
                    hasChanges = true;
                    changes.push(`AVISO: Siniestro '${h.refSiniestro}' no encontrado`);
                }

                if (existingCom.simulado) {
                    statusCom = 'ACTUALIZACION'; // Force update status for simulated/batch parents
                } else {
                    // NUEVO: Comparar líneas de presupuesto antes de decidir OMITIDO
                    if (!hasChanges && doc.lineas && doc.lineas.length > 0) {
                        // Buscar la actualización más reciente del comunicado
                        const actsPrevias = cache.actualizaciones.filter(a => String(a.idComunicado) === String(existingCom.id));
                        const actMasReciente = actsPrevias.sort((a, b) => Number(b.consecutivo) - Number(a.consecutivo))[0];

                        if (actMasReciente && actMasReciente.id) {
                            // Cargar líneas existentes
                            const lineasBDResponse = readAllRows('presupuestoLineas');
                            if (lineasBDResponse.success) {
                                const lineasExistentes = (lineasBDResponse.data || []).filter(l =>
                                    String(l.idActualizacion) === String(actMasReciente.id)
                                );

                                // Comparar líneas
                                const diffLineas = _compararLineas(doc.lineas, lineasExistentes);
                                if (diffLineas.hasDifferences) {
                                    hasChanges = true;
                                    changes.push(`Líneas (${diffLineas.inserts} nuevas, ${diffLineas.updates} actualizadas, ${diffLineas.deletes} eliminadas)`);
                                }
                            }
                        } else {
                            // No hay actualización previa, las líneas son nuevas
                            if (doc.lineas.length > 0) {
                                hasChanges = true;
                                changes.push(`Líneas (${doc.lineas.length} nuevas)`);
                            }
                        }
                    }

                    statusCom = hasChanges ? 'REEMPLAZAR' : 'OMITIDO';
                }
            }
        } else {
            // NO EXISTE EN DB (Ni padre ni exacto) -> Es NUEVO o ACTUALIZACION NUEVA
            if (h.esActualizacionExplicita || (h.tipoRegistro && h.tipoRegistro.length === 1 && h.tipoRegistro !== 'ORIGEN')) {
                // Es una actualización explicita (ej L30A) pero no encontramos L30.
                // Se trata como NUEVO registro, pero con status visual diferenciado.
                statusCom = 'ACTUALIZACION';
            } else if (posibleDuplicadoId) {
                // Nuevo pero con contenido duplicado
                statusCom = 'DUPLICADO_CONTENIDO';
                advertencia = `Posible duplicado de ${posibleDuplicadoId} (Mismo Monto)`;
            }
        }
    }

    // DEBUG: Inject diagnostics
    const debugInfo = {
        csvEstado: h.estado,
        duplicadoDe: posibleDuplicadoId || null,
        resId: resEstadoId,
        dbId: (existingCom && cache.datosGenerales.find(dg => String(dg.idComunicado) === String(existingCom.id))) ?
            cache.datosGenerales.find(dg => String(dg.idComunicado) === String(existingCom.id)).idEstado : '?'
    };

    analisis.comunicado = { status: statusCom, valor: h.comunicadoId, cambios: changes, debug: debugInfo };

    // Determine Global Status based on Analysis
    let finalStatus = v.status;
    let finalMotivo = v.motivo || (v.errores ? v.errores.join(', ') : '');

    if (esValido) {
        const isComOmitido = statusCom === 'OMITIDO';
        const isCtaNueva = analisis.cuenta && analisis.cuenta.status === 'NUEVO';
        const isSinNuevo = analisis.siniestro && analisis.siniestro.status === 'NUEVO';
        const isDrNuevo = analisis.distrito && analisis.distrito.status === 'NUEVO';

        if (isComOmitido && !isCtaNueva && !isSinNuevo && !isDrNuevo) {
            finalStatus = 'OMITIDO';
            finalMotivo = 'Registro idéntico a Base de Datos.';
        }
        if (statusCom === 'DUPLICADO_CONTENIDO') {
            // No bloqueamos, pero advertimos
            // finalStatus = 'ALERT'; 
            finalMotivo = `Posible duplicado de ${posibleDuplicadoId}`;
        }
    }

    return {
        ref: h.refCta,
        comunicado: h.comunicadoId,
        tipo: h.tipoRegistro,
        fecha: h.fechaDoc ? new Date(h.fechaDoc).toISOString().split('T')[0] : '',
        monto: h.totalPdf,
        sumaLineas: v.sumaLineas,
        status: finalStatus,

        esValido: esValido, // Keep valid so it counts as "processable" but omitted
        motivo: finalMotivo,
        analisis: analisis,
        rawPayload: { header: h, lineas: doc.lineas } // Data for single import

    }
}

/**
 * Parsea un ID de comunicado para extraer su base y versión.
 * Ej: "L30" -> { base: "L30", sufijo: "", index: 0 }
 * Ej: "L30A" -> { base: "L30", sufijo: "A", index: 1 }
 * Ej: "L30C" -> { base: "L30", sufijo: "C", index: 3 }
 */
function _parseVersion(comunicadoId) {
    if (!comunicadoId) return { base: '', sufijo: '', index: 0 };

    // Limpieza previa: Si viene con guiones (GL070059-L30A), tomar la última parte.
    let shortId = comunicadoId;
    if (comunicadoId.includes('-')) {
        const parts = comunicadoId.split('-');
        shortId = parts[parts.length - 1]; // Tomar "L30A" de "GL...-L30A"
    }
    shortId = shortId.trim();

    // Regex: (Todo lo que no sea la ultima letra si es mayuscula) + (Letra opcional)
    // Asumiendo formato estricto L(\d+)([A-Z]?)
    const match = shortId.match(/^(L\d+)([A-Z])?$/);

    if (match) {
        const base = match[1]; // L30
        const sufijo = match[2] || ''; // A, B, o nada

        let index = 0;
        if (sufijo) {
            // A=1, B=2, C=3...
            index = sufijo.charCodeAt(0) - 64;
        }

        return { base, sufijo, index };
    }

    // Si no cumple patrón Lxx, retornar como base pura
    return { base: shortId, sufijo: '', index: 0 };
}

/**
 * Valida si el comunicado entrante es una versión anterior a lo que ya existe.
 */
function _validarVersionObsoleta(cache, idReferencia, newComunicadoId) {
    if (!newComunicadoId) return { esObsoleto: false };

    const nueva = _parseVersion(newComunicadoId);

    // Filtrar comunicados de la misma cuenta y misma BASE (L30 vs L30A vs L30B)
    const hermanos = cache.comunicados.filter(c => {
        if (String(c.idReferencia) !== String(idReferencia)) return false;
        const v = _parseVersion(c.comunicado);
        return v.base === nueva.base;
    });

    if (hermanos.length === 0) return { esObsoleto: false };

    // Encontrar la versión máxima existente
    let maxVersion = -1;
    let maxCom = '';

    hermanos.forEach(h => {
        const v = _parseVersion(h.comunicado);
        if (v.index > maxVersion) {
            maxVersion = v.index;
            maxCom = h.comunicado;
        }
    });

    // Comparar
    // Si la nueva (ej: A=1) es MENOR que la máxima (ej: B=2) -> OBSOLETO
    if (nueva.index < maxVersion) {
        return {
            esObsoleto: true,
            mensaje: `Versión OBSOLETA. Ya existe una versión más reciente (${maxCom}) para este comunicado.`
        };
    }

    return { esObsoleto: false };
}

/**
 * Construye la descripción histórica: "Ref - Old1, Old2, New"
 */
function _construirHistorial(cache, cta, newComunicadoId) {
    if (!cta || !newComunicadoId) return null;

    const nueva = _parseVersion(newComunicadoId);
    let historial = new Set();

    // IMPORTANTE: Si es una actualización (tiene sufijo), siempre añadir la base primero
    // Esto asegura que L30A siempre tenga L30 en historial incluso si L30 está en el mismo lote
    if (nueva.sufijo) {
        historial.add(nueva.base); // Añadir L30 si estamos procesando L30A
    }

    // 1. Buscar en BD si ya existe algún hermano o el mismo registro (para sacar su historial previo)
    // Filtramos por cuenta y FAMILIA base (L30)
    const hermanos = cache.comunicados.filter(c => {
        if (String(c.idReferencia) !== String(cta.id)) return false;
        const v = _parseVersion(c.comunicado);
        return v.base === nueva.base;
    });

    // 2. Extraer historial de la descripción actual de esos hermanos
    // (Normalmente solo habrá 1 hermano si aplicamos la lógica de Unique Record)
    hermanos.forEach(h => {
        // Añadir el nombre actual del registro (ej: L30A)
        historial.add(h.comunicado);

        // Buscar su DatosGenerales para leer la descripción histórica (ej: "Ref - L30, L30A")
        const dg = cache.datosGenerales.find(d => String(d.idComunicado) === String(h.id));
        if (dg && dg.descripcion) {
            // Parsear descripción: "GL070059-L30, L30A" -> ["L30", "L30A"]
            // Asumimos formato: TEXTO - v1, v2, v3
            const partes = dg.descripcion.split('-');
            if (partes.length > 1) {
                const versionesStr = partes[1].trim(); // "L30, L30A"
                const versiones = versionesStr.split(',').map(s => s.trim());
                versiones.forEach(v => {
                    // Solo añadir si parece una versión válida de la misma familia
                    const vP = _parseVersion(v);
                    if (vP.base === nueva.base) {
                        historial.add(v);
                    }
                });
            }
        }
    });

    // 3. Añadir el nuevo
    historial.add(newComunicadoId);

    // 4. Convertir a array y ordenar
    const historialArr = Array.from(historial);
    historialArr.sort((a, b) => {
        const vA = _parseVersion(a);
        const vB = _parseVersion(b);
        return vA.index - vB.index;
    });

    const historialStr = historialArr.join(', ');
    return `${cta.referencia}-${historialStr}`;
}



/**
 * Helper para verificar si un valor existe en cache o será nuevo
 */
function _checkStatus(list, fields, value) {
    if (!value) return { status: 'VACIO', valor: '' };
    const cleanVal = String(value).toUpperCase().trim();

    // Check exist
    const exists = list.some(item => {
        if (Array.isArray(fields)) {
            return fields.some(f => String(item[f] || '').toUpperCase().trim() === cleanVal);
        }
        return String(item[fields] || '').toUpperCase().trim() === cleanVal;
    });

    return {
        status: exists ? 'EXISTE' : 'NUEVO',
        valor: value
    };
}

/**
 * NUEVO: Verificación especial para Distritos de Riego con soporte de distritoRiegoAccion
 * @param {Array} list - Lista de distritos existentes
 * @param {string} value - Valor del distrito del documento
 * @param {string} accion - Acción sugerida por la IA ("Actualiza", "Mantener", o "Sin Dato")
 * @returns {Object} Estado con información adicional de acción
 */
function _checkStatusDistrito(list, value, accion) {
    if (!value) return { status: 'VACIO', valor: '', accion: null };
    const cleanVal = String(value).toUpperCase().trim();

    // Normalizar acción
    const accionNorm = accion ? String(accion).toUpperCase().trim() : null;

    // Check if exists in DB
    const existingItem = list.find(item =>
        String(item.distritoRiego || '').toUpperCase().trim() === cleanVal
    );

    if (existingItem) {
        return {
            status: 'EXISTE',
            valor: value,
            accion: accionNorm,
            advertencia: accionNorm === 'ACTUALIZA' ? 'El catálogo se actualizará con este nombre más completo' : null
        };
    }

    // Puede ser un nombre más completo de uno existente
    // Buscar coincidencia parcial para determinar si es NUEVO o ACTUALIZA
    const matchParcial = _findMatchingDistrito(value, list);

    if (matchParcial && accionNorm === 'ACTUALIZA') {
        return {
            status: 'ACTUALIZA',
            valor: value,
            accion: accionNorm,
            valorAnterior: matchParcial.distritoRiego,
            advertencia: `Actualizará "${matchParcial.distritoRiego}" → "${cleanVal}"`
        };
    }

    return {
        status: 'NUEVO',
        valor: value,
        accion: accionNorm
    };
}

/**
 * PASO 7 (BACKEND): CONTROLADOR PRINCIPAL
 * Orquesta la importación completa usando Persistencia Batch.
 * @param {string} fileContent - Contenido de texto del archivo CSV.
 */
function importarUnico(payload) {
    const context = 'importarUnico';
    try {
        console.log(`[${context}] Raw payload received type: ${typeof payload}`);

        // Robust Parsing: If payload is stringified (to avoid GAS recursive copy issues), parse it.
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch (jsonErr) {
                console.warn(`[${context}] Failed to parse string payload:`, jsonErr);
            }
        }

        if (!payload || !payload.header || !payload.lineas) {
            const keys = payload ? JSON.stringify(Object.keys(payload)) : 'null';
            const type = typeof payload;
            console.error(`[${context}] Invalid payload structure. Type: ${type}, Keys: ${keys}`);
            throw new Error(`Payload inválido. Recibido: ${type}, Llaves: ${keys}`);
        }

        const cache = _loadCatalogsCache();

        // Construir documento base
        const doc = {
            header: payload.header,
            lineas: payload.lineas,
            validacion: { esValido: true, status: 'OK', sumaLineas: 0 }
        };

        // Calcular suma de líneas
        if (doc.lineas && doc.lineas.length > 0) {
            doc.validacion.sumaLineas = doc.lineas.reduce((sum, l) => sum + (parseFloat(l.importe) || 0), 0);
        }

        // CRÍTICO: Ejecutar análisis para obtener doc.analisis.comunicado.status
        const analisisResult = _analizarDocumento(doc, cache, []);

        // Reconstruir item con el análisis incluido
        const item = {
            header: payload.header,
            lineas: payload.lineas,
            validacion: {
                esValido: analisisResult.esValido !== false,
                status: analisisResult.status || 'OK',
                sumaLineas: doc.validacion.sumaLineas
            },
            analisis: analisisResult.analisis || { comunicado: { status: 'NUEVO' } }
        };

        console.log(`[${context}] Análisis result status: ${item.analisis.comunicado?.status}`);

        const loteAgrupado = [item];
        const result = _procesarBatchInterno(loteAgrupado, cache);
        console.log(`[${context}] Resultado Batch:`, JSON.stringify(result));
        return result;
    } catch (e) {
        console.error(e);
        return { success: false, message: e.message + (e.stack ? ' | ' + e.stack : '') };
    }
}

function ejecutarImportacion(fileContent) {
    const contexto = 'ejecutarImportacion';
    console.log(`[${contexto}] Iniciando procesamiento Batch...`);

    try {
        const loteAgrupado = parseImportFile(fileContent);
        const cache = _loadCatalogsCache();
        validarLote(loteAgrupado, cache);

        // ORDENAMIENTO INTELIGENTE (Smart Batch Ordering)
        // Asegurar que procesamos L30 -> L30A -> L30B para que la historia se construya correctamente
        loteAgrupado.sort((a, b) => {
            // 1. Por Referencia (Cuenta)
            const refA = String(a.header.refCta || '').trim();
            const refB = String(b.header.refCta || '').trim();
            if (refA !== refB) return refA.localeCompare(refB);

            // 2. Por Familia (Base del Comunicado, ej: L30)
            const vA = _parseVersion(a.header.comunicadoId);
            const vB = _parseVersion(b.header.comunicadoId);
            if (vA.base !== vB.base) return vA.base.localeCompare(vB.base);

            // 3. Por Índice de Versión (Origen=0, A=1, B=2...)
            if (vA.index !== vB.index) return vA.index - vB.index;

            // 4. Por Fecha Documento (Desempate final)
            // Priorizar más antiguos primero
            const dateA = a.header.fechaDoc ? new Date(a.header.fechaDoc).getTime() : 0;
            const dateB = b.header.fechaDoc ? new Date(b.header.fechaDoc).getTime() : 0;
            return dateA - dateB;
        });

        console.log(`[${contexto}] Lote ordenado para consistencia: ${loteAgrupado.map(d => d.header.comunicadoId).join(' -> ')}`);

        // CRÍTICO: Analizar cada documento para poblar doc.analisis
        // Esto es necesario para que _procesarBatchInterno pueda clasificar correctamente
        // los documentos como NUEVO, ACTUALIZACION_LOTE, ACTUALIZACION_BD, etc.
        loteAgrupado.forEach((doc, idx) => {
            const resultado = _analizarDocumento(doc, cache, loteAgrupado);
            // Copiar los campos de analisis al documento
            doc.analisis = resultado.analisis;
            console.log(`[${contexto}] Analizando ${idx + 1}/${loteAgrupado.length}: ${doc.header.comunicadoId} -> status: ${resultado.analisis?.comunicado?.status || 'N/A'}`);
        });

        return _procesarBatchInterno(loteAgrupado, cache);
    } catch (error) {
        console.error(`Error en ${contexto}:`, error);
        return { success: false, message: `Error fatal: ${error.message}` };
    }
}

function _procesarBatchInterno(loteAgrupado, cache) {
    const debugLogs = [];
    const logBatch = (msg) => {
        console.log(msg);
        debugLogs.push(msg);
    };

    const contexto = '_procesarBatchInterno';
    try {
        logBatch(`[${contexto}] Inicio de proceso batch. Total registros: ${loteAgrupado.length}`);

        // Separar válidos y omitidos
        const validos = loteAgrupado.filter(d => d.validacion.esValido && d.validacion.status !== 'OMITIDO');
        const omitidos = loteAgrupado.filter(d => !d.validacion.esValido || d.validacion.status === 'OMITIDO');

        if (validos.length === 0) {
            return _buildResponse(false, 'No hay registros válidos.', { total: loteAgrupado.length, omitidos: omitidos.length }, omitidos, loteAgrupado);
        }

        // ==========================================================================================
        // FASE 0: CLASIFICACIÓN DE DOCUMENTOS (NUEVOS vs EXISTENTES)
        // ==========================================================================================
        logBatch(`[${contexto}] FASE 0: Clasificando ${validos.length} documentos...`);

        const docsParaCrear = [];     // Comunicados que NO existen en la BD
        const docsParaActualizar = []; // Comunicados que SÍ existen en la BD

        validos.forEach(doc => {
            const idReferencia = _resolveIdFromCache(cache.cuentas, doc.header.refCta, ['referencia', 'cuenta']);

            // Si la cuenta no existe aún, se creará más adelante, así que lo marcamos como nuevo
            if (!idReferencia) {
                doc._isNew = true;
                doc._needsCuentaCreation = true;
                docsParaCrear.push(doc);
                return;
            }

            doc._idReferencia = idReferencia;

            // Check status for routing
            const st = doc.analisis.comunicado.status;

            if (st === 'NUEVO') {
                docsParaCrear.push(doc);
            } else if (st === 'ACTUALIZACION' || st === 'ACTUALIZACION_LOTE' || st === 'ACTUALIZACION_BD') {
                // Es una nueva versión (Ej: L30A) -> Crear registro, pero marcar como versión
                doc._esVersion = true;
                docsParaCrear.push(doc);
            } else if (st === 'REEMPLAZAR') {
                // Existe ID exacto y vamos a actualizarlo
                // NUEVA LÓGICA: Usar versionAnterior para encontrar el padre
                const _cleanId = (val) => String(val || '').toUpperCase().replace(/\s+/g, '').trim();

                // Método 1: Buscar por versionAnterior en actualizaciones
                const versionAnterior = doc.header.versionAnterior;
                let idComunicadoPadre = null;

                // Obtener la familia base del comunicado actual (ej: L05A -> L05)
                const familiaActual = _parseVersion(doc.header.comunicadoId).base;

                if (versionAnterior) {
                    logBatch(`[${contexto}] Buscando padre usando versionAnterior: "${versionAnterior}" (familia: ${familiaActual})`);

                    // Buscar en actualizaciones una revisión que coincida con versionAnterior
                    // y cuyo comunicado pertenezca a la misma cuenta y MISMA FAMILIA
                    const actPadre = cache.actualizaciones.find(a => {
                        // Verificar que la revisión coincida (L05 o "Origen" para L05)
                        const revNorm = _cleanId(a.revision);
                        const versionNorm = _cleanId(versionAnterior);

                        // Verificar que sea de la misma cuenta
                        const comPadre = cache.comunicados.find(c => String(c.id) === String(a.idComunicado));
                        if (!comPadre) return false;
                        if (String(comPadre.idReferencia) !== String(idReferencia)) return false;

                        // CRÍTICO: Verificar que sea de la MISMA FAMILIA (L05 vs L04)
                        const familiaCom = _parseVersion(comPadre.comunicado).base;
                        if (familiaCom !== familiaActual) return false;

                        // Ahora verificar la revisión
                        return revNorm === versionNorm || revNorm === 'ORIGEN';
                    });

                    if (actPadre) {
                        idComunicadoPadre = actPadre.idComunicado;
                        logBatch(`[${contexto}] Padre encontrado via versionAnterior: idComunicado=${idComunicadoPadre}`);
                    } else {
                        // Fallback: Buscar comunicado de la misma familia en cache
                        logBatch(`[${contexto}] No se encontró ${versionAnterior}, buscando comunicado de familia ${familiaActual}...`);
                        const comFamilia = cache.comunicados.find(c => {
                            if (String(c.idReferencia) !== String(idReferencia)) return false;
                            const familiaCom = _parseVersion(c.comunicado).base;
                            return familiaCom === familiaActual;
                        });

                        if (comFamilia) {
                            idComunicadoPadre = comFamilia.id;
                            logBatch(`[${contexto}] Comunicado de familia ${familiaActual} encontrado: idComunicado=${idComunicadoPadre}`);
                        }
                    }
                }

                // Método 2 (Fallback): Buscar comunicado existente por nombre exacto del comunicadoId
                if (!idComunicadoPadre) {
                    // Buscar por la BASE de la familia (ej: L05 para L05A)
                    const comExistente = cache.comunicados.find(c =>
                        String(c.idReferencia) === String(idReferencia) &&
                        _parseVersion(c.comunicado).base === familiaActual
                    );
                    if (comExistente) {
                        idComunicadoPadre = comExistente.id;
                        logBatch(`[${contexto}] Padre encontrado por familia: ComID=${idComunicadoPadre}`);
                    }
                }

                if (idComunicadoPadre) {
                    doc._existingComId = idComunicadoPadre;
                    logBatch(`[${contexto}] REEMPLAZAR: ${doc.header.comunicadoId} -> ComID: ${idComunicadoPadre}`);
                } else {
                    logBatch(`[${contexto}] WARN: REEMPLAZAR pero no se encontró padre para ${doc.header.comunicadoId}`);
                }
                docsParaActualizar.push(doc);
            } else if (st === 'OMITIDO' || st === 'ERROR_SIN_PADRE') {
                // No hacer nada - omitir
                logBatch(`[${contexto}] Omitiendo: ${doc.header.refCta}-${doc.header.comunicadoId} (${st})`);
            } else {
                // Fallback Nuevo
                docsParaCrear.push(doc);
            }


            return; // Skip the old logic block below for cleanliness or integrate?
            // The old logic block below re-did the search. I should replace it completely or let it run?
            // The old block (lines 651+) re-finds existingCom.
            // I should REPLACE the whole iteration logic to rely on `doc.analisis.comunicado.status`.

            /* 
               Refactoring Phase 0 to rely on Pre-Analysis Status is safer and consistent with Wizard.
               But `_analizarDocumento` might not have been run if we just called `ejecutarImportacion` directly?
               `ejecutarImportacion` calls `validarLote`, but `previsualizarImportacion` calls `_analizarDocumento`.
               `ejecutarImportacion` does NOT call `_analizarDocumento`.
               So `doc.analisis` might be missing or stale if we skip strict check here!
               
               However, `_procesarBatchInterno` is called by `importarUnico` (which prepares item with validation/analisis?)
               No, `importarUnico` calls `_procesarBatchInterno` with a constructed item.
               
               `ejecutarImportacion` calls `_procesarBatchInterno` directly.
               AND `ejecutarImportacion` does NOT call `_analizarDocumento`.
               So `doc.analisis` DOES NOT EXIST or is minimal.
               
               So I MUST keep the logic inside `_procesarBatchInterno`.
               
               I will Modify the logic inside the loop (lines 650+) to handle ACTUALIZACION.
            */
        });

        logBatch(`[${contexto}] Clasificación: ${docsParaCrear.length} NUEVOS, ${docsParaActualizar.length} EXISTENTES`);

        // ==========================================================================================
        // FASE 1: CREAR CATÁLOGOS AUXILIARES (Aseguradoras, Distritos, Ajustadores, Siniestros, Cuentas)
        // ==========================================================================================
        logBatch(`[${contexto}] FASE 1: Creando catálogos auxiliares...`);

        const counts = { newAsegs: 0, newSins: 0, newCuentas: 0, newComs: 0, newDG: 0, newActs: 0, newLines: 0, updatedDG: 0 };

        // Aseguradoras
        const newAseguradoras = _extractUnique(validos, (d => d.header.aseguradoraNombre || d.header.aseguradora), cache.aseguradoras, ['aseguradora', 'nombre', 'descripción']);
        if (newAseguradoras.length > 0) {
            logBatch(`[${contexto}] FASE 1: Creando ${newAseguradoras.length} aseguradoras nuevas: ${JSON.stringify(newAseguradoras)}`);
            const res = createBatch('aseguradoras', newAseguradoras.map(desc => ({ aseguradora: desc })));
            counts.newAsegs += res.count;
            _updateCache(cache, 'aseguradoras', res.ids, newAseguradoras, 'aseguradora');
        }

        // Distritos - NUEVO: Soporta distritoRiegoAccion ("Actualiza" | "Mantener")
        const newDistritos = _extractUnique(validos, 'distritoRiego', cache.distritosRiego, 'distritoRiego');
        if (newDistritos.length > 0) {
            logBatch(`[${contexto}] FASE 1: Creando ${newDistritos.length} distritos nuevos: ${JSON.stringify(newDistritos)}`);
            const res = createBatch('distritosRiego', newDistritos.map(d => ({ distritoRiego: d })));
            _updateCache(cache, 'distritosRiego', res.ids, newDistritos, 'distritoRiego');
        }

        // NUEVO: Procesar actualizaciones de distritos existentes cuando distritoRiegoAccion = "Actualiza"
        const distritosParaActualizar = _extractDistritosToUpdate(validos, cache.distritosRiego);
        if (distritosParaActualizar.length > 0) {
            logBatch(`[${contexto}] FASE 1: Actualizando ${distritosParaActualizar.length} distritos con nombres más completos...`);
            distritosParaActualizar.forEach(upd => {
                try {
                    const resUpd = updateRow('distritosRiego', upd.id, { distritoRiego: upd.nuevoNombre });
                    if (resUpd.success) {
                        // Actualizar cache local
                        const distritoEnCache = cache.distritosRiego.find(d => String(d.id) === String(upd.id));
                        if (distritoEnCache) {
                            distritoEnCache.distritoRiego = upd.nuevoNombre;
                        }
                        logBatch(`[${contexto}] Distrito actualizado: "${upd.nombreAnterior}" -> "${upd.nuevoNombre}"`);
                    } else {
                        logBatch(`[${contexto}] ERROR actualizando distrito ${upd.id}: ${resUpd.message}`);
                    }
                } catch (e) {
                    logBatch(`[${contexto}] EXCEPCION actualizando distrito: ${e.message}`);
                }
            });
        }

        // Ajustadores
        const newAjustadores = _extractUnique(validos, (d => d.header.ajustadorNombre || d.header.ajustador), cache.ajustadores, 'nombreAjustador');
        if (newAjustadores.length > 0) {
            const validNewAjustadores = newAjustadores.filter(a => a && a.length > 2);
            if (validNewAjustadores.length > 0) {
                const res = createBatch('ajustadores', validNewAjustadores.map(a => ({ nombreAjustador: a, nombre: a })));
                _updateCache(cache, 'ajustadores', res.ids, validNewAjustadores, 'nombreAjustador');
            }
        }

        // Siniestros
        const siniestrosMap = _prepareSiniestrosBatch(validos, cache);
        if (siniestrosMap.inserts.length > 0) {
            const res = createBatch('siniestros', siniestrosMap.inserts);
            counts.newSins += res.count;
            _updateCache(cache, 'siniestros', res.ids, siniestrosMap.keys, 'siniestro');
        }

        // Cuentas
        const idAjustadorDefault = _findIdAjustadorDefault(cache.ajustadores);
        const cuentasMap = _prepareCuentasBatch(validos, cache, idAjustadorDefault);
        if (cuentasMap.inserts.length > 0) {
            const res = createBatch('cuentas', cuentasMap.inserts);
            counts.newCuentas += res.count;
            _updateCache(cache, 'cuentas', res.ids, cuentasMap.keys, ['referencia', 'cuenta']);
        }

        SpreadsheetApp.flush();
        logBatch(`[${contexto}] FASE 1 completada. Catálogos creados.`);

        // ==========================================================================================
        // FASE 2: CREAR COMUNICADOS NUEVOS (y sus DatosGenerales + Actualizaciones)
        // ==========================================================================================
        const batchComunicados = [];
        const batchDatosGenerales = [];
        const batchActualizaciones = [];
        const batchPresupuestos = [];
        let resActs = null; // Declarar en scope superior para que sea accesible en el procesamiento de líneas

        if (docsParaCrear.length > 0) {
            logBatch(`[${contexto}] FASE 2: Procesando ${docsParaCrear.length} comunicados NUEVOS...`);

            // 2A: Preparar datos de comunicados únicos para insertar
            const comUnicosPorKey = new Map(); // Evitar duplicados

            docsParaCrear.forEach(doc => {
                // Resolver idReferencia (ahora que las cuentas ya se crearon)
                const idReferencia = _resolveIdFromCache(cache.cuentas, doc.header.refCta, ['referencia', 'cuenta']);
                doc._idReferencia = idReferencia;

                if (!idReferencia) {
                    logBatch(`[${contexto}] WARN: No se pudo resolver cuenta para ${doc.header.refCta}`);
                    _markError(doc, omitidos, `Cuenta ${doc.header.refCta} no encontrada`);
                    return;
                }

                const st = doc.analisis?.comunicado?.status;

                // CASO ESPECIAL: ACTUALIZACION_BD - El padre ya existe, NO crear nuevo comunicado
                if (st === 'ACTUALIZACION_BD' && doc._esVersion) {
                    // Buscar el comunicado padre existente en cache
                    // Buscar el comunicado padre existente en cache
                    const baseId = _parseVersion(doc.header.comunicadoId).base;
                    const padreExistente = cache.comunicados.find(c =>
                        String(c.idReferencia) === String(idReferencia) &&
                        _parseVersion(c.comunicado).base === baseId
                    );

                    if (padreExistente) {
                        // Usar el ID del padre, NO crear uno nuevo
                        doc._newComId = padreExistente.id;
                        logBatch(`[${contexto}] ACTUALIZACION_BD: ${doc.header.tipoRegistro} usa padre existente ComID ${padreExistente.id}`);
                        return; // No agregar a comUnicosPorKey
                    } else {
                        logBatch(`[${contexto}] WARN: ACTUALIZACION_BD pero padre no encontrado. Creando como nuevo.`);
                    }
                }

                const key = `${idReferencia}|${doc.header.comunicadoId}`;

                if (!comUnicosPorKey.has(key)) {
                    comUnicosPorKey.set(key, {
                        data: { idReferencia, comunicado: doc.header.comunicadoId, status: 1 },
                        docs: [doc]
                    });
                } else {
                    comUnicosPorKey.get(key).docs.push(doc);
                }
            });

            // 2B: Insertar comunicados nuevos
            const comUnicosArray = Array.from(comUnicosPorKey.values());
            if (comUnicosArray.length > 0) {
                const comsBatchData = comUnicosArray.map(item => item.data);
                logBatch(`[${contexto}] Insertando ${comsBatchData.length} comunicados nuevos...`);

                const resComs = createBatch('comunicados', comsBatchData);
                counts.newComs += resComs.count;

                // Asignar IDs reales a los documentos
                resComs.ids.forEach((realId, i) => {
                    const item = comUnicosArray[i];
                    item.docs.forEach(d => d._newComId = realId);
                    cache.comunicados.push({ id: realId, ...item.data });
                });

                SpreadsheetApp.flush();
            }

            // 2B-bis: ASIGNAR IDs A ACTUALIZACIONES EN LOTE
            // Ahora que los ORIGEN ya tienen IDs, buscar y asignar a los ACTUALIZACION_LOTE
            const _cleanId = (val) => String(val || '').toUpperCase().replace(/\s+/g, '').trim();

            docsParaCrear.forEach(doc => {
                // Solo procesar si no tiene ID y es ACTUALIZACION_LOTE
                if (doc._newComId) return;

                const st = doc.analisis?.comunicado?.status;
                if (st !== 'ACTUALIZACION_LOTE') return;

                const idReferencia = doc._idReferencia;
                if (!idReferencia) return;

                // Buscar el comunicado padre (ORIGEN) recién creado en cache
                // Buscar el comunicado padre (ORIGEN) recién creado en cache
                const baseId = _parseVersion(doc.header.comunicadoId).base;
                const padreRecienCreado = cache.comunicados.find(c =>
                    String(c.idReferencia) === String(idReferencia) &&
                    _parseVersion(c.comunicado).base === baseId
                );

                if (padreRecienCreado) {
                    doc._newComId = padreRecienCreado.id;
                    logBatch(`[${contexto}] ACTUALIZACION_LOTE: ${doc.header.tipoRegistro} asignado a padre ComID ${padreRecienCreado.id}`);
                } else {
                    logBatch(`[${contexto}] WARN: ACTUALIZACION_LOTE ${doc.header.tipoRegistro} - padre no encontrado en cache`);
                }
            });

            // 2C: Crear DatosGenerales y Actualizaciones para cada documento nuevo
            docsParaCrear.forEach(doc => {
                const idComunicado = doc._newComId;
                if (!idComunicado) {
                    logBatch(`[${contexto}] SKIP: Doc ${doc.header.refCta}-${doc.header.comunicadoId} sin ID de comunicado`);
                    return;
                }

                const isOrigen = doc.header.tipoRegistro === 'ORIGEN';

                // Crear o Actualizar DatosGenerales
                const dgExistente = batchDatosGenerales.find(dg => String(dg.idComunicado) === String(idComunicado));

                // LÓGICA STRICTA: Si NO es ORIGEN -> Actualizar Descripción en BD
                if (!dgExistente && doc.header.tipoRegistro !== 'ORIGEN') {
                    // Si NO es Origen, buscamos el DG existente usando ID_REF + COMUNICADO_BASE (L30)
                    // y actualizamos SU descripción directamente con la descripción del Header (IA).
                    logBatch(`[${contexto}] NO ES ORIGEN (${doc.header.tipoRegistro}): Buscando DG para actualizar descripción...`);

                    const cleanBase = _parseVersion(doc.header.comunicadoId).base;

                    // 1. Buscar Comunicado Padre
                    const comPadre = cache.comunicados.find(c =>
                        String(c.idReferencia) === String(idReferencia) &&
                        _parseVersion(c.comunicado).base === cleanBase
                    );

                    // 2. Buscar DatosGenerales de ese comunicado
                    const dgEnBD = comPadre ? cache.datosGenerales.find(dg => String(dg.idComunicado) === String(comPadre.id)) : null;

                    if (dgEnBD) {
                        logBatch(`[${contexto}] ACTUALIZACION ENCONTRADA: Actualizando descripción de DG existente ID ${dgEnBD.id}`);

                        // Construir descripción con historial completo de versiones
                        // En vez de usar la descripción de la IA (que no tiene acceso al historial),
                        // construimos añadiendo la versión actual al historial existente en BD.
                        let descripcionFinal = dgEnBD.descripcion || '';
                        const versionActual = doc.header.comunicadoId;

                        // Si la descripción actual ya NO contiene la versión actual, añadirla
                        if (descripcionFinal && !descripcionFinal.includes(versionActual)) {
                            descripcionFinal = `${descripcionFinal}, ${versionActual}`;
                        } else if (!descripcionFinal) {
                            // Fallback: si no hay descripción existente, usar la de la IA
                            descripcionFinal = doc.header.descripcion || `${doc.header.refCta}-${versionActual}`;
                        }

                        logBatch(`[${contexto}] DESCRIPCION HISTORIAL: "${dgEnBD.descripcion}" -> "${descripcionFinal}"`);

                        // Actualizar en BD
                        try {
                            const resUpd = updateRow('datosGenerales', dgEnBD.id, { descripcion: descripcionFinal });
                            if (resUpd.success) {
                                dgEnBD.descripcion = descripcionFinal; // Actualizar cache local
                                counts.updatedDG = (counts.updatedDG || 0) + 1;
                            }
                        } catch (e) {
                            logBatch(`[${contexto}] Error al actualizar descripción DG: ${e.message}`);
                        }

                        // Ya actualizamos el existente, NO necesitamos crear uno nuevo en batchDatosGenerales
                        // PERO sí necesitamos que el código de abajo (Actualizaciones) funcione.
                        // Usaremos el ID del comunicado existente.
                        var idComunicadoExistente = dgEnBD.idComunicado;
                    }
                }

                if (!dgExistente && !idComunicadoExistente) {

                    // CREAR nuevo DatosGenerales (primera versión del comunicado)
                    const idEstado = _resolveIdFromCache(cache.estados, doc.header.estado, 'estado');
                    const idSiniestro = _resolveIdFromCache(cache.siniestros, doc.header.refSiniestro, 'siniestro');
                    const idDR = _resolveIdFromCache(cache.distritosRiego, doc.header.distritoRiego, 'distritoRiego');
                    let idAjustador = _resolveIdFromCache(cache.ajustadores, doc.header.ajustador, ['nombreAjustador', 'nombre']) || idAjustadorDefault;

                    logBatch(`[${contexto}] FASE 2: Creando DG para nuevo ComID ${idComunicado} (Estado: ${doc.header.estado} -> ${idEstado})`);

                    batchDatosGenerales.push({
                        idComunicado: idComunicado,
                        descripcion: doc.header.descripcion || `${doc.header.refCta}-${doc.header.comunicadoId}`,
                        fecha: doc.header.fechaDoc,
                        idEstado: idEstado,
                        idSiniestro: idSiniestro,
                        idDR: idDR,
                        idAjustador: idAjustador
                    });
                } else {
                    // ACTUALIZAR descripción del DG existente con la última versión
                    // Esto sucede cuando hay múltiples versiones en el mismo lote (L30, L30A, L30B)
                    if (doc.header.comunicadoId && !isOrigen) {
                        // Construir historial de versiones
                        let descripcionFinal = dgExistente.descripcion || '';
                        const versionActual = doc.header.comunicadoId;

                        if (descripcionFinal && !descripcionFinal.includes(versionActual)) {
                            descripcionFinal = `${descripcionFinal}, ${versionActual}`;
                        } else if (!descripcionFinal) {
                            descripcionFinal = doc.header.descripcion || `${doc.header.refCta}-${versionActual}`;
                        }

                        logBatch(`[${contexto}] FASE 2: Actualizando descripción DG (lote) de "${dgExistente.descripcion}" -> "${descripcionFinal}"`);
                        dgExistente.descripcion = descripcionFinal;

                        // Si el DG ya tiene un ID (existe en BD), también actualizarlo en BD
                        if (dgExistente.id) {
                            try {
                                const resUpd = updateRow('datosGenerales', dgExistente.id, { descripcion: descripcionFinal });
                                if (resUpd.success) {
                                    counts.updatedDG = (counts.updatedDG || 0) + 1;
                                    logBatch(`[${contexto}] FASE 2: Descripción actualizada en BD para DG ID ${dgExistente.id}`);
                                }
                            } catch (e) {
                                logBatch(`[${contexto}] FASE 2: Error actualizando descripción en BD: ${e.message}`);
                            }
                        }
                    }
                }

                // CASO ESPECIAL: ACTUALIZACION_BD - El DG ya existe en BD, actualizar descripción
                const st = doc.analisis?.comunicado?.status;
                if (st === 'ACTUALIZACION_BD' && doc.header.comunicadoId) {
                    // Buscar DG existente en cache de BD
                    const dgEnBD = cache.datosGenerales.find(dg => String(dg.idComunicado) === String(idComunicado));
                    if (dgEnBD) {
                        // Construir historial de versiones
                        let descripcionFinal = dgEnBD.descripcion || '';
                        const versionActual = doc.header.comunicadoId;

                        if (descripcionFinal && !descripcionFinal.includes(versionActual)) {
                            descripcionFinal = `${descripcionFinal}, ${versionActual}`;
                        } else if (!descripcionFinal) {
                            descripcionFinal = doc.header.descripcion || `${doc.header.refCta}-${versionActual}`;
                        }

                        logBatch(`[${contexto}] FASE 2: ACTUALIZACION_BD - Actualizando descripción en BD de "${dgEnBD.descripcion}" -> "${descripcionFinal}"`);
                        try {
                            const resUpd = updateRow('datosGenerales', dgEnBD.id, { descripcion: descripcionFinal });
                            if (resUpd.success) {
                                dgEnBD.descripcion = descripcionFinal; // Actualizar cache
                                counts.updatedDG = (counts.updatedDG || 0) + 1;
                            } else {
                                logBatch(`[${contexto}] ERROR actualizando descripción: ${resUpd.message}`);
                            }
                        } catch (e) {
                            logBatch(`[${contexto}] EXCEPCION actualizando descripción: ${e.message}`);
                        }
                    }
                }

                // Crear Actualizacion
                const actsPrevias = batchActualizaciones.filter(a => String(a.idComunicado) === String(idComunicado));
                const consecutivo = actsPrevias.length + 1;

                logBatch(`[${contexto}] FASE 2: Creando Actualizacion #${consecutivo} para ComID ${idComunicado}`);

                batchActualizaciones.push({
                    idComunicado: idComunicado,
                    consecutivo: consecutivo,
                    esOrigen: isOrigen && consecutivo === 1 ? 1 : 0,
                    revision: isOrigen ? 'Origen' : doc.header.tipoRegistro,
                    monto: doc.header.totalPdf,
                    montoCapturado: null,
                    montoSupervisión: (doc.header.totalPdf || 0) * 0.05,
                    fecha: new Date(),
                    _docLineas: doc.lineas,
                    _tipoAccion: doc.header.tipoAccion || null,
                    _ubicacionEspecifica: doc.header.ubicacionEspecifica || null
                });
            });

            logBatch(`[${contexto}] FASE 2 completada. DG preparados: ${batchDatosGenerales.length}, Acts preparadas: ${batchActualizaciones.length}`);
        }

        // ==========================================================================================
        // FASE 3: ACTUALIZAR COMUNICADOS EXISTENTES
        // ==========================================================================================
        if (docsParaActualizar.length > 0) {
            logBatch(`[${contexto}] FASE 3: Procesando ${docsParaActualizar.length} comunicados EXISTENTES...`);

            // DEBUG: Mostrar qué documentos van a actualizarse
            docsParaActualizar.forEach((doc, idx) => {
                logBatch(`[${contexto}] FASE 3 - Doc #${idx + 1}: ${doc.header.refCta}-${doc.header.comunicadoId} | Tipo: ${doc.header.tipoRegistro} | Desc CSV: "${doc.header.descripcion}"`);
            });

            docsParaActualizar.forEach(doc => {
                const idComunicado = doc._existingComId;
                const isOrigen = doc.header.tipoRegistro === 'ORIGEN';

                // =========================================================
                // 3.0 VERSION UPGRADE (Actualizar nombre en tabla comunicados)
                // =========================================================
                if (doc._isVersionUpgrade) {
                    logBatch(`[${contexto}] FASE 3: Upgrade de Versión detectado para ID ${idComunicado}: -> ${doc.header.comunicadoId}`);
                    try {
                        const resUpdName = updateRow('comunicados', idComunicado, { comunicado: doc.header.comunicadoId });
                        if (!resUpdName.success) {
                            logBatch(`[${contexto}] ERROR al actualizar nombre de comunicado: ${resUpdName.message}`);
                        } else {
                            // Actualizar cache local por si acaso
                            const comCache = cache.comunicados.find(c => String(c.id) === String(idComunicado));
                            if (comCache) comCache.comunicado = doc.header.comunicadoId;
                        }
                    } catch (e) {
                        logBatch(`[${contexto}] EXCEPCION updating comunicado name: ${e.message}`);
                    }
                }

                // Buscar DatosGenerales existente
                const existingDG = cache.datosGenerales.find(dg => String(dg.idComunicado) === String(idComunicado));

                if (existingDG) {
                    logBatch(`[${contexto}] FASE 3: Verificando actualización para ComID ${idComunicado} | DG.id: ${existingDG.id} | DG.desc DB: "${existingDG.descripcion}"`);

                    // Comparar campos y preparar updates
                    const updates = {};
                    let doUpdate = false;

                    // 1. Estado
                    const idEstado = _resolveIdFromCache(cache.estados, doc.header.estado, 'estado');
                    if (idEstado && String(idEstado) !== String(existingDG.idEstado)) {
                        logBatch(`[${contexto}] -> Estado CAMBIO: ${existingDG.idEstado} -> ${idEstado}`);
                        updates.idEstado = idEstado;
                        doUpdate = true;
                    }

                    // 2. Distrito
                    const idDR = _resolveIdFromCache(cache.distritosRiego, doc.header.distritoRiego, 'distritoRiego');
                    if (idDR && String(idDR) !== String(existingDG.idDR)) {
                        logBatch(`[${contexto}] -> Distrito CAMBIO: ${existingDG.idDR} -> ${idDR}`);
                        updates.idDR = idDR;
                        doUpdate = true;
                    }

                    // 3. Siniestro
                    const idSiniestro = _resolveIdFromCache(cache.siniestros, doc.header.refSiniestro, 'siniestro');
                    if (idSiniestro && String(idSiniestro) !== String(existingDG.idSiniestro)) {
                        updates.idSiniestro = idSiniestro;
                        doUpdate = true;
                    }

                    // 4. Fecha
                    if (doc.header.fechaDoc) {
                        const dateCSV = new Date(doc.header.fechaDoc).toISOString().split('T')[0];
                        const dateDB = existingDG.fecha ? new Date(existingDG.fecha).toISOString().split('T')[0] : '';
                        if (dateCSV !== dateDB) {
                            updates.fecha = dateCSV;
                            doUpdate = true;
                        }
                    }

                    // 5. Descripción: Recalcular SIEMPRE para asegurar historial acumulativo en batch (L30A, L30B, L30C)
                    // Resolver objeto cuenta para el helper
                    const ctaObj = cache.cuentas.find(c => c.id === existingDG.idReferencia) || cache.cuentas.find(c => c.referencia === doc.header.refCta);

                    // RECALCULAR Historial en tiempo real usando el cache (que se irá actualizando en cada ciclo del loop)
                    const descCalculada = _construirHistorial(cache, ctaObj, doc.header.comunicadoId);

                    // Prioridad: IA primero (si tiene descripción), si no, usar la calculada
                    const descFinal = doc.header.descripcion || descCalculada || '';

                    if (descFinal) {
                        const descNueva = String(descFinal).trim();
                        const descExistente = String(existingDG.descripcion || '').trim();

                        logBatch(`[${contexto}] DEBUG Descripción - Calc: "${descNueva}" | DB: "${descExistente}"`);

                        // Verificar si debemos forzar actualización por tipo de acción
                        const tipoAccion = doc.header.tipoAccion;
                        const esSustitucion = tipoAccion === 'SUSTITUCION_PARCIAL' || tipoAccion === 'SUSTITUCION_TOTAL';

                        // Si es sustitución explícita, PREFERIR la descripción del header sobre la calculada
                        // y FORZAR la actualización si hay algo en el header
                        let finalDescToUse = descNueva;
                        let forceUpdate = false;

                        if (esSustitucion && doc.header.descripcion) {
                            finalDescToUse = String(doc.header.descripcion).trim();
                            if (finalDescToUse !== descExistente) {
                                forceUpdate = true;
                                logBatch(`[${contexto}] -> FORZANDO actualización por Sustitución: "${finalDescToUse}"`);
                            }
                        }

                        // Solo actualizar si es diferente O si se fuerza
                        if (forceUpdate || normalizarTexto(finalDescToUse) !== normalizarTexto(descExistente)) {
                            updates.descripcion = finalDescToUse;
                            doUpdate = true;
                            logBatch(`[${contexto}] -> Descripción ACTUALIZADA: "${descExistente}" -> "${finalDescToUse}"`);
                        } else {
                            logBatch(`[${contexto}] -> Descripción SIN CAMBIOS (idéntica normalizada)`);
                        }
                    } else {
                        logBatch(`[${contexto}] -> SIN descripción calculada ni en header`);
                    }

                    if (doUpdate) {
                        logBatch(`[${contexto}] -> Ejecutando UPDATE para DG ID ${existingDG.id}: ${JSON.stringify(updates)}`);
                        try {
                            const resUpd = updateRow('datosGenerales', existingDG.id, updates);
                            if (resUpd.success) {
                                counts.updatedDG++;
                                logBatch(`[${contexto}] -> UPDATE exitoso para DG ID ${existingDG.id}`);

                                // CRITICO: Actualizar el CACHE en memoria para que la siguiente iteración (ej: L30B -> L30C)
                                // vea la descripción actualizada (L30, L30B) y pueda adjuntar la suya.
                                Object.assign(existingDG, updates);

                            } else {
                                logBatch(`[${contexto}] -> UPDATE falló para DG ID ${existingDG.id}: ${resUpd.message}`);
                            }
                        } catch (e) {
                            logBatch(`[${contexto}] -> UPDATE error: ${e.message}`);
                            _markError(doc, omitidos, `Error al actualizar: ${e.message}`);
                        }
                    } else {
                        logBatch(`[${contexto}] -> Sin cambios detectados para ComID ${idComunicado}`);
                    }
                } else {
                    logBatch(`[${contexto}] WARN: No se encontró DG para ComID existente ${idComunicado}`);
                }

                // Crear nueva Actualizacion (siempre, para registrar la nueva revisión)
                // IDEMPOTENCIA: Verificar si ya existe esta revisión para evitar duplicados (ej: "ORIGEN" repetido)
                const actsPrevias = cache.actualizaciones.filter(a => String(a.idComunicado) === String(idComunicado));
                const actsEnBatch = batchActualizaciones.filter(a => String(a.idComunicado) === String(idComunicado));

                const tipoRevision = doc.header.tipoRegistro || 'Actualización';

                // Normalizar para comparar (ej: "ORIGEN" vs "Origen")
                const yaExiste = [...actsPrevias, ...actsEnBatch].some(a =>
                    String(a.revision).toUpperCase() === String(tipoRevision).toUpperCase()
                );

                if (yaExiste) {
                    logBatch(`[${contexto}] FASE 3: Ya existe revisión '${tipoRevision}' para ComID ${idComunicado}`);

                    // NUEVO: Sincronizar líneas de la actualización existente
                    if (doc.lineas && doc.lineas.length > 0) {
                        // Buscar la actualización existente más reciente para sincronizar líneas
                        const actExistente = actsPrevias.sort((a, b) =>
                            Number(b.consecutivo) - Number(a.consecutivo)
                        )[0];

                        if (actExistente && actExistente.id) {
                            logBatch(`[${contexto}] FASE 3: Sincronizando líneas con ActID ${actExistente.id}...`);
                            const syncResult = _syncLineasPresupuesto(actExistente.id, doc.lineas, logBatch);
                            counts.syncUpdated = (counts.syncUpdated || 0) + syncResult.updated;
                            counts.syncInserted = (counts.syncInserted || 0) + syncResult.inserted;
                            counts.syncDeleted = (counts.syncDeleted || 0) + syncResult.deleted;
                        }
                    }
                } else {
                    const consecutivo = actsPrevias.length + actsEnBatch.length + 1;
                    logBatch(`[${contexto}] FASE 3: Creando Actualizacion #${consecutivo} para ComID existente ${idComunicado}`);

                    batchActualizaciones.push({
                        idComunicado: idComunicado,
                        consecutivo: consecutivo,
                        esOrigen: 0, // Ya existe, no puede ser origen
                        revision: tipoRevision,
                        monto: doc.header.totalPdf,
                        montoCapturado: null,
                        montoSupervisión: (doc.header.totalPdf || 0) * 0.05,
                        fecha: new Date(),
                        _docLineas: doc.lineas,
                        _tipoAccion: doc.header.tipoAccion || null,
                        _ubicacionEspecifica: doc.header.ubicacionEspecifica || null
                    });
                }
            });

            SpreadsheetApp.flush();
            logBatch(`[${contexto}] FASE 3 completada. DG actualizados: ${counts.updatedDG}, Líneas sync: ${counts.syncUpdated || 0} upd, ${counts.syncInserted || 0} ins, ${counts.syncDeleted || 0} del`);
        }

        // ==========================================================================================
        // FASE 4: INSERCIÓN BATCH FINAL (DatosGenerales, Actualizaciones, Presupuestos)
        // ==========================================================================================
        logBatch(`[${contexto}] FASE 4: Inserción batch final...`);

        // Insertar DatosGenerales
        if (batchDatosGenerales.length > 0) {
            // PRE-INSERT: Actualizar cada DG con la descripción más reciente de su familia
            // Esto asegura que si L30 y L30A están en el lote, el DG tenga la descripción de L30A
            logBatch(`[${contexto}] PRE-INSERT: Verificando descripciones de ${batchDatosGenerales.length} DGs...`);

            batchDatosGenerales.forEach(dg => {
                // Buscar TODOS los docs que pertenecen a este comunicado
                const docsDeEsteDG = docsParaCrear.filter(d =>
                    String(d._newComId) === String(dg.idComunicado)
                );

                if (docsDeEsteDG.length > 1) {
                    // Hay múltiples versiones (L30, L30A) para este comunicado
                    // Ordenar por versión (descendente) para obtener la última
                    const ultimoDoc = docsDeEsteDG.sort((a, b) => {
                        const vA = _parseVersion(a.header.tipoRegistro || 'ORIGEN');
                        const vB = _parseVersion(b.header.tipoRegistro || 'ORIGEN');
                        return vB.index - vA.index;
                    })[0];

                    if (ultimoDoc && ultimoDoc.header.comunicadoId && ultimoDoc.header.tipoRegistro !== 'ORIGEN') {
                        // Construir historial de versiones
                        let descripcionFinal = dg.descripcion || '';
                        const versionActual = ultimoDoc.header.comunicadoId;

                        if (descripcionFinal && !descripcionFinal.includes(versionActual)) {
                            descripcionFinal = `${descripcionFinal}, ${versionActual}`;
                        } else if (!descripcionFinal) {
                            descripcionFinal = ultimoDoc.header.descripcion || `${ultimoDoc.header.refCta}-${versionActual}`;
                        }

                        logBatch(`[${contexto}] PRE-INSERT: DG para ComID ${dg.idComunicado}: "${dg.descripcion}" -> "${descripcionFinal}"`);
                        dg.descripcion = descripcionFinal;
                    }
                }
            });

            logBatch(`[${contexto}] Insertando ${batchDatosGenerales.length} DatosGenerales...`);
            const resDG = createBatch('datosGenerales', batchDatosGenerales);
            counts.newDG = batchDatosGenerales.length;
            SpreadsheetApp.flush();

            // POST-INSERT: Actualizar descripciones con historial acumulado
            // Esto es necesario porque cuando L30 y L30A están en el mismo lote,
            // la descripción del DG (insertado con el ORIGEN) debe actualizarse con el historial de L30A
            if (resDG && resDG.ids && resDG.ids.length > 0) {
                // Para cada DG insertado, buscar si hay documentos de actualización asociados
                resDG.ids.forEach((dgId, idx) => {
                    const dgInsertado = batchDatosGenerales[idx];
                    if (!dgInsertado) return;

                    // Buscar la última descripción para este idComunicado entre los docs procesados
                    const docsDeEsteCom = docsParaCrear.filter(d =>
                        String(d._newComId) === String(dgInsertado.idComunicado)
                    );

                    // Ordenar por versión (descendente) para obtener la última
                    const ultimoDoc = docsDeEsteCom.sort((a, b) => {
                        const vA = _parseVersion(a.header.tipoRegistro || 'ORIGEN');
                        const vB = _parseVersion(b.header.tipoRegistro || 'ORIGEN');
                        return vB.index - vA.index;
                    })[0];

                    if (ultimoDoc && ultimoDoc.header.comunicadoId && ultimoDoc.header.tipoRegistro !== 'ORIGEN') {
                        // Construir historial de versiones
                        let descripcionFinal = dgInsertado.descripcion || '';
                        const versionActual = ultimoDoc.header.comunicadoId;

                        if (descripcionFinal && !descripcionFinal.includes(versionActual)) {
                            descripcionFinal = `${descripcionFinal}, ${versionActual}`;
                        } else if (!descripcionFinal) {
                            descripcionFinal = ultimoDoc.header.descripcion || `${ultimoDoc.header.refCta}-${versionActual}`;
                        }

                        // La última versión tiene el historial completo, actualizar el DG
                        if (dgInsertado.descripcion !== descripcionFinal) {
                            logBatch(`[${contexto}] POST-INSERT: Actualizando descripción DG ID ${dgId}: "${dgInsertado.descripcion}" -> "${descripcionFinal}"`);
                            try {
                                const resUpd = updateRow('datosGenerales', dgId, { descripcion: descripcionFinal });
                                if (resUpd.success) {
                                    counts.updatedDG = (counts.updatedDG || 0) + 1;
                                }
                            } catch (e) {
                                logBatch(`[${contexto}] POST-INSERT: Error: ${e.message}`);
                            }
                        }
                    }
                });
            }
        }

        // Insertar Actualizaciones
        if (batchActualizaciones.length > 0) {
            logBatch(`[${contexto}] Insertando ${batchActualizaciones.length} Actualizaciones...`);
            resActs = createBatch('actualizaciones', batchActualizaciones);
            counts.newActs = resActs.count;

            // =================================================================
            // SOLUCIÓN "CARRY-FORWARD" EN MEMORIA (In-Memory Merge)
            // =================================================================
            // Mapa para que L50B pueda leer lo que L50A acaba de generar
            // Clave: idComunicado + "_" + consecutivoLocal
            const memoriaLineasBatch = new Map();

            // Preparar PresupuestoLineas
            resActs.ids.forEach((idActReal, i) => {
                const updateObj = batchActualizaciones[i];
                const lineasDelPdf = updateObj._docLineas || []; // Lo que trajo la IA (Delta)

                const esOrigen = updateObj.esOrigen === 1 || updateObj.esOrigen === '1';
                const idComunicado = updateObj.idComunicado;
                const revisionActual = updateObj.revision || updateObj._revision;
                const consecutivoLocal = updateObj.consecutivo; // 1, 2, 3...

                logBatch(`[${contexto}] Procesando líneas para ActID ${idActReal} (${revisionActual}): PDF trajo ${lineasDelPdf.length} líneas.`);

                let lineasFinales = [];

                if (esOrigen) {
                    // Si es ORIGEN, las líneas finales son exactamente las del PDF
                    lineasFinales = lineasDelPdf.map(l => ({
                        concepto: l.concepto,
                        categoria: l.categoria,
                        importe: parseFloat(l.importe) || 0
                    }));
                } else {
                    // Si es ACTUALIZACIÓN, necesitamos FUSIONAR con el predecesor
                    // 1. Buscar líneas del Predecesor (Puede estar en MEMORIA del batch o en BD)
                    let lineasPredecesor = [];

                    // A) Intentar leer del Batch actual (ej: L50B leyendo a L50A)
                    // El predecesor debería tener un consecutivo menor (consecutivoLocal - 1)
                    const clavePredecesorBatch = `${idComunicado}_${consecutivoLocal - 1}`;

                    if (memoriaLineasBatch.has(clavePredecesorBatch)) {
                        logBatch(`[${contexto}] MERGE: Encontrado predecesor en MEMORIA BATCH (Consecutivo ${consecutivoLocal - 1})`);
                        lineasPredecesor = memoriaLineasBatch.get(clavePredecesorBatch);
                    } else {
                        // B) Si no está en memoria, buscar en BD (ej: L50A leyendo a L50 histórico)
                        logBatch(`[${contexto}] MERGE: Buscando predecesor en BD...`);
                        lineasPredecesor = _obtenerLineasPredecesor(cache, idComunicado, revisionActual, logBatch);

                        // Normalizar formato de BD a formato simple
                        lineasPredecesor = lineasPredecesor.map(l => ({
                            concepto: l.descripcion, // Usamos descripcion o concepto
                            categoria: l.categoria,
                            importe: parseFloat(l.importe) || 0
                        }));
                    }

                    // 2. Ejecutar FUSIÓN (Merge Logic)
                    // Normalizar clave para comparación
                    const _key = (c, cat) => `${String(c).toUpperCase().trim()}|${String(cat).toUpperCase().trim()}`;

                    const mapMerge = new Map();

                    // a) Cargar Base (Predecesor)
                    lineasPredecesor.forEach(l => mapMerge.set(_key(l.concepto, l.categoria), l));

                    // b) Aplicar Cambios (PDF Actual)
                    lineasDelPdf.forEach(l => {
                        const key = _key(l.concepto, l.categoria);
                        const importe = parseFloat(l.importe) || 0;

                        // Determinar categoría si viene vacía
                        let catFinal = l.categoria;
                        if (!catFinal) {
                            const desc = String(l.concepto).toUpperCase();
                            catFinal = (desc.includes('DESAZOLVE') || desc.includes('LIMPIEZA')) ? 'DESAZOLVES' : 'DAÑO FISICO';
                        }

                        if (mapMerge.has(key)) {
                            // ACTUALIZAR existente
                            const existente = mapMerge.get(key);
                            if (Math.abs(existente.importe - importe) > 0.01) {
                                existente.importe = importe; // Sobrescribir importe
                            }
                        } else {
                            // INSERTAR nueva
                            mapMerge.set(key, {
                                concepto: l.concepto,
                                categoria: catFinal,
                                importe: importe
                            });
                        }
                    });

                    lineasFinales = Array.from(mapMerge.values());
                    logBatch(`[${contexto}] MERGE RESULTADO: ${lineasPredecesor.length} (Base) + ${lineasDelPdf.length} (PDF) -> ${lineasFinales.length} Líneas Finales.`);
                }

                // 3. GUARDAR EN MEMORIA PARA EL SIGUIENTE (ej: Para que L50C lea esto)
                memoriaLineasBatch.set(`${idComunicado}_${consecutivoLocal}`, lineasFinales);


                // 4. PREPARAR PARA INSERTAR EN BD
                lineasFinales.forEach((l, i) => {
                    // Calculo de Categoría Numérica
                    let catFinalNum = 1;
                    if (l.categoria) {
                        const c = String(l.categoria).toUpperCase();
                        if (c === '2' || c.includes('DESAZOLVE') || c.includes('LIMPIEZA')) catFinalNum = 2;
                    }

                    const descripcionNorm = String(l.concepto || 'Sin concepto').toUpperCase().trim();

                    batchPresupuestos.push({
                        idActualizacion: idActReal,
                        _descripcionTemp: descripcionNorm,
                        categoria: catFinalNum,
                        importe: l.importe,
                        consecutivo: i + 1, // Added consecutivo
                        esVigente: true,
                        fechaCreacion: new Date()
                    });
                });
            });

            SpreadsheetApp.flush();
        }

        // =================================================================
        // PROCESAR DESCRIPCION LINEAS Y OBTENER IDs (POR COMUNICADO)
        // =================================================================
        if (batchPresupuestos.length > 0 && resActs && resActs.ids) {
            logBatch(`[${contexto}] Procesando ${batchPresupuestos.length} líneas de presupuesto...`);

            // Agrupar líneas por idComunicado para buscar en el contexto correcto
            const lineasPorComunicado = new Map();
            batchPresupuestos.forEach((linea, idx) => {
                // Encontrar el idComunicado para esta línea (a través de batchActualizaciones)
                const actIdx = batchActualizaciones.findIndex(a =>
                    String(resActs.ids[batchActualizaciones.indexOf(a)]) === String(linea.idActualizacion) ||
                    resActs.ids.some((id, i) => String(id) === String(linea.idActualizacion))
                );

                // Buscar en batchActualizaciones el que corresponde a esta línea
                let idCom = null;
                for (let i = 0; i < resActs.ids.length; i++) {
                    if (String(resActs.ids[i]) === String(linea.idActualizacion)) {
                        idCom = batchActualizaciones[i].idComunicado;
                        break;
                    }
                }

                if (!idCom) {
                    // Buscar en la BD
                    const actInfo = cache.actualizaciones.find(a => String(a.id) === String(linea.idActualizacion));
                    if (actInfo) idCom = actInfo.idComunicado;
                }

                if (!lineasPorComunicado.has(String(idCom))) {
                    lineasPorComunicado.set(String(idCom), []);
                }
                lineasPorComunicado.get(String(idCom)).push({ linea, idx });
            });

            // Para cada comunicado, buscar líneas existentes y hacer matching
            const todasLineasBD = readAllRows('presupuestoLineas').data || [];

            lineasPorComunicado.forEach((lineasDelCom, idComunicado) => {
                logBatch(`[${contexto}] Procesando líneas para comunicado ${idComunicado}: ${lineasDelCom.length} líneas`);

                // Obtener todos los idActualizacion de este comunicado (de BD + batch actual)
                const actualizacionesDelCom = cache.actualizaciones
                    .filter(a => String(a.idComunicado) === String(idComunicado))
                    .map(a => String(a.id));

                // También agregar las actualizaciones del batch actual
                batchActualizaciones.forEach((act, i) => {
                    if (String(act.idComunicado) === String(idComunicado) && resActs.ids[i]) {
                        if (!actualizacionesDelCom.includes(String(resActs.ids[i]))) {
                            actualizacionesDelCom.push(String(resActs.ids[i]));
                        }
                    }
                });

                // Obtener todas las líneas de presupuesto de este comunicado (de la BD)
                const lineasExistentes = todasLineasBD.filter(l =>
                    actualizacionesDelCom.includes(String(l.idActualizacion))
                );

                // Construir mapa de idLinea → descripción para este comunicado
                const lineasUsadasEnCom = new Map(); // idLinea → info de descripción
                lineasExistentes.forEach(l => {
                    if (l.idLinea && !lineasUsadasEnCom.has(String(l.idLinea))) {
                        const descInfo = cache.descripcionLineas.find(dl => String(dl.id) === String(l.idLinea));
                        if (descInfo) {
                            lineasUsadasEnCom.set(String(l.idLinea), {
                                id: descInfo.id,
                                descripcion: descInfo.descripcion,
                                categoria: descInfo.categoria,
                                descripcionNorm: _normalizarUbicacion(descInfo.descripcion)
                            });
                        }
                    }
                });

                logBatch(`[${contexto}] Comunicado ${idComunicado}: ${lineasUsadasEnCom.size} líneas únicas existentes`);

                // Para cada línea del PDF, buscar match por similitud en las líneas del comunicado
                lineasDelCom.forEach(({ linea, idx }) => {
                    const descripcionNorm = _normalizarUbicacion(linea._descripcionTemp);
                    const catLinea = linea.categoria;
                    let idLineaEncontrado = null;

                    // Buscar match por similitud en las líneas existentes del comunicado
                    lineasUsadasEnCom.forEach((info, idLinea) => {
                        if (idLineaEncontrado) return; // Ya encontramos match

                        // Comparar por categoría Y similitud de descripción
                        // STRICT CHECK: Si las categorías son diferentes, NO ES LA MISMA LÍNEA.
                        // Esto previene que una línea de "Desazolve" herede el historial de "Daño Físico"
                        const catMatch = (info.categoria == catLinea) ||
                            (_categoriaTxtANum(info.categoria) === catLinea);

                        if (catMatch) {
                            const descMatch = info.descripcionNorm === descripcionNorm ||
                                _matchUbicaciones(info.descripcionNorm, descripcionNorm);

                            if (descMatch) {
                                idLineaEncontrado = parseInt(idLinea);
                                logBatch(`[${contexto}] MATCH: "${linea._descripcionTemp}" ↔ "${info.descripcion}" (idLinea=${idLinea})`);
                            }
                        }
                    });

                    if (idLineaEncontrado) {
                        // Usar el idLinea existente
                        batchPresupuestos[idx].idLinea = idLineaEncontrado;
                    } else {
                        // Crear nueva descripción - marcar para creación
                        batchPresupuestos[idx]._needsNewDescripcion = true;
                        logBatch(`[${contexto}] NUEVA DESCRIPCIÓN: "${linea._descripcionTemp}" [cat=${catLinea}]`);
                    }
                });
            });

            // Crear las nuevas entradas en DescripcionLineas para líneas que lo necesitan
            const descripcionesNuevas = new Map();
            batchPresupuestos.forEach((linea, idx) => {
                if (linea._needsNewDescripcion) {
                    const key = `${linea._descripcionTemp}|${linea.categoria}`;
                    if (!descripcionesNuevas.has(key)) {
                        descripcionesNuevas.set(key, {
                            descripcion: linea._descripcionTemp,
                            categoria: linea.categoria,
                            indices: [idx]
                        });
                    } else {
                        descripcionesNuevas.get(key).indices.push(idx);
                    }
                }
            });

            if (descripcionesNuevas.size > 0) {
                const batchDescripciones = Array.from(descripcionesNuevas.values())
                    .map(d => ({ descripcion: d.descripcion, categoria: d.categoria }));

                logBatch(`[${contexto}] Creando ${batchDescripciones.length} nuevas entradas en DescripcionLineas...`);

                const resDesc = createBatch('descripcionLineas', batchDescripciones);

                // Asignar los nuevos IDs a las líneas correspondientes
                if (resDesc.ids && resDesc.ids.length > 0) {
                    const keysArray = Array.from(descripcionesNuevas.keys());
                    keysArray.forEach((key, i) => {
                        const newId = resDesc.ids[i];
                        const info = descripcionesNuevas.get(key);

                        // Actualizar todas las líneas que necesitan este idLinea
                        info.indices.forEach(idx => {
                            batchPresupuestos[idx].idLinea = newId;
                        });

                        // Actualizar cache
                        cache.descripcionLineas.push({
                            id: newId,
                            descripcion: info.descripcion,
                            categoria: info.categoria
                        });
                    });
                }

                SpreadsheetApp.flush();
            }

            // Limpiar campos temporales
            batchPresupuestos.forEach(linea => {
                delete linea._descripcionTemp;
                delete linea._needsNewDescripcion;
            });
        }

        // =========================================================================
        // FILTRO DELTA: Solo insertar líneas que cambiaron respecto a la versión anterior
        // =========================================================================
        let linesToInsert = batchPresupuestos;

        if (batchPresupuestos.length > 0 && batchActualizaciones.length > 0) {
            logBatch(`[${contexto}] Aplicando filtro DELTA a ${batchPresupuestos.length} líneas...`);

            // 1. Agrupar líneas por actualización
            const linesByAct = new Map();
            batchPresupuestos.forEach(l => {
                const aid = String(l.idActualizacion);
                if (!linesByAct.has(aid)) linesByAct.set(aid, []);
                linesByAct.get(aid).push(l);
            });

            // 2. Ordenar actualizaciones por jerarquía (Origen -> A -> B) para procesar en orden
            // Asumimos que batchActualizaciones ya viene con 'consecutivo' y 'descripcion'
            // Necesitamos procesar por COMUNICADO y luego por SECUENCIA

            // Mapa de estados virtuales: idComunicado -> Map<idLinea, {importe, categoria}>
            const virtualState = new Map();

            // Ordenar batchActualizaciones globalmente por comunicado y consecutivo
            const sortedActs = [...batchActualizaciones].sort((a, b) => {
                if (String(a.idComunicado) !== String(b.idComunicado)) {
                    return String(a.idComunicado).localeCompare(String(b.idComunicado));
                }
                return Number(a.consecutivo) - Number(b.consecutivo);
            });

            const filteredLines = [];

            // 3. Procesar cada actualización en orden
            for (const act of sortedActs) {
                const actId = String(act.id);
                const comId = String(act.idComunicado);
                const comLines = linesByAct.get(actId) || [];

                if (comLines.length === 0) continue;

                // 3.1 Cargar estado previo
                let stateMap = virtualState.get(comId);

                if (!stateMap) {
                    // Si es la primera vez que tocamos este comunicado en el batch,
                    // intentamos cargar su estado "BASE" desde la DB (la última versión COMMITTEADA).
                    // Si act.consecutivo == 1 (Origen), la base es vacía.
                    stateMap = new Map(); // idLinea -> Float

                    if (Number(act.consecutivo) > 1) {
                        // Cargar estado de la DB (versión anterior inmediata real)
                        // Nota: calcularEstadoVersion devuelve el estado acumulado.
                        // Debemos pedir estado hasta update anterior.
                        // Complicación: No tenemos el ID del update anterior fácilmente aqui si no está en batch.
                        // Aproximación: Usar calcularEstadoVersion(comId) que trae "hasta lo último de DB".
                        // Esto asume que lo del batch sigue a lo de la DB.
                        try {
                            const dbState = calcularEstadoVersion(comId);
                            if (dbState && dbState.lineas) {
                                dbState.lineas.forEach(l => {
                                    stateMap.set(String(l.idLinea), parseFloat(l.importe));
                                });
                            }
                        } catch (e) { console.warn("Error cargando estado base DB", e); }
                    }
                    virtualState.set(comId, stateMap);
                }

                // 3.2 Filtrar líneas de esta actualización
                comLines.forEach(linea => {
                    const lid = String(linea.idLinea);
                    const importeNuevo = parseFloat(linea.importe) || 0;
                    const importePrevio = stateMap.get(lid);

                    let esCambio = false;

                    if (importePrevio === undefined) {
                        // Nueva línea
                        esCambio = true;
                    } else {
                        // Línea existente, verificar si cambió importe (tolerancia)
                        if (Math.abs(importeNuevo - importePrevio) > 0.01) {
                            esCambio = true;
                        }
                    }

                    if (esCambio) {
                        filteredLines.push(linea);
                        // Actualizar estado virtual
                        stateMap.set(lid, importeNuevo);
                    }
                });
            }

            // Reemplazar líneas a insertar con las filtradas
            logBatch(`[${contexto}] Filtro DELTA completado: ${batchPresupuestos.length} -> ${filteredLines.length} líneas.`);
            linesToInsert = filteredLines;
        }


        // Insertar PresupuestoLineas
        if (linesToInsert.length > 0) {
            logBatch(`[${contexto}]Insertando ${linesToInsert.length} líneas de presupuesto (Delta)...`);
            const resLines = createBatch('presupuestoLineas', linesToInsert);
            counts.newLines = resLines.count;
            SpreadsheetApp.flush();

            // =========================================================
            // RECALCULAR MONTO TOTAL usando MODELO DELTA
            // =========================================================
            // El monto se calcula como la suma del estado completo materializado,
            // NO solo las líneas del PDF actual.
            // =========================================================

            // Obtener IDs únicos de actualizaciones procesadas
            const idsActualizacionesUnicas = [...new Set(batchPresupuestos.map(l => String(l.idActualizacion)))];

            // Para cada actualización, necesitamos su idComunicado
            const actualizacionesInfo = (readAllRows('actualizaciones').data || [])
                .filter(a => idsActualizacionesUnicas.includes(String(a.id)));

            let countMontoUpdated = 0;
            actualizacionesInfo.forEach(act => {
                try {
                    // Calcular estado completo para este comunicado hasta esta versión
                    const estado = calcularEstadoVersion(act.idComunicado, act.id);
                    const montoRedondeado = estado.total;
                    const montoSupervision = Math.round(montoRedondeado * 0.05 * 100) / 100;

                    logBatch(`[${contexto}] DELTA MONTO ActID ${act.id}: ${estado.lineas.length} líneas totalizadas = $${montoRedondeado} (Supervisión: $${montoSupervision})`);

                    const resUpd = updateRow('actualizaciones', act.id, {
                        monto: montoRedondeado,
                        montoSupervisión: montoSupervision
                    });

                    if (resUpd.success) {
                        countMontoUpdated++;
                    } else {
                        logBatch(`[${contexto}] ERROR actualizando monto: ${resUpd.message}`);
                    }
                } catch (e) {
                    logBatch(`[${contexto}] ERROR recalculando monto ActID ${act.id}: ${e.message}`);
                }
            });

            logBatch(`[${contexto}] MONTOS DELTA RECALCULADOS: ${countMontoUpdated} actualizaciones`);
            counts.montoRecalculados = countMontoUpdated;
            SpreadsheetApp.flush();
        }

        // FIN DEL PROCESO
        logBatch(`[${contexto}]Batch Completado.Resumen: ${JSON.stringify(counts)}`);

        // Generar CSV Errores
        let csvErrorContent = null;
        if (omitidos.length > 0) {
            csvErrorContent = _generarCsvErrores(omitidos);
        }

        return _buildResponse(true, 'Importación Batch Completada.', counts, omitidos, loteAgrupado, csvErrorContent, debugLogs);

    } catch (error) {
        console.error(`Error en ${contexto}: `, error);
        return { success: false, message: `Error fatal: ${error.message}` };
    }
}

// ============================================================================
// HELPERS DE BATCH & CACHE
// ============================================================================

function _loadCatalogsCache() {
    // Cargar todas las tablas necesarias en memoria
    // Para datasets gigantes, esto podria optimizarse con filtros, pero para <10k filas funciona bien.
    return {
        aseguradoras: readAllRows('aseguradoras').data || [],
        siniestros: readAllRows('siniestros').data || [],
        cuentas: readAllRows('cuentas').data || [],
        comunicados: readAllRows('comunicados').data || [],
        datosGenerales: readAllRows('datosGenerales').data || [],
        estados: readAllRows('estados').data || [],
        ajustadores: readAllRows('ajustadores').data || [],
        distritosRiego: readAllRows('distritosRiego').data || [], // Cargar Distritos
        actualizaciones: readAllRows('actualizaciones').data || [],
        descripcionLineas: readAllRows('descripcionLineas').data || []
    };
}

function _updateCache(cache, tableKey, newIds, originalKeys, keyField) {
    // Actualiza el cache local con los nuevos registros insertados
    // originalKeys es array de strings (nombres) o array de keys si es compuesto
    newIds.forEach((id, i) => {
        const item = { id: id };
        const val = originalKeys[i];

        if (typeof val === 'object' && val !== null) {
            // Si el valor es un objeto completo (ej. Cuentas), lo mezclamos
            Object.assign(item, val);
        } else {
            // Si es un valor simple
            if (Array.isArray(keyField)) {
                keyField.forEach(k => item[k] = val);
            } else {
                item[keyField] = val;
            }
        }

        cache[tableKey].push(item);
    });
}




function _extractUnique(docs, docField, existingList, dbField) {
    const unique = new Set();
    docs.forEach(d => {
        // Soportar tanto strings (d.header[docField]) como funciones (docField(d))
        let val;
        if (typeof docField === 'function') {
            val = docField(d);
        } else {
            val = d.header[docField];
        }
        if (!val || String(val).trim() === '') return;

        // Normalizar a mayúsculas
        const normalizedVal = String(val).toUpperCase().trim();

        // Check if exists in DB (buscar en múltiples campos si dbField es array)
        const exists = existingList.some(item => {
            if (Array.isArray(dbField)) {
                return dbField.some(f => String(item[f] || '').toUpperCase().trim() === normalizedVal);
            }
            return String(item[dbField] || '').toUpperCase().trim() === normalizedVal;
        });
        if (!exists) unique.add(normalizedVal);
    });
    return Array.from(unique);
}

/**
 * NUEVO: Extrae distritos que deben actualizarse en el catálogo.
 * Cuando la IA devuelve distritoRiegoAccion = "Actualiza", significa que el nombre
 * extraído del PDF es más completo que el existente en el catálogo.
 * 
 * Ejemplo: Catálogo tiene "DTT 018 Huixtla" pero PDF tiene 
 * "Distrito de Temporal Tecnificado 018 (DTT 018) Huixtla" -> Actualizar
 * 
 * @param {Array} docs - Documentos a procesar
 * @param {Array} existingDistritos - Lista actual de distritos del catálogo
 * @returns {Array} Lista de objetos {id, nombreAnterior, nuevoNombre} para actualizar
 */
function _extractDistritosToUpdate(docs, existingDistritos) {
    const updates = [];
    const procesados = new Set(); // Evitar duplicados

    docs.forEach(d => {
        const h = d.header;

        // Solo procesar si la IA indicó "Actualiza"
        if (!h.distritoRiegoAccion || h.distritoRiegoAccion.toUpperCase() !== 'ACTUALIZA') {
            return;
        }

        const nuevoNombre = String(h.distritoRiego || '').trim();
        if (!nuevoNombre || nuevoNombre === '' || nuevoNombre.toUpperCase() === 'SIN DATO') {
            return;
        }

        // Evitar procesar el mismo distrito múltiples veces
        if (procesados.has(nuevoNombre.toUpperCase())) {
            return;
        }
        procesados.add(nuevoNombre.toUpperCase());

        // Buscar distrito existente que coincida parcialmente
        // Usamos lógica de matching flexible: siglas, números, nombres parciales
        const distritoExistente = _findMatchingDistrito(nuevoNombre, existingDistritos);

        if (distritoExistente) {
            const nombreAnterior = String(distritoExistente.distritoRiego || '').trim();

            // Solo actualizar si el nuevo nombre es más largo (más completo)
            if (nuevoNombre.length > nombreAnterior.length && nuevoNombre.toUpperCase() !== nombreAnterior.toUpperCase()) {
                updates.push({
                    id: distritoExistente.id,
                    nombreAnterior: nombreAnterior,
                    nuevoNombre: nuevoNombre.toUpperCase()
                });
            }
        }
    });

    return updates;
}

/**
 * NUEVO: Busca un distrito existente que coincida con el nuevo nombre.
 * Usa matching flexible basado en:
 * - Siglas (DTT, DR)
 * - Números de distrito (018, 011)
 * - Nombre del lugar (Huixtla, Margaritas)
 * 
 * @param {string} nuevoNombre - Nombre más completo del PDF
 * @param {Array} existingDistritos - Lista de distritos existentes
 * @returns {Object|null} Distrito encontrado o null
 */
function _findMatchingDistrito(nuevoNombre, existingDistritos) {
    if (!nuevoNombre || !existingDistritos || existingDistritos.length === 0) {
        return null;
    }

    const nuevoUpper = nuevoNombre.toUpperCase();

    // Extraer números del nuevo nombre (ej: "018" de "DTT 018 Huixtla")
    const numerosNuevo = nuevoUpper.match(/\d+/g) || [];

    // Extraer palabras significativas (ignorar artículos y preposiciones)
    const palabrasIgnorar = ['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'EN', 'A', 'DISTRITO', 'TEMPORAL', 'TECNIFICADO', 'RIEGO'];
    const palabrasNuevo = nuevoUpper.split(/[\s,()-]+/)
        .filter(p => p.length > 2 && !palabrasIgnorar.includes(p) && !/^\d+$/.test(p));

    for (const distrito of existingDistritos) {
        const existenteUpper = String(distrito.distritoRiego || '').toUpperCase();

        // Si es exactamente igual, no necesita actualización (pero debemos encontrarlo)
        if (existenteUpper === nuevoUpper) {
            return distrito;
        }

        // Extraer números del existente
        const numerosExistente = existenteUpper.match(/\d+/g) || [];

        // Si comparten al menos un número de distrito, es candidato
        const compartenNumero = numerosNuevo.some(n => numerosExistente.includes(n));

        if (compartenNumero) {
            // Verificar que comparte al menos una palabra significativa (nombre del lugar)
            const palabrasExistente = existenteUpper.split(/[\s,()-]+/)
                .filter(p => p.length > 2 && !palabrasIgnorar.includes(p) && !/^\d+$/.test(p));

            const compartenPalabra = palabrasNuevo.some(p =>
                palabrasExistente.some(pe => pe.includes(p) || p.includes(pe))
            );

            // Si comparten número Y palabra, es un match
            if (compartenPalabra || numerosNuevo.length > 0) {
                return distrito;
            }
        }

        // Fallback: Si el nuevo contiene al existente o viceversa
        if (nuevoUpper.includes(existenteUpper) || existenteUpper.includes(nuevoUpper)) {
            return distrito;
        }
    }

    return null;
}

function _prepareSiniestrosBatch(validos, cache) {
    const inserts = [];
    const keys = []; // Para update cache
    const seen = new Set();

    // Primero, indexar existentes para búsqueda rápida
    const existMap = new Set(cache.siniestros.map(s => String(s.siniestro || '').toUpperCase()));

    validos.forEach(d => {
        const h = d.header;
        if (!h.refSiniestro) return;
        const key = String(h.refSiniestro).toUpperCase();

        if (!existMap.has(key) && !seen.has(key)) {
            // Buscar ID Aseguradora (buscar en múltiples campos)
            const asegName = h.aseguradoraNombre || h.aseguradora;
            const idAseg = _resolveIdFromCache(cache.aseguradoras, asegName, ['aseguradora', 'nombre', 'descripción']);

            const newSin = {
                siniestro: String(h.refSiniestro || '').toUpperCase().trim(),
                fenomeno: String(h.fenomeno || 'SIN DATO').toUpperCase().trim(),
                fi: String(h.fi || h.fechaSiniestroFi || 'SIN DATO').toUpperCase().trim(),
                fondo: String(h.fondo || 'SIN DATO').toUpperCase().trim(),
                idAseguradora: idAseg
            };
            inserts.push(newSin);
            keys.push(newSin);
            seen.add(key);
        }
    });
    return { inserts, keys };
}

function _prepareCuentasBatch(validos, cache, idAjustadorDefault) {
    const inserts = [];
    const keys = [];
    const seen = new Set();

    // Indexar existentes. Cuentas busca por referencia O cuenta
    // Simplificación: Asumimos refCta es la clave
    const existMap = new Set(cache.cuentas.map(c => String(c.referencia || '').toUpperCase()));

    validos.forEach(d => {
        const ref = d.header.refCta;
        if (!ref) return;
        const key = String(ref).toUpperCase();

        if (!existMap.has(key) && !seen.has(key)) {
            // Resolver Ajustador especifico de esta fila (buscar por ajustadorNombre o ajustador)
            const ajustadorName = d.header.ajustadorNombre || d.header.ajustador;
            let idAj = _resolveIdFromCache(cache.ajustadores, ajustadorName, ['nombreAjustador', 'nombre']);
            if (!idAj) idAj = idAjustadorDefault;

            const newCta = {
                referencia: ref,
                cuenta: ref, // Duplicamos valor por diseño original
                idAjustador: idAj,
                fechaAlta: new Date()
            };
            inserts.push(newCta);
            keys.push(newCta);
            seen.add(key);
        }
    });
    return { inserts, keys };
}

function _resolveIdFromCache(list, value, fieldName) {
    if (!value) return null;
    const clean = String(value).toUpperCase().trim();
    // Arrays handles compuesto ? No, simple
    // Si fieldName es array, checkeamos cualquiera
    const found = list.find(item => {
        if (Array.isArray(fieldName)) {
            return fieldName.some(f => String(item[f] || '').toUpperCase().trim() === clean);
        }
        return String(item[fieldName] || '').toUpperCase().trim() === clean;
    });
    return found ? found.id : null;
}

function _findIdAjustadorDefault(ajustadores) {
    const ct = ajustadores.find(a => String(a.nombre || a.nombreAjustador).toUpperCase().includes('CHARLES'));
    return ct ? ct.id : null;
}

// ============================================================================
// CATEGORÍAS: 1 = Daño Físico, 2 = Desazolves
// ============================================================================

/**
 * Convierte texto de categoría a número.
 * @param {string} catText - Texto de categoría (ej: "DAÑO FISICO", "DESAZOLVES")
 * @returns {number} 1 = Daño Físico, 2 = Desazolves
 */
function _categoriaTxtANum(catText) {
    if (!catText) return 1; // Default: Daño Físico
    const cat = String(catText).toUpperCase().trim();
    if (cat.includes('DESAZOLVE') || cat.includes('LIMPIEZA') || cat.includes('REMOCION') || cat.includes('EXTRACCI')) {
        return 2; // Desazolves
    }
    return 1; // Daño Físico (incluyendo DAÑO, SUPERVISION, etc.)
}

/**
 * Convierte número de categoría a texto.
 * @param {number} catNum - Número de categoría (1 o 2)
 * @returns {string} "DAÑO FISICO" o "DESAZOLVES"
 */
function _categoriaNumATxt(catNum) {
    return catNum === 2 ? 'DESAZOLVES' : 'DAÑO FISICO';
}

/**
 * Determina la categoría numérica desde la descripción del concepto.
 * @param {string} concepto - Texto del concepto/ubicación
 * @returns {number} 1 = Daño Físico, 2 = Desazolves
 */
function _categoriaDesdeConcepto(concepto) {
    if (!concepto) return 1;
    const desc = String(concepto).toUpperCase();
    if (desc.includes('DESAZOLVE') || desc.includes('LIMPIEZA') || desc.includes('EXTRACCI')) {
        return 2;
    }
    return 1;
}

// ============================================================================
// MODELO DELTA: Calcular Estado Completo de una Versión
// ============================================================================

/**
 * Calcula el estado completo de un comunicado hasta una versión específica.
 * En el modelo delta, cada versión solo guarda los cambios.
 * Esta función "materializa" el estado sumando todos los deltas.
 * 
 * @param {number} idComunicado - ID del comunicado
 * @param {number|null} hastaIdActualizacion - ID de la actualización hasta la cual calcular (null = más reciente)
 * @returns {Object} { lineas: [{idLinea, descripcion, categoria, importe}], total: number }
 */
function calcularEstadoVersion(idComunicado, hastaIdActualizacion = null) {
    // 1. Obtener todas las actualizaciones del comunicado, ordenadas por versión
    const actualizaciones = (readAllRows('actualizaciones').data || [])
        .filter(a => String(a.idComunicado) === String(idComunicado))
        .sort((a, b) => {
            const vA = _parseVersion(a.revision || 'ORIGEN');
            const vB = _parseVersion(b.revision || 'ORIGEN');
            return vA.index - vB.index;
        });

    if (actualizaciones.length === 0) {
        return { lineas: [], total: 0 };
    }

    // 2. Determinar hasta cuál actualización calcular
    let indexHasta = actualizaciones.length - 1;
    if (hastaIdActualizacion) {
        const idx = actualizaciones.findIndex(a => String(a.id) === String(hastaIdActualizacion));
        if (idx >= 0) indexHasta = idx;
    }

    // 3. Obtener IDs de actualizaciones hasta la versión objetivo
    const idsActualizaciones = actualizaciones.slice(0, indexHasta + 1).map(a => String(a.id));

    // 4. Cargar todas las líneas de presupuesto de esas actualizaciones
    const todasLineas = (readAllRows('presupuestoLineas').data || [])
        .filter(l => idsActualizaciones.includes(String(l.idActualizacion)));

    // 5. Cargar catálogo de descripciones
    const descripciones = readAllRows('descripcionLineas').data || [];
    const mapaDesc = new Map();
    descripciones.forEach(d => mapaDesc.set(String(d.id), d));

    // 6. Para cada idLinea, obtener el valor más reciente
    // Ordenar líneas por actualización (antiguo a nuevo) para que el más reciente sobreescriba
    const estadoFinal = new Map();

    todasLineas
        .sort((a, b) => {
            const idxA = idsActualizaciones.indexOf(String(a.idActualizacion));
            const idxB = idsActualizaciones.indexOf(String(b.idActualizacion));
            return idxA - idxB;
        })
        .forEach(linea => {
            const idLinea = String(linea.idLinea);
            const descInfo = mapaDesc.get(idLinea) || { descripcion: 'Sin descripción', categoria: 1 };

            estadoFinal.set(idLinea, {
                idLinea: linea.idLinea,
                descripcion: descInfo.descripcion,
                categoria: linea.categoria || descInfo.categoria,
                importe: parseFloat(linea.importe) || 0,
                consecutivo: linea.consecutivo
            });
        });

    // 7. Calcular total y retornar
    const lineasArray = Array.from(estadoFinal.values());
    const total = lineasArray.reduce((sum, l) => sum + l.importe, 0);

    return {
        lineas: lineasArray,
        total: Math.round(total * 100) / 100
    };
}

/**
 * Compara el estado de dos versiones para mostrar en historial.
 * @param {number} idComunicado - ID del comunicado
 * @param {number} idActAnterior - ID de la actualización anterior
 * @param {number} idActActual - ID de la actualización actual
 * @returns {Object} { antes: [{...}], despues: [{...}], cambios: [...] }
 */
function compararVersiones(idComunicado, idActAnterior, idActActual) {
    const estadoAntes = calcularEstadoVersion(idComunicado, idActAnterior);
    const estadoDespues = calcularEstadoVersion(idComunicado, idActActual);

    // Crear mapa de cambios
    const cambios = [];
    const lineasAntes = new Map(estadoAntes.lineas.map(l => [String(l.idLinea), l]));
    const lineasDespues = new Map(estadoDespues.lineas.map(l => [String(l.idLinea), l]));

    // Comparar líneas
    lineasDespues.forEach((lineaDespues, idLinea) => {
        const lineaAntes = lineasAntes.get(idLinea);
        if (!lineaAntes) {
            cambios.push({ tipo: 'NUEVA', linea: lineaDespues });
        } else if (lineaAntes.importe !== lineaDespues.importe) {
            cambios.push({
                tipo: 'MODIFICADA',
                linea: lineaDespues,
                importeAnterior: lineaAntes.importe
            });
        }
    });

    return {
        antes: estadoAntes,
        despues: estadoDespues,
        cambios
    };
}


/**
 * Compara líneas del PDF con líneas existentes en BD.
 * Usa clave compuesta: UBICACION + CATEGORIA
 * @param {Array} lineasPdf - Líneas del PDF [{concepto, categoria, importe}]
 * @param {Array} lineasBd - Líneas de BD [{descripcion, categoria, importe}]
 * @returns {Object} {hasDifferences, inserts, updates, deletes}
 */
function _compararLineas(lineasPdf, lineasBd) {
    const result = { hasDifferences: false, inserts: 0, updates: 0, deletes: 0 };

    if (!lineasPdf) lineasPdf = [];
    if (!lineasBd) lineasBd = [];

    console.log(`[_compararLineas] PDF tiene ${lineasPdf.length} líneas, BD tiene ${lineasBd.length} líneas`);

    // Normalizar clave
    const _normKey = (concepto, categoria) => {
        const ubicNorm = _normalizarUbicacion(concepto);
        const catNorm = String(categoria || 'DAÑO FISICO').toUpperCase().trim()
            .replace('DESAZOLVE', 'DESAZOLVES');
        return `${ubicNorm} | ${catNorm}`;
    };

    // Mapear líneas PDF
    const mapPdf = new Map();
    lineasPdf.forEach((l, i) => {
        const key = _normKey(l.concepto, l.categoria);
        console.log(`[_compararLineas] PDF[${i}]: concepto = "${l.concepto?.substring(0, 30)}..." cat = "${l.categoria}" -> key="${key.substring(0, 50)}..."`);
        mapPdf.set(key, l);
    });

    // Mapear líneas BD
    const mapBd = new Map();
    lineasBd.forEach((l, i) => {
        const key = _normKey(l.descripcion, l.categoria);
        console.log(`[_compararLineas] BD[${i}]: desc = "${l.descripcion?.substring(0, 30)}..." cat = "${l.categoria}" -> key="${key.substring(0, 50)}..."`);
        mapBd.set(key, l);
    });

    // Contar diferencias
    for (const [key, lineaPdf] of mapPdf) {
        const lineaBd = mapBd.get(key);

        if (lineaBd) {
            // Existe - verificar si cambió el importe
            const importePdf = parseFloat(lineaPdf.importe) || 0;
            const importeBd = parseFloat(lineaBd.importe) || 0;

            if (Math.abs(importePdf - importeBd) > 0.01) {
                console.log(`[_compararLineas] DIFF IMPORTE: PDF = ${importePdf} vs BD = ${importeBd}`);
                result.updates++;
                result.hasDifferences = true;
            }
            mapBd.delete(key);
        } else {
            // Nueva línea
            console.log(`[_compararLineas] NUEVA LÍNEA: "${key.substring(0, 50)}..."`);
            result.inserts++;
            result.hasDifferences = true;
        }
    }

    // Líneas que ya no existen
    result.deletes = mapBd.size;
    if (result.deletes > 0) {
        console.log(`[_compararLineas] LÍNEAS A ELIMINAR: ${result.deletes}`);
        result.hasDifferences = true;
    }

    console.log(`[_compararLineas] Resultado: inserts = ${result.inserts}, updates = ${result.updates}, deletes = ${result.deletes}, hasDiff = ${result.hasDifferences}`);
    return result;
}

/**
 * Sincroniza líneas de presupuesto de una actualización existente.
 * Compara por clave compuesta: UBICACION + CATEGORIA
 * @param {number} idActualizacion - ID de la actualización existente
 * @param {Array} lineasNuevas - Líneas extraídas del PDF [{concepto, categoria, importe}]
 * @param {Function} logFn - Función de log
 * @returns {Object} Resumen de operaciones {updated, inserted, deleted}
 */
function _syncLineasPresupuesto(idActualizacion, lineasNuevas, logFn) {
    const contexto = '_syncLineasPresupuesto';
    const result = { updated: 0, inserted: 0, deleted: 0 };

    if (!idActualizacion || !lineasNuevas || lineasNuevas.length === 0) {
        logFn(`[${contexto}]Sin líneas para sincronizar`);
        return result;
    }

    logFn(`[${contexto}]Sincronizando ${lineasNuevas.length} líneas para ActID ${idActualizacion}`);

    // 1. Cargar líneas existentes de la BD
    const lineasBDResponse = readAllRows('presupuestoLineas');
    if (!lineasBDResponse.success) {
        logFn(`[${contexto}]ERROR: No se pudieron leer líneas existentes`);
        return result;
    }

    const lineasExistentes = (lineasBDResponse.data || []).filter(l =>
        String(l.idActualizacion) === String(idActualizacion)
    );

    logFn(`[${contexto}]Líneas existentes en BD: ${lineasExistentes.length}`);

    // 2. Normalizar líneas del PDF para comparación
    const _normKey = (concepto, categoria) => {
        const ubicNorm = _normalizarUbicacion(concepto);
        const catNorm = String(categoria || 'DAÑO FISICO').toUpperCase().trim()
            .replace('FISICO', 'FISICO')
            .replace('DESAZOLVE', 'DESAZOLVES');
        return `${ubicNorm} | ${catNorm}`;
    };

    const mapNuevas = new Map();
    lineasNuevas.forEach(ln => {
        const key = _normKey(ln.concepto, ln.categoria);
        mapNuevas.set(key, ln);
    });

    const mapExistentes = new Map();
    lineasExistentes.forEach(le => {
        const key = _normKey(le.descripcion, le.categoria);
        mapExistentes.set(key, le);
    });

    logFn(`[${contexto}]Claves nuevas: ${[...mapNuevas.keys()].join(', ')}`);
    logFn(`[${contexto}]Claves existentes: ${[...mapExistentes.keys()].join(', ')}`);

    // 3. ACTUALIZAR líneas existentes que cambiaron
    for (const [key, lineaNueva] of mapNuevas) {
        const lineaExistente = mapExistentes.get(key);

        if (lineaExistente) {
            // Existe - verificar si cambió el importe
            const importeNuevo = parseFloat(lineaNueva.importe) || 0;
            const importeExistente = parseFloat(lineaExistente.importe) || 0;

            if (Math.abs(importeNuevo - importeExistente) > 0.01) {
                logFn(`[${contexto}]ACTUALIZAR: "${lineaExistente.descripcion}"[${lineaExistente.categoria}]$${importeExistente} -> $${importeNuevo}`);
                try {
                    const resUpd = updateRow('presupuestoLineas', lineaExistente.id, { importe: importeNuevo });
                    if (resUpd.success) result.updated++;
                } catch (e) {
                    logFn(`[${contexto}]ERROR actualizando: ${e.message}`);
                }
            }
            // Marcar como procesada
            mapExistentes.delete(key);
        } else {
            // No existe - INSERTAR
            logFn(`[${contexto}]INSERTAR: "${lineaNueva.concepto}"[${lineaNueva.categoria}]$${lineaNueva.importe}`);
            try {
                const catFinal = String(lineaNueva.categoria || 'DAÑO FISICO').toUpperCase();
                const resIns = createRow('presupuestoLineas', {
                    idActualizacion: idActualizacion,
                    descripcion: String(lineaNueva.concepto || 'Sin concepto').toUpperCase().trim(),
                    categoria: catFinal,
                    importe: parseFloat(lineaNueva.importe) || 0,
                    fechaCreacion: new Date()
                });
                if (resIns.success) result.inserted++;
            } catch (e) {
                logFn(`[${contexto}]ERROR insertando: ${e.message}`);
            }
        }
    }

    // 4. CARRY-FORWARD: Las líneas que ya no existen en el PDF SE MANTIENEN SIN CAMBIOS
    // NO SE ELIMINAN - solo se registra para trazabilidad
    if (mapExistentes.size > 0) {
        logFn(`[${contexto}]CARRY - FORWARD: ${mapExistentes.size} líneas se mantienen sin cambios(no están en el PDF nuevo)`);
        for (const [key, lineaMantenida] of mapExistentes) {
            logFn(`[${contexto}]MANTENER: "${lineaMantenida.descripcion}"[${lineaMantenida.categoria}]$${lineaMantenida.importe}`);
        }
    }

    logFn(`[${contexto}]Sincronización completada: ${result.updated} actualizadas, ${result.inserted} insertadas, ${mapExistentes.size} mantenidas`);
    return result;
}

/**
 * Normaliza una ubicación para comparación fuzzy.
 * Elimina palabras comunes, acentos, deja solo palabras clave.
 */
function _normalizarUbicacion(ubicacion) {
    if (!ubicacion) return '';
    return String(ubicacion)
        .toUpperCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Quitar acentos
        .replace(/[^A-Z0-9\s]/g, ' ') // Solo letras y números
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Compara dos ubicaciones usando matching fuzzy.
 * Busca palabras clave comunes (río, bordo, margen, canal, etc.)
 */
function _matchUbicaciones(desc1, desc2) {
    if (!desc1 || !desc2) return false;

    // Palabras clave que identifican estructuras de riego
    const keywords = ['RIO', 'ARROYO', 'BORDO', 'CANAL', 'MARGEN', 'IZQUIERDA', 'DERECHA',
        'PRESA', 'DREN', 'COMPUERTA', 'GPS', 'TRAMO', 'PALIZADA', 'ARENAS',
        'USUMACINTA', 'ARMERIA', 'MARABASCO',
        'UNIDAD', 'RIEGO', 'UR', 'DISTRITO', 'DTT', 'DR',
        'COYUQUILLA', 'COSCAMILA', 'ENCINOS', 'AGUAS', 'BLANCAS', 'TLAPANECO', 'ALPOYECA'];

    // Extraer palabras significativas de cada descripción
    const words1 = desc1.split(' ').filter(w => w.length > 2);
    const words2 = desc2.split(' ').filter(w => w.length > 2);

    // Buscar palabras clave coincidentes
    let coincidencias = 0;
    let keywordMatch = false;

    for (const w1 of words1) {
        for (const w2 of words2) {
            if (w1 === w2) {
                coincidencias++;
                if (keywords.includes(w1)) {
                    keywordMatch = true;
                }
            }
        }
    }

    // Requiere al menos una palabra clave coincidente Y 2+ palabras totales
    return keywordMatch && coincidencias >= 2;
}

// ============================================================================
// HERENCIA DE LÍNEAS - LÓGICA "CARRY FORWARD"
// ============================================================================

/**
 * Busca la actualización inmediatamente anterior en la cadena de versiones.
 * Ejemplo: Para L30B, retorna la actualización L30A. Para L30A, retorna el ORIGEN.
 * 
 * @param {Array} actualizaciones - Lista de actualizaciones en cache
 * @param {number} idComunicado - ID del comunicado padre
 * @param {string} revisionActual - Revisión actual (ej: "L30B", "ORIGEN")
 * @param {Function} logFn - Función de logging
 * @returns {Object|null} Actualización predecesora o null si es ORIGEN
 */
function _buscarActualizacionPredecesora(actualizaciones, idComunicado, revisionActual, logFn) {
    const contexto = '_buscarActualizacionPredecesora';

    if (!actualizaciones || !idComunicado || !revisionActual) {
        logFn(`[${contexto}]Parámetros inválidos`);
        return null;
    }

    // Filtrar actualizaciones del mismo comunicado
    const actsMismoCom = actualizaciones.filter(a =>
        String(a.idComunicado) === String(idComunicado)
    );

    if (actsMismoCom.length === 0) {
        logFn(`[${contexto}]No hay actualizaciones para idComunicado ${idComunicado}`);
        return null;
    }

    logFn(`[${contexto}]Buscando predecesor de "${revisionActual}" entre ${actsMismoCom.length} actualizaciones`);

    // Si la revisión actual es ORIGEN, no hay predecesor
    const parsedActual = _parseVersion(revisionActual);
    if (!parsedActual.sufijo && parsedActual.index === 0) {
        logFn(`[${contexto}]"${revisionActual}" es ORIGEN - sin predecesor`);
        return null;
    }

    // Ordenar actualizaciones por índice de versión (A=1, B=2, C=3...)
    const actsOrdenadas = actsMismoCom.map(a => {
        const parsed = _parseVersion(a.revision);
        return {
            ...a,
            parsedIndex: parsed.index,
            parsedBase: parsed.base,
            parsedSufijo: parsed.sufijo
        };
    }).sort((a, b) => a.parsedIndex - b.parsedIndex);

    // Buscar la versión inmediatamente anterior
    // Si estamos en L30B (index=2), buscamos L30A (index=1)
    const indexBuscado = parsedActual.index - 1;

    logFn(`[${contexto}]Buscando index ${indexBuscado} para predecesor de ${revisionActual}(index = ${parsedActual.index})`);

    // Caso especial: Si buscamos index 0, es el ORIGEN
    if (indexBuscado === 0) {
        const origen = actsOrdenadas.find(a =>
            a.esOrigen === 1 || a.esOrigen === '1' || a.parsedIndex === 0
        );
        if (origen) {
            logFn(`[${contexto}]Predecesor es ORIGEN: id = ${origen.id}`);
            return origen;
        }
    } else {
        // Buscar por index exacto
        const predecesor = actsOrdenadas.find(a => a.parsedIndex === indexBuscado);
        if (predecesor) {
            logFn(`[${contexto}]Predecesor encontrado: ${predecesor.revision}(id = ${predecesor.id})`);
            return predecesor;
        }
    }

    // Fallback: Buscar la versión con el índice más alto que sea menor al actual
    const candidatos = actsOrdenadas.filter(a => a.parsedIndex < parsedActual.index);
    if (candidatos.length > 0) {
        const mejor = candidatos[candidatos.length - 1]; // El último (mayor índice menor al actual)
        logFn(`[${contexto}]Fallback predecesor: ${mejor.revision}(id = ${mejor.id})`);
        return mejor;
    }

    logFn(`[${contexto}]No se encontró predecesor para "${revisionActual}"`);
    return null;
}

/**
 * Obtiene las líneas del comunicado predecesor inmediato.
 * Implementa la lógica "carry-forward": hereda todas las líneas del predecesor.
 * 
 * @param {Object} cache - Cache de catálogos (debe incluir actualizaciones)
 * @param {number} idComunicado - ID del comunicado
 * @param {string} revisionActual - Identificador de revisión actual (ej: "L30B")
 * @param {Function} logFn - Función de logging
 * @returns {Array} Líneas del predecesor [{descripcion, categoria, importe, idOriginal}]
 */
function _obtenerLineasPredecesor(cache, idComunicado, revisionActual, logFn) {
    const contexto = '_obtenerLineasPredecesor';

    // 1. Buscar la actualización predecesora
    const actPredecesor = _buscarActualizacionPredecesora(
        cache.actualizaciones,
        idComunicado,
        revisionActual,
        logFn
    );

    if (!actPredecesor) {
        logFn(`[${contexto}]Sin predecesor para ${revisionActual} - retornando array vacío`);
        return [];
    }

    // 2. Cargar líneas del predecesor desde BD
    const lineasBDResponse = readAllRows('presupuestoLineas');
    if (!lineasBDResponse.success) {
        logFn(`[${contexto}]ERROR: No se pudieron leer líneas de presupuesto`);
        return [];
    }

    const lineasPredecesor = (lineasBDResponse.data || []).filter(l =>
        String(l.idActualizacion) === String(actPredecesor.id)
    );

    logFn(`[${contexto}]Encontradas ${lineasPredecesor.length} líneas del predecesor ${actPredecesor.revision || 'ORIGEN'}`);

    // 3. Retornar líneas con estructura normalizada, resolviendo descripcion desde DescripcionLineas
    return lineasPredecesor.map(l => {
        let descripcion = l.descripcion || 'Sin descripcion';
        let categoria = l.categoria || 'DAÑO FISICO';

        // Resolver descripcion desde DescripcionLineas usando idLinea
        if (l.idLinea && cache.descripcionLineas) {
            const descLinea = cache.descripcionLineas.find(dl => String(dl.id) === String(l.idLinea));
            if (descLinea) {
                descripcion = descLinea.descripcion;
                categoria = descLinea.categoria || l.categoria;
            }
        }

        return {
            descripcion: descripcion,
            categoria: categoria,
            importe: l.importe,
            idLinea: l.idLinea, // Incluir idLinea para trazabilidad
            idOriginal: l.id // Para referencia/trazabilidad
        };
    });
}

/**
 * Sincroniza líneas de presupuesto usando lógica "carry-forward".
 * 
 * REGLAS:
 * 1. Líneas que NO aparecen en el PDF → MANTIENEN su importe anterior
 * 2. Líneas que SÍ aparecen en el PDF → Se actualiza el importe
 * 3. Líneas nuevas → Se agregan
 * 
 * @param {number} idActualizacion - ID de la actualización nueva
 * @param {Array} lineasPdf - Líneas extraídas del PDF [{concepto, categoria, importe}]
 * @param {Array} lineasPredecesor - Líneas heredadas del predecesor [{descripcion, categoria, importe}]
 * @param {Function} logFn - Función de log
 * @returns {Object} Resumen de operaciones {inherited, updated, inserted}
 */
function _syncLineasCarryForward(idActualizacion, lineasPdf, lineasPredecesor, logFn) {
    const contexto = '_syncLineasCarryForward';
    const result = { inherited: 0, updated: 0, inserted: 0 };

    if (!idActualizacion) {
        logFn(`[${contexto}]ERROR: idActualizacion no proporcionado`);
        return result;
    }

    logFn(`[${contexto}]Iniciando sync: ${lineasPdf?.length || 0} líneas PDF, ${lineasPredecesor?.length || 0} líneas predecesor`);

    // Normalizar clave para comparación
    const _normKey = (concepto, categoria) => {
        const ubicNorm = _normalizarUbicacion(concepto);
        const catNorm = String(categoria || 'DAÑO FISICO').toUpperCase().trim()
            .replace('DESAZOLVE', 'DESAZOLVES');
        return `${ubicNorm}| ${catNorm} `;
    };

    // 1. Crear mapa de líneas del PDF
    const mapPdf = new Map();
    if (lineasPdf && lineasPdf.length > 0) {
        lineasPdf.forEach((l, i) => {
            const key = _normKey(l.concepto, l.categoria);
            logFn(`[${contexto}]PDF[${i}]: "${l.concepto?.substring(0, 40)}..."[${l.categoria}] $${l.importe} -> key="${key.substring(0, 50)}..."`);
            mapPdf.set(key, l);
        });
    }

    // 2. Crear mapa de líneas del predecesor
    const mapPredecesor = new Map();
    if (lineasPredecesor && lineasPredecesor.length > 0) {
        lineasPredecesor.forEach((l, i) => {
            const key = _normKey(l.descripcion, l.categoria);
            logFn(`[${contexto}]PRED[${i}]: "${l.descripcion?.substring(0, 40)}..."[${l.categoria}] $${l.importe} -> key="${key.substring(0, 50)}..."`);
            mapPredecesor.set(key, l);
        });
    }

    // Batch para insertar líneas finales
    const lineasAInsertar = [];

    // 3. PROCESAR LÍNEAS DEL PREDECESOR (carry-forward)
    for (const [key, lineaPredecesor] of mapPredecesor) {
        const lineaPdf = mapPdf.get(key);

        if (lineaPdf) {
            // Línea EXISTE en PDF → usar importe del PDF (actualización)
            const importeNuevo = parseFloat(lineaPdf.importe) || 0;
            const importeAnterior = parseFloat(lineaPredecesor.importe) || 0;

            if (Math.abs(importeNuevo - importeAnterior) > 0.01) {
                logFn(`[${contexto}]ACTUALIZAR: "${lineaPredecesor.descripcion}" $${importeAnterior} -> $${importeNuevo} `);
            } else {
                logFn(`[${contexto}] SIN CAMBIO: "${lineaPredecesor.descripcion}" $${importeAnterior} `);
            }

            lineasAInsertar.push({
                idActualizacion: idActualizacion,
                descripcion: String(lineaPredecesor.descripcion).toUpperCase().trim(),
                categoria: String(lineaPredecesor.categoria || 'DAÑO FISICO').toUpperCase(),
                importe: importeNuevo,
                consecutivo: lineasAInsertar.length + 1,
                fechaCreacion: new Date()
            });
            result.updated++;

            // Marcar como procesada
            mapPdf.delete(key);
        } else {
            // Línea NO EXISTE en PDF → MANTENER importe anterior (carry-forward)
            logFn(`[${contexto}]HEREDAR: "${lineaPredecesor.descripcion}"[${lineaPredecesor.categoria}] $${lineaPredecesor.importe} `);

            lineasAInsertar.push({
                idActualizacion: idActualizacion,
                descripcion: String(lineaPredecesor.descripcion).toUpperCase().trim(),
                categoria: String(lineaPredecesor.categoria || 'DAÑO FISICO').toUpperCase(),
                importe: parseFloat(lineaPredecesor.importe) || 0,
                consecutivo: lineasAInsertar.length + 1,
                fechaCreacion: new Date()
            });
            result.inherited++;
        }
    }

    // 4. AGREGAR LÍNEAS NUEVAS (solo existen en PDF, no en predecesor)
    for (const [key, lineaPdf] of mapPdf) {
        logFn(`[${contexto}]NUEVA: "${lineaPdf.concepto}"[${lineaPdf.categoria}] $${lineaPdf.importe} `);

        // Determinar categoría
        let catFinal = lineaPdf.categoria;
        if (!catFinal || catFinal.trim() === '') {
            const desc = String(lineaPdf.concepto || '').toUpperCase();
            if (desc.includes('DESAZOLVE') || desc.includes('LIMPIEZA') || desc.includes('EXTRACCI')) {
                catFinal = 'DESAZOLVES';
            } else if (desc.includes('SUPERVISI')) {
                catFinal = 'SUPERVISION';
            } else {
                catFinal = 'DAÑO FISICO';
            }
        }

        lineasAInsertar.push({
            idActualizacion: idActualizacion,
            descripcion: String(lineaPdf.concepto || 'Sin concepto').toUpperCase().trim(),
            categoria: catFinal.toUpperCase(),
            importe: parseFloat(lineaPdf.importe) || 0,
            consecutivo: lineasAInsertar.length + 1,
            fechaCreacion: new Date()
        });
        result.inserted++;
    }

    // 5. INSERTAR TODAS LAS LÍNEAS EN BATCH
    if (lineasAInsertar.length > 0) {
        logFn(`[${contexto}] Insertando ${lineasAInsertar.length} líneas en batch...`);
        try {
            const resCreate = createBatch('presupuestoLineas', lineasAInsertar);
            logFn(`[${contexto}] Batch insertado: ${resCreate.count || 0} líneas`);
        } catch (e) {
            logFn(`[${contexto}] ERROR en batch: ${e.message} `);
        }
    }

    logFn(`[${contexto}] Sync completado: ${result.inherited} heredadas, ${result.updated} actualizadas, ${result.inserted} nuevas`);
    return result;
}

function _markError(doc, omitidos, msg) {
    doc.validacion.esValido = false;
    doc.validacion.status = 'OMITIDO';
    doc.validacion.motivo = msg;
    omitidos.push(doc);
}

function _buildResponse(success, msg, counts, omitidos, allDocs, csvContent, debugLogs) {
    const responseData = {
        success: success,
        message: msg,
        resumen: {
            totalDocumentos: allDocs.length,
            procesados: counts ? (counts.newComs + counts.newLines) : 0,
            detallesTecnicos: counts,
            omitidos: omitidos ? omitidos.length : 0
        },
        csvErrorContent: csvContent,
        debugLogs: debugLogs,
        detalles: allDocs ? allDocs.map(d => ({
            ref: d.header.refCta,
            comunicado: d.header.comunicadoId,
            tipo: d.header.tipoRegistro, // Add this to fix UNK in frontend
            valido: d.validacion.esValido && d.validacion.status !== 'OMITIDO',
            errores: d.validacion.motivo ? [d.validacion.motivo] : d.validacion.errores
        })) : []
    };

    return {
        success: success,
        message: msg,
        data: responseData
    };
}


// ============================================================================
// LOGICA DE PARSING Y VALIDACION (ORIGINAL - MANTENIDA)
// ============================================================================

/**
 * Convierte un archivo Excel (base64) a formato CSV
 * VERSIÓN ROBUSTA - Soporta Drive API v2 y v3
 */
function convertirExcelACsv(base64Data) {
    const contexto = 'convertirExcelACsv';
    console.log(`[${contexto}] Iniciando conversión de Excel a CSV...`);
    let fileId = null;
    try {
        const decodedData = Utilities.base64Decode(base64Data);
        const blob = Utilities.newBlob(decodedData, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'temp_' + new Date().getTime() + '.xlsx');

        let file;
        if (Drive.Files.insert) {
            file = Drive.Files.insert({ title: blob.getName(), mimeType: MimeType.GOOGLE_SHEETS }, blob, { convert: true });
        } else if (Drive.Files.create) {
            file = Drive.Files.create({ name: blob.getName(), mimeType: MimeType.GOOGLE_SHEETS }, blob);
        } else {
            throw new Error('Drive API no disponible.');
        }

        fileId = file.id;
        const ss = SpreadsheetApp.openById(fileId);
        const sheet = ss.getSheets()[0];
        const data = sheet.getDataRange().getValues();

        if (!data || data.length === 0) throw new Error('Excel vacío');

        let csvContent = '';
        const timeZone = Session.getScriptTimeZone();
        data.forEach(row => {
            const csvRow = row.map(cell => {
                let s = '';
                if (cell instanceof Date) {
                    // Formatear fechas a ISO simple para evitar "Fri May 12..."
                    s = Utilities.formatDate(cell, timeZone, 'yyyy-MM-dd');
                } else {
                    s = String(cell || '');
                }

                if (s.includes(',') || s.includes('"') || s.includes('\n')) s = '"' + s.replace(/"/g, '""') + '"';
                return s;
            }).join(',');
            csvContent += csvRow + '\n';
        });

        return {
            success: true,
            data: {
                success: true,
                csvContent: csvContent,
                message: 'Archivo Excel convertido exitosamente'
            }
        };

    } catch (error) {
        console.error(`[${contexto}]Error: `, error);
        return { success: false, message: error.message };
    } finally {
        if (fileId) {
            try {
                if (Drive.Files.remove) Drive.Files.remove(fileId);
                else if (Drive.Files.delete) Drive.Files.delete(fileId);
            } catch (e) { }
        }
    }
}

function parseImportFile(csvInfo) {
    let cleanCsv = csvInfo;
    if (cleanCsv.charCodeAt(0) === 0xFEFF) cleanCsv = cleanCsv.slice(1);
    const rows = Utilities.parseCsv(cleanCsv);
    if (!rows || rows.length < 2) return [];

    const headers = rows[0].map(h => String(h).trim().toUpperCase());
    const dataRows = rows.slice(1);

    const idxRef = headers.indexOf('REF_CTA');
    const idxCom = headers.findIndex(h => h === 'COMUNICADO_ID' || h === 'COMUNICADO'); // Alias
    const idxTipo = headers.indexOf('TIPO_REGISTRO');
    const idxFecha = headers.indexOf('FECHA_DOC');

    // Robust Column Lookup with Aliases
    const idxEstado = headers.findIndex(h => ['ESTADO', 'ENTIDAD', 'EDO', 'NOMBRE'].includes(h));
    const idxSinRef = headers.findIndex(h => ['REF_SINIESTRO', 'SINIESTRO_REF', 'SINI_REF'].includes(h));
    if (idxSinRef === -1 && headers.indexOf('REF_SINIESTRO') > -1) idxSinRef = headers.indexOf('REF_SINIESTRO'); // Fallback

    const idxAseg = headers.findIndex(h => ['ASEGURADORA', 'ASEG'].includes(h));
    const idxFen = headers.indexOf('FENOMENO');
    const idxFi = headers.map(h => h.replace(/_/g, '')).indexOf('FECHASINIESTROFI'); // Loose match attempt? No, keep it safe
    // const idxFi = headers.indexOf('FECHA_SINIESTRO_FI'); 

    const idxFondo = headers.indexOf('FONDO');
    const idxDistrito = headers.findIndex(h => ['DISTRITO_RIEGO', 'DISTRITO', 'DR', 'NOMBRE_DISTRITO'].includes(h));
    const idxAjustador = headers.findIndex(h => ['AJUSTADOR', 'NOMBRE_AJUSTADOR', 'AJUST'].includes(h));
    const idxDesc = headers.indexOf('DESCRIPCION'); // Nuevo: Opción explicita usuario
    const idxTotal = headers.findIndex(h => h === 'TOTAL_DOC_PDF' || h === 'TOTAL_DOC_P'); // Alias por si viene cortado
    const idxConcepto = headers.indexOf('CONCEPTO_OBRA');
    const idxCat = headers.indexOf('CATEGORIA');
    const idxImporte = headers.indexOf('IMPORTE_RENGLON');
    const idxSup = headers.findIndex(h => h === 'MONTO_SUPERVISION' || h === 'MONTO_SUPERV'); // Alias

    if (idxRef === -1 || idxCom === -1) throw new Error('Faltan columnas REF_CTA o COMUNICADO_ID');

    const agrupado = {};

    dataRows.forEach(row => {
        const refCta = String(row[idxRef] || '').trim().toUpperCase();
        const comId = String(row[idxCom] || '').split(',')[0].trim().toUpperCase();
        const tipoRegistro = idxTipo > -1 ? String(row[idxTipo] || 'ACTUALIZACION').trim().toUpperCase() : 'ACTUALIZACION';

        if (!refCta || !comId) return;

        // Clave única compuesta: Ref + ID + TIPO
        // Esto permite que un ORIGEN y una ACTUALIZACION compartan el mismo ID (L30) pero sean objetos distintos.
        const key = `${refCta}| ${comId}| ${tipoRegistro} `;

        if (!agrupado[key]) {
            agrupado[key] = {
                header: {
                    refCta: refCta,
                    comunicadoId: comId,
                    descripcion: idxDesc > -1 ? String(row[idxDesc] || '').trim() : null, // Capturar descripcion
                    tipoRegistro: tipoRegistro,
                    fechaDoc: idxFecha > -1 ? row[idxFecha] : null,
                    estado: idxEstado > -1 ? String(row[idxEstado] || '').toUpperCase() : '',
                    refSiniestro: idxSinRef > -1 ? String(row[idxSinRef] || '').toUpperCase() : '',
                    aseguradora: idxAseg > -1 ? String(row[idxAseg] || '').toUpperCase() : '',
                    fenomeno: idxFen > -1 ? String(row[idxFen] || '').toUpperCase() : '',
                    fechaSiniestroFi: idxFi > -1 ? row[idxFi] : null,
                    fondo: idxFondo > -1 ? String(row[idxFondo] || '').toUpperCase() : '',
                    distritoRiego: idxDistrito > -1 ? String(row[idxDistrito] || '').toUpperCase() : '',
                    ajustador: idxAjustador > -1 ? String(row[idxAjustador] || '').toUpperCase() : '',
                    totalPdf: idxTotal > -1 ? (parseNumeric(row[idxTotal]) || 0) : 0,
                    montoSupervision: idxSup > -1 ? (parseNumeric(row[idxSup]) || 0) : 0
                },
                lineas: [],
                validacion: { sumaLineas: 0, esValido: true, errores: [] }
            };
        }
        const importe = idxImporte > -1 ? (parseNumeric(row[idxImporte]) || 0) : 0;
        agrupado[key].lineas.push({
            concepto: idxConcepto > -1 ? String(row[idxConcepto] || '') : '',
            categoria: idxCat > -1 ? String(row[idxCat] || '') : '',
            importe: importe
        });
        agrupado[key].validacion.sumaLineas += importe;
    });
    return Object.values(agrupado);
}

function validarLote(loteAgrupado, cache) {
    // Usamos el CACHE pasado por parametro en lugar de leer DB
    const cuentasExistentes = cache.cuentas;
    const comunicadosExistentes = cache.comunicados;

    loteAgrupado.forEach(doc => {
        doc.validacion = { esValido: true, status: 'OK', motivo: null, errores: [], sumaLineas: doc.validacion.sumaLineas };

        if (!doc.header.refCta || !doc.header.comunicadoId) {
            doc.validacion.esValido = false; doc.validacion.status = 'OMITIDO'; doc.validacion.motivo = 'Datos clave faltantes'; return;
        }
        if (!doc.header.totalPdf || doc.header.totalPdf <= 0) {
            doc.validacion.esValido = false; doc.validacion.status = 'OMITIDO'; doc.validacion.motivo = 'Monto Financiaro invalido'; return;
        }
        const diff = Math.abs(doc.header.totalPdf - doc.validacion.sumaLineas);

        // AUTO-CORRECCIÓN: Si hay líneas, la verdad está en la suma de líneas.
        if (doc.validacion.sumaLineas > 0 && diff > 1) {
            // Si el usuario puso un Header Total diferente a la suma, asumimos error de captura en el Header
            // y priorizamos la suma de las líneas de desglose.
            const oldTotal = doc.header.totalPdf;
            doc.header.totalPdf = doc.validacion.sumaLineas;
            doc.validacion.motivo = `Corregido: Total Header(${oldTotal}) ajustado a Suma Líneas(${doc.validacion.sumaLineas})`;
            // No marcamos omitido, dejamos pasar.
        } else if (doc.validacion.sumaLineas === 0 && doc.header.totalPdf > 0) {
            // Caso: Actualización de Monto sin desglose (posible en ajustes directos)
            // Se mantiene el totalPdf del header valido.
        }

        const cuentaObj = cuentasExistentes.find(c => c.referencia === doc.header.refCta || c.cuenta === doc.header.refCta);
        const idCuenta = cuentaObj ? cuentaObj.id : null;

        if (doc.header.tipoRegistro === 'ACTUALIZACION') {
            // 1. Validar REFERENCIA (Cuenta)
            // Existe en DB o existe UN ORIGEN para esta cuenta en el lote?
            const origenCuentaEnLote = loteAgrupado.find(d => d.header.refCta === doc.header.refCta && d.header.tipoRegistro === 'ORIGEN' && d.validacion.esValido);

            if (!idCuenta && !origenCuentaEnLote) {
                doc.validacion.esValido = false;
                doc.validacion.status = 'OMITIDO';
                doc.validacion.motivo = 'No existe Referencia (Cuenta) ni Origen en lote';
                return;
            }

            // 2. Validar COMUNICADO (Padre)
            // Existe en DB estricto?
            const existeComunicado = comunicadosExistentes.some(c => String(c.idReferencia) === String(idCuenta) && String(c.comunicado) === String(doc.header.comunicadoId));

            // Existe en Lote estricto? Buscamos ESPECIFICAMENTE el comunicado ID, no solo la cuenta.
            const origenComunicadoEnLote = loteAgrupado.find(d =>
                d.header.refCta === doc.header.refCta &&
                d.header.tipoRegistro === 'ORIGEN' &&
                d.header.comunicadoId === doc.header.comunicadoId &&
                d.validacion.esValido
            );

            if (!existeComunicado && !origenComunicadoEnLote) {
                // Caso especifico: Tenemos la cuenta (via lote o DB) pero el ID Comunicado no existe.
                if (origenCuentaEnLote) {
                    // Si hay otros origenes para esta cuenta, avisar cual se encontró para dar contexto, 
                    // pero el error real es que FALTA el origen especifico.
                    doc.validacion.esValido = false;
                    doc.validacion.status = 'OMITIDO';
                    doc.validacion.motivo = `No se encontró el Origen '${doc.header.comunicadoId}' en el lote(Se encontró otro: '${origenCuentaEnLote.header.comunicadoId}').`;
                    return;
                }

                doc.validacion.esValido = false;
                doc.validacion.status = 'OMITIDO';
                doc.validacion.motivo = 'No existe Comunicado Origen ni en DB ni en Lote';
                return;
            }



            if (origenComunicadoEnLote) {
                doc.validacion.motivo = 'Validado por dependencia en lote (Nuevo Origen)';
            }
        }
        else if (doc.header.tipoRegistro === 'ORIGEN') {
            if (!idCuenta) doc.validacion.esAltaExpress = true;
        }
    });
}

function parseNumeric(value) {
    if (value === null || value === undefined || value === '') return 0;
    const clean = String(value).replace(/[$,]/g, '');
    const num = parseFloat(clean);
    return isNaN(num) ? 0 : num;
}

function _generarCsvErrores(listaOmitidos) {
    const headers = ['REF_CTA', 'COMUNICADO_ID', 'TIPO', 'MOTIVO_ERROR'];
    let csvString = headers.join(',') + '\n';
    listaOmitidos.forEach(item => {
        const row = [
            `"${item.header.refCta || ''}"`,
            `"${item.header.comunicadoId || ''}"`,
            `"${item.header.tipoRegistro || ''}"`,
            `"${item.validacion.motivo || item.validacion.errores.join('; ') || 'Error'}"`
        ];
        csvString += row.join(',') + '\n';
    });
    return Utilities.base64Encode(csvString);
}

// ============================================================================
// MÓDULO: IMPORTACIÓN DE FACTURAS
// ============================================================================

/**
 * API PÚBLICA: Previsualizar Facturas (Solo Lectura)
 */
function previsualizarImportacionFacturas(fileContent) {
    const contexto = 'previsualizarImportacionFacturas';
    console.log(`[${contexto}] Iniciando...`);

    try {
        const rows = parseFacturaFile(fileContent);

        // Cargar caches necesarios
        const facturasExistentes = readAllRows('facturas').data || [];
        const comunicadosExistentes = readAllRows('comunicados').data || [];
        const cuentasExistentes = readAllRows('cuentas').data || []; // Por si referencia es por cuenta?? No, requerimos ID Comunicado o Clave.

        // Mapeo UUIDs existentes
        const uuidsMap = new Set(facturasExistentes.map(f => String(f.uuid || '').toUpperCase()));

        // Mapeo Comunicados (Clave -> ID)
        // La columna REF_COMUNICADO puede ser la CLAVE del comunicado (e.g. C-001)
        const comunicadoMap = new Map();
        comunicadosExistentes.forEach(c => {
            comunicadoMap.set(String(c.comunicado).trim().toUpperCase(), c);
        });

        const previewData = rows.map(row => {
            const h = row;
            const analisis = {
                esValido: true,
                motivo: null,
                uuidDuplicado: false,
                comunicadoEncontrado: false
            };

            // Validaciones
            if (!h.uuid || !h.folio || !h.monto || !h.refComunicado) {
                analisis.esValido = false;
                analisis.motivo = 'Datos obligatorios faltantes (UUID, Folio, Monto, Ref)';
            }

            // Validar UUID Único
            if (h.uuid && uuidsMap.has(h.uuid.toUpperCase())) {
                analisis.esValido = false;
                analisis.motivo = 'UUID ya registrado en el sistema';
                analisis.uuidDuplicado = true;
            }

            // Validar Referencia Comunicado
            let comRef = null;
            if (h.refComunicado) {
                const key = String(h.refComunicado).trim().toUpperCase();
                const found = comunicadoMap.get(key);
                if (found) {
                    analisis.comunicadoEncontrado = true;
                    comRef = found.comunicado; // Mostrar clave real
                } else {
                    analisis.esValido = false;
                    analisis.motivo = `Comunicado '${h.refComunicado}' no encontrado`;
                }
            }

            return {
                folio: h.folio,
                uuid: h.uuid,
                fecha: h.fecha ? new Date(h.fecha).toISOString().split('T')[0] : '',
                monto: h.monto,
                comunicadoRef: h.refComunicado,
                proveedor: h.proveedor,
                estatus: h.estatus,
                esValido: analisis.esValido,
                motivo: analisis.motivo
            };
        });

        const resumen = {
            total: previewData.length,
            validos: previewData.filter(d => d.esValido).length,
            omitidos: previewData.filter(d => !d.esValido).length
        };

        return {
            success: true,
            data: {
                resumen: resumen,
                filas: previewData
            }
        };

    } catch (error) {
        console.error(`Error en ${contexto}: `, error);
        return { success: false, message: error.message };
    }
}

/**
 * Controladora para Ejecutar la Importación de Facturas
 */
function ejecutarImportacionFacturas(fileContent) {
    const contexto = 'ejecutarImportacionFacturas';
    console.log(`[${contexto}] Iniciando persistencia...`);

    try {
        const rows = parseFacturaFile(fileContent);

        // Recargar cache para asegurar consistencia
        const facturasExistentes = readAllRows('facturas').data || [];
        const comunicadosExistentes = readAllRows('comunicados').data || [];

        const uuidsMap = new Set(facturasExistentes.map(f => String(f.uuid || '').toUpperCase()));
        const comunicadoMap = new Map();
        comunicadosExistentes.forEach(c => {
            comunicadoMap.set(String(c.comunicado).trim().toUpperCase(), c.id); // Map Clave -> ID Real
        });

        // Filtrar y preparar para batch
        const batchFacturas = [];
        const omitidos = [];

        rows.forEach(row => {
            // Re-validación rápida
            const uuid = String(row.uuid || '').trim().toUpperCase();
            if (!uuid || !row.folio || !row.monto || !row.refComunicado) {
                omitidos.push({ ...row, error: 'Datos incompletos' });
                return;
            }
            if (uuidsMap.has(uuid)) {
                omitidos.push({ ...row, error: 'UUID duplicado' });
                return;
            }

            const comKey = String(row.refComunicado).trim().toUpperCase();
            const idComunicado = comunicadoMap.get(comKey);

            if (!idComunicado) {
                omitidos.push({ ...row, error: 'Comunicado no existe' });
                return;
            }

            batchFacturas.push({
                idComunicado: idComunicado,
                folio: row.folio,
                fecha: row.fecha, // Deberia ser obj Date o string ISO? createBatch usa raw, Sheets parsea. Mejor Date.
                monto: row.monto,
                uuid: row.uuid,
                estatus: row.estatus || 'VIGENTE',
                proveedor: row.proveedor
            });
        });

        let insertedCount = 0;
        if (batchFacturas.length > 0) {
            const res = createBatch('facturas', batchFacturas);
            insertedCount = res.count;
        }

        return {
            success: true,
            data: {
                resumen: {
                    procesados: insertedCount,
                    omitidos: omitidos.length
                },
                omitidos: omitidos // Opcional devolver detalle
            },
            message: 'Importación de facturas completada'
        };

    } catch (e) {
        console.error(`Error en ${contexto}: `, e);
        return { success: false, message: e.message };
    }
}

/**
 * Parser específico para Facturas
 * Columas esperadas: FOLIO, FECHA, MONTO, UUID, PROVEEDOR, REF_COMUNICADO
 */
function parseFacturaFile(csvText) {
    let cleanCsv = csvText;
    if (cleanCsv.charCodeAt(0) === 0xFEFF) cleanCsv = cleanCsv.slice(1);

    const rows = Utilities.parseCsv(cleanCsv);
    if (!rows || rows.length < 2) return [];

    const headers = rows[0].map(h => String(h).trim().toUpperCase());
    const dataRows = rows.slice(1);

    // Mapeo Indices
    const idxFolio = headers.findIndex(h => h.includes('FOLIO') && !h.includes('FISCAL'));
    const idxFecha = headers.findIndex(h => h.includes('FECHA'));
    const idxMonto = headers.findIndex(h => h === 'MONTO' || h === 'TOTAL' || h === 'IMPORTE');
    const idxUuid = headers.findIndex(h => h === 'UUID' || h === 'FOLIO FISCAL' || h === 'FOLIO_FISCAL');
    const idxProv = headers.findIndex(h => h === 'PROVEEDOR' || h === 'EMISOR' || h === 'RAZON SOCIAL');
    const idxRef = headers.findIndex(h => h === 'REF_COMUNICADO' || h === 'COMUNICADO' || h === 'REFERENCIA');
    const idxEstatus = headers.findIndex(h => h === 'ESTATUS' || h === 'ESTADO');

    if (idxUuid === -1 || idxMonto === -1) {
        throw new Error('Formato inválido: Se requieren columnas UUID y MONTO/TOTAL.');
    }

    return dataRows.map(r => {
        // Parsear fecha flexible
        let fecha = null;
        if (idxFecha > -1 && r[idxFecha]) {
            // Intentar parseo básico, o dejar string
            const val = r[idxFecha];
            // Si es string 'DD/MM/YYYY', convertir. Si es ISO, dejar.
            fecha = val;
        }

        return {
            folio: idxFolio > -1 ? String(r[idxFolio]).trim() : 'S/N',
            fecha: fecha,
            monto: idxMonto > -1 ? (parseNumeric(r[idxMonto]) || 0) : 0,
            uuid: idxUuid > -1 ? String(r[idxUuid]).trim() : null,
            proveedor: idxProv > -1 ? String(r[idxProv]).trim() : '',
            refComunicado: idxRef > -1 ? String(r[idxRef]).trim() : null,
            estatus: idxEstatus > -1 ? String(r[idxEstatus]).trim() : 'Por Validar'
        };
    }).filter(obj => obj.uuid); // Filtrar filas vacias
}

/**
 * Helper para obtener líneas del predecesor inmediato desde BD
 * Utilizado por _procesarBatchInterno para carry-forward en memoria
 */
function _obtenerLineasPredecesor(cache, idComunicado, revisionActual, logBatch) {
    if (!idComunicado) return [];

    try {
        // 1. Obtener todas las actualizaciones de este comunicado en cache
        const acts = cache.actualizaciones.filter(a => String(a.idComunicado) === String(idComunicado));
        if (acts.length === 0) return [];

        // 2. Determinar índice de versión actual
        const verActual = _parseVersion(revisionActual);

        // Buscamos el índice inmediatamente anterior (ej: L50B(2) -> busca index 1 (L50A))
        const targetIndex = verActual.index - 1;

        // Si targetIndex < 0, significa que somos L50A buscando L50 origin.
        // Pero las líneas del Origen suelen guardarse bajo una actualización con esOrigen=1.
        // Asumimos que la tabla actualizaciones contiene el registro de origen también.

        const predecesor = acts.find(a => {
            const v = _parseVersion(a.revision || a.tipoRegistro || ''); // a.revision guarda "L50A"
            return v.index === targetIndex;
        });

        if (!predecesor) {
            if (logBatch) logBatch(`[_obtenerLineasPredecesor] No se encontró predecesor para ${revisionActual} (Target Index: ${targetIndex}) en BD.`);
            return [];
        }

        if (logBatch) logBatch(`[_obtenerLineasPredecesor] Predecesor encontrado: ${predecesor.revision} (ID: ${predecesor.id})`);

        // 3. Obtener líneas asociadas a esa actualización
        const lines = cache.presupuestoLineas.filter(l => String(l.idActualizacion) === String(predecesor.id));

        // 4. Mapear a formato simple (compatible con Merge Logic)
        return lines.map(l => {
            const descEntry = cache.descripcionLineas.find(d => String(d.id) === String(l.idLinea));

            // Convertir categoría numérica a texto para el merge
            let catStr = 'DAÑO FISICO';
            if (String(l.categoria) === '2') catStr = 'DESAZOLVES';

            return {
                concepto: descEntry ? descEntry.descripcion : 'Sin descripción', // Usamos 'concepto' para compatibilidad
                descripcion: descEntry ? descEntry.descripcion : 'Sin descripción',
                categoria: catStr,
                importe: parseFloat(l.importe || 0)
            };
        });

    } catch (e) {
        if (logBatch) logBatch(`[_obtenerLineasPredecesor] Error: ${e.message}`);
        return [];
    }
}
