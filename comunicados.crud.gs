/**
 * ============================================================================
 * ARCHIVO: comunicados.crud.gs
 * Descripción: Operaciones CRUD para Comunicados
 * Versión: 2.5 (FINAL - Duplicates Removed & Sync Forced)
 * ============================================================================
 */

/**
 * === CATALOGO DE COMUNICADOS ===
 * Obtiene catálogos necesarios para crear comunicados
 * @return {Object} {success, data: {estados, distritosRiego, siniestros}}
 */
function fetchComunicadoCatalogs() {
    if (typeof confirmarConfiguracion === 'function') confirmarConfiguracion();
    const debugLog = [];
    const log = (msg) => {
        console.log(msg);
        debugLog.push(String(msg));
    };

    try {
        log('Iniciando fetchComunicadoCatalogs...');

        // 1. Verificar hojas disponibles en el libro
        const ss = SpreadsheetApp.getActive();
        const sheets = ss.getSheets();
        const sheetNames = sheets.map(s => s.getName());
        log(`Hojas disponibles en el libro (${sheetNames.length}): ${sheetNames.join(', ')}`);

        // 2. Función auxiliar para leer y diagnosticar
        const leerCatalogo = (key) => {
            const def = TABLE_DEFINITIONS[key];
            if (!def) {
                log(`Error: No hay definición para la tabla '${key}'`);
                return [];
            }
            const nombreHoja = def.sheetName;
            log(`Leyendo catálogo '${key}' desde hoja '${nombreHoja}'...`);

            if (!sheetNames.includes(nombreHoja)) {
                log(`CRÍTICO: La hoja '${nombreHoja}' NO existe exactamente. Buscando coincidencias...`);
                const match = sheetNames.find(n => n.toLowerCase() === nombreHoja.toLowerCase());
                if (match) log(`-> Encontrada hoja similar: '${match}' (diferencia de mayúsculas/minúsculas)`);
                else log(`-> No se encontró ninguna hoja similar a '${nombreHoja}'`);
            }

            const response = readAllRows(key);
            if (!response.success) {
                log(`Error en readAllRows('${key}'): ${response.message}`);
                return [];
            }

            const data = response.data || [];
            log(`Éxito leyendo '${key}': ${data.length} registros encontrados.`);

            if (data.length > 0) {
                log(`Ejemplo primer registro '${key}': ${JSON.stringify(data[0])}`);
            } else {
                // Diagnóstico profundo si está vacío
                const rawSheet = ss.getSheetByName(nombreHoja);
                if (rawSheet) {
                    const lastRow = rawSheet.getLastRow();
                    log(`Diagnóstico '${nombreHoja}': LastRow=${lastRow}`);
                    if (lastRow > 0) {
                        const headers = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];
                        log(`Headers en '${nombreHoja}': ${JSON.stringify(headers)}`);
                    }
                }
            }
            return data;
        };

        // 3. Leer los catálogos
        const estados = leerCatalogo('estados');
        const distritos = leerCatalogo('distritosRiego');
        const siniestros = leerCatalogo('siniestros');
        const ajustadores = leerCatalogo('ajustadores');
        const aseguradoras = leerCatalogo('aseguradoras');
        const empresas = leerCatalogo('empresas');

        // NUEVO: Obtener categorías únicas de presupuestoLineas
        // Esto permite que el dropdown del modal "Desglose Presupuestal" tenga todas las categorías usadas históricamente.
        const lineas = leerCatalogo('presupuestoLineas') || [];
        const categoriasSet = new Set(['DAÑO FISICO', 'DESAZOLVES']); // Defaults requeridos (text only)
        lineas.forEach(l => {
            if (l.categoria) {
                let cat = l.categoria.toString().trim().toUpperCase();
                // Normalize legacy codes
                if (cat === '1') cat = 'DAÑO FISICO';
                if (cat === '2') cat = 'DESAZOLVES';
                categoriasSet.add(cat);
            }
        });
        const categorias = Array.from(categoriasSet).map(c => ({ id: c, nombre: c })); // Formato objeto para consistencia

        // 4. Procesar datos (ordenar)
        const processResponse = (data) => {
            if (Array.isArray(data)) {
                return data.sort((a, b) => {
                    const nombreA = String(a.nombre || a.nombreAjustador || a.estado || a.distritoRiego || a.siniestro || a.aseguradora || a.razonSocial || '');
                    const nombreB = String(b.nombre || b.nombreAjustador || b.estado || b.distritoRiego || b.siniestro || b.aseguradora || b.razonSocial || '');
                    return nombreA.localeCompare(nombreB, 'es', { sensitivity: 'base' });
                });
            }
            return [];
        };

        return {
            success: true,
            data: {
                success: true, // Redundante para satisfacer chequeo del frontend
                estados: processResponse(estados),
                distritosRiego: processResponse(distritos),
                siniestros: processResponse(siniestros),
                ajustadores: processResponse(ajustadores),
                aseguradoras: processResponse(aseguradoras),
                empresas: processResponse(empresas),
                categorias: processResponse(categorias),
                debugLogs: debugLog
            }
        };

    } catch (error) {
        log(`Excepción en fetchComunicadoCatalogs: ${error.message}`);
        console.error(error);
        return {
            success: false,
            message: `Error al obtener catálogos: ${error.message}`,
            debugLogs: debugLog
        };
    }
}

/**
 * Alias para compatibilidad con versiones cacheadas del cliente
 */
function getComunicadoCatalogs() {
    return fetchComunicadoCatalogs();
}

/**
 * === CREAR COMUNICADO ===
 * Realiza validaciones y genera registros relacionados para un nuevo comunicado
 */
function createComunicado(data) {
    const contexto = 'createComunicado';
    try {
        const comunicadoNombre = String(data?.comunicado || data?.label || '').trim();
        if (!comunicadoNombre) {
            return crearRespuestaError('El nombre del comunicado es obligatorio', { source: contexto });
        }
        if (comunicadoNombre.length > 15) {
            return crearRespuestaError('El comunicado no puede exceder 15 caracteres', { source: contexto });
        }

        const referenciaId = String(data?.idCuenta || data?.idReferencia || '').trim();
        if (!referenciaId) {
            return crearRespuestaError('Se requiere la referencia asociada', { source: contexto });
        }

        const distritoNombre = String(data?.distrito || '').trim();
        if (!distritoNombre) {
            return crearRespuestaError('El distrito de riego es obligatorio', { source: contexto });
        }

        const siniestroNombre = String(data?.siniestro || '').trim();
        if (!siniestroNombre) {
            return crearRespuestaError('El siniestro es obligatorio', { source: contexto });
        }

        const fecha = String(data?.fecha || '').trim();
        if (!fecha) {
            return crearRespuestaError('La fecha del comunicado es obligatoria', { source: contexto });
        }

        const estadoId = String(data?.estadoId || data?.estado || '').trim();
        if (!estadoId) {
            return crearRespuestaError('Selecciona un estado válido', { source: contexto });
        }

        const cuentaResult = buscarPorId('cuentas', cuentaId);
        if (!cuentaResult.success) {
            return propagarRespuestaError(contexto, cuentaResult);
        }
        const cuenta = cuentaResult.data;

        const comunicadosResponse = readAllRows('comunicados');
        if (!comunicadosResponse.success) {
            return propagarRespuestaError(contexto, comunicadosResponse, { message: `No fue posible validar comunicados existentes: ${comunicadosResponse.message}` });
        }
        const comunicadosExistentes = comunicadosResponse.data || [];
        const duplicado = comunicadosExistentes.find(c =>
            normalizarClave(c.comunicado) === normalizarClave(comunicadoNombre) &&
            String(c.idReferencia) === referenciaId
        );

        if (duplicado) {
            return crearRespuestaError(`Ya existe un comunicado "${comunicadoNombre}" para esta cuenta`, { source: contexto });
        }

        const distritoResult = ensureCatalogRecord('distritosRiego', { distritoRiego: distritoNombre });
        if (!distritoResult.success) {
            return propagarRespuestaError(contexto, distritoResult);
        }

        const siniestroResult = ensureCatalogRecord('siniestros', {
            siniestro: siniestroNombre,
            fenomeno: data?.fenomeno || '',
            fondo: data?.fondo || '',
            fi: data?.fi || ''
        });
        if (!siniestroResult.success) {
            return propagarRespuestaError(contexto, siniestroResult);
        }

        const comunicadosDef = TABLE_DEFINITIONS.comunicados;
        const comunicadosTabla = obtenerDatosTabla(comunicadosDef.sheetName);
        if (!comunicadosTabla.sheet) {
            return crearRespuestaError('No se encontró la hoja de Comunicados.', { source: contexto });
        }
        const idxComunicadoId = buscarIndiceColumna(
            comunicadosTabla.headers,
            comunicadosDef.headers?.[comunicadosDef.primaryField] || comunicadosDef.primaryField
        );
        if (idxComunicadoId === -1) {
            return crearRespuestaError('No se identificó la columna de ID para Comunicados.', { source: contexto });
        }

        const datosGeneralesDef = TABLE_DEFINITIONS.datosGenerales;
        const datosGeneralesTabla = obtenerDatosTabla(datosGeneralesDef.sheetName);
        if (!datosGeneralesTabla.sheet) {
            return crearRespuestaError('No se encontró la hoja de DatosGenerales.', { source: contexto });
        }
        const idxDatosGeneralesId = buscarIndiceColumna(
            datosGeneralesTabla.headers,
            datosGeneralesDef.headers?.[datosGeneralesDef.primaryField] || datosGeneralesDef.primaryField
        );
        if (idxDatosGeneralesId === -1) {
            return crearRespuestaError('No se identificó la columna de ID para DatosGenerales.', { source: contexto });
        }

        const comunicadoId = obtenerSiguienteId(comunicadosTabla.rows, idxComunicadoId);
        const datosGeneralesId = obtenerSiguienteId(datosGeneralesTabla.rows, idxDatosGeneralesId);

        const descripcion = `${cuenta.cuenta}-${comunicadoNombre}`;
        if (descripcion.length > 15) {
            return crearRespuestaError(
                `La descripción "${descripcion}" excede 15 caracteres. Usa un comunicado más corto.`,
                { source: contexto }
            );
        }

        const datosGeneralesRecord = {
            id: datosGeneralesId,
            idComunicado: comunicadoId,
            descripcion: descripcion,
            fecha: fecha,
            idEstado: estadoId,
            idDR: distritoResult.data?.id || '',
            idSiniestro: siniestroResult.data?.id || '',
            fechaAsignacion: null,
            idActualizacion: null
        };

        const datosGeneralesResponse = insertarRegistro('datosGenerales', datosGeneralesRecord);
        if (!datosGeneralesResponse.success) {
            return propagarRespuestaError(contexto, datosGeneralesResponse, { message: `Error al crear datos generales: ${datosGeneralesResponse.message}` });
        }

        const comunicadoRecord = {
            id: comunicadoId,
            idReferencia: referenciaId,
            comunicado: comunicadoNombre,
            status: 1,
            idSustituido: null
        };

        const comunicadoResponse = insertarRegistro('comunicados', comunicadoRecord);
        if (!comunicadoResponse.success) {
            eliminarRegistro('datosGenerales', datosGeneralesId);
            return propagarRespuestaError(contexto, comunicadoResponse, { message: `Error al crear comunicado: ${comunicadoResponse.message}` });
        }

        return {
            success: true,
            message: `Comunicado "${comunicadoNombre}" creado correctamente`,
            data: {
                comunicado: comunicadoRecord,
                datosGenerales: datosGeneralesRecord,
                distrito: distritoResult.data,
                siniestro: siniestroResult.data
            }
        };

    } catch (error) {
        console.error('Error en createComunicado:', error);
        return crearRespuestaError(`Error al crear comunicado: ${error.message}`, { source: contexto, error });
    }
}

/**
 * === ELIMINAR CUENTA (EN CASCADA) ===
 * Elimina una cuenta y todos sus comunicados asociados.
 * Cada comunicado se elimina con deleteComunicado, que a su vez
 * elimina en cascada: Tickets, Equipo, Financiero, Actualizaciones, DatosGenerales.
 */
function deleteCuenta(id) {
    const contexto = 'deleteCuenta';
    try {
        const cuentaId = String(id || '').trim();
        if (!cuentaId) {
            return crearRespuestaError('Se requiere el ID de la cuenta', { source: contexto });
        }

        // 1. Validar existencia de la cuenta
        const cuentaResult = buscarPorId('cuentas', cuentaId);
        if (!cuentaResult.success) {
            return propagarRespuestaError(contexto, cuentaResult);
        }
        const cuenta = cuentaResult.data;

        // 2. Obtener comunicados asociados
        const comunicadosResult = readComunicadosPorCuenta(cuentaId);
        if (!comunicadosResult.success) {
            return propagarRespuestaError(contexto, comunicadosResult, {
                message: 'No se pudo obtener los comunicados asociados'
            });
        }

        // 3. Eliminar cada comunicado en cascada
        const comunicados = comunicadosResult.data || [];
        let comunicadosEliminados = 0;

        for (const com of comunicados) {
            const deleteResult = deleteComunicado(com.id);
            if (!deleteResult.success) {
                console.warn(`[${contexto}] Error eliminando comunicado ${com.id}:`, deleteResult.message);
                // Continuar con los demás, no abortar
            } else {
                comunicadosEliminados++;
            }
        }

        // 4. Eliminar la cuenta
        const deleteResponse = eliminarRegistro('cuentas', cuentaId);
        if (!deleteResponse.success) {
            return propagarRespuestaError(contexto, deleteResponse);
        }

        return {
            success: true,
            message: `Cuenta "${cuenta.referencia || cuenta.cuenta}" eliminada correctamente junto con ${comunicadosEliminados} comunicado(s).`
        };

    } catch (error) {
        console.error('Error en deleteCuenta:', error);
        return crearRespuestaError(`Error al eliminar cuenta: ${error.message}`, { source: contexto, error, details: { id } });
    }
}

/**
 * === LISTAR COMUNICADOS POR CUENTA ===
 * Devuelve comunicados enriquecidos asociados a una cuenta.
 */
function readComunicadosPorCuenta(idCuenta) {
    const contexto = 'readComunicadosPorCuenta';
    let cuentaIdNumerico;

    try {
        if (idCuenta === null || idCuenta === undefined || String(idCuenta).trim() === '') {
            return crearRespuestaError('El ID de la cuenta no puede estar vacío', { source: contexto });
        }
        if (Array.isArray(idCuenta)) {
            if (idCuenta.length === 0) {
                return crearRespuestaError('El ID de cuenta proporcionado (array vacío) es inválido', { source: contexto });
            }
            cuentaIdNumerico = parseInt(idCuenta[0], 10);
        } else {
            cuentaIdNumerico = parseInt(idCuenta, 10);
        }

        if (isNaN(cuentaIdNumerico)) {
            return crearRespuestaError('El ID de la cuenta debe ser un número válido', { source: contexto, details: { idCuentaOriginal: idCuenta } });
        }

    } catch (error) {
        return crearRespuestaError(`Error al procesar ID de cuenta: ${error.message}`, { source: contexto, error });
    }

    try {
        const tablasAEvaluar = {
            comunicados: { response: readAllRows('comunicados'), essential: true },
            cuentas: { response: readAllRows('cuentas'), essential: true },
            datosGenerales: { response: readAllRows('datosGenerales'), essential: true },
            estados: { response: readAllRows('estados'), essential: false },
            distritosRiego: { response: readAllRows('distritosRiego'), essential: false },
            siniestros: { response: readAllRows('siniestros'), essential: false },
            empresas: { response: readAllRows('empresas'), essential: false }
        };

        const datosListas = {};
        for (const [nombreTabla, resultado] of Object.entries(tablasAEvaluar)) {
            if (!resultado.response || !resultado.response.success) {
                if (resultado.essential) {
                    return propagarRespuestaError(contexto, resultado.response, {
                        message: `Error crítico al leer la tabla esencial '${nombreTabla}': ${resultado.response?.message || 'respuesta inválida'}`
                    });
                } else {
                    console.warn(`readComunicadosPorCuenta: No se pudo leer la tabla opcional '${nombreTabla}'. Se continuará sin estos datos.`);
                    datosListas[nombreTabla] = [];
                }
            } else {
                datosListas[nombreTabla] = resultado.response.data || [];
            }
        }

        const parseNumeric = (value) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : null;
        };
        const timeZone = (typeof Session !== 'undefined' && Session.getScriptTimeZone) ? Session.getScriptTimeZone() : 'UTC';
        const formatDateValue = (value) => {
            if (value instanceof Date && !Number.isNaN(value.getTime?.())) {
                try { return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd'); } catch (dateError) { return value.toISOString ? value.toISOString() : String(value); }
            }
            return value === null || value === undefined ? '' : String(value);
        };

        const cuentaIdString = String(cuentaIdNumerico);
        const comunicadosFiltradosPorCuenta = (datosListas.comunicados || []).filter(com =>
            String(com.idReferencia).trim() === cuentaIdString
        );

        if (comunicadosFiltradosPorCuenta.length === 0) {
            return { success: true, data: [], message: 'La cuenta no tiene comunicados registrados' };
        }

        const comunicadosPorId = mapeoPorCampo(comunicadosFiltradosPorCuenta, 'id');
        const cuentasPorId = mapeoPorCampo(datosListas.cuentas || [], 'id');
        const datosGeneralesPorComunicadoId = mapeoPorCampo(datosListas.datosGenerales || [], 'idComunicado');
        const estadosPorId = mapeoPorCampo(datosListas.estados || [], 'id');
        const distritosPorId = mapeoPorCampo(datosListas.distritosRiego || [], 'id');
        const siniestrosPorId = mapeoPorCampo(datosListas.siniestros || [], 'id');

        const cuentaActual = obtenerDesdeMapa(cuentasPorId, cuentaIdNumerico);
        if (!cuentaActual) {
            return crearRespuestaError(`Inconsistencia: Cuenta con ID ${cuentaIdNumerico} no encontrada después de leer la tabla cuentas.`, { source: contexto });
        }

        const datosIntegrados = comunicadosFiltradosPorCuenta.map(comunicado => {
            const datoGeneral = obtenerDesdeMapa(datosGeneralesPorComunicadoId, comunicado.id) || {};
            const estado = obtenerDesdeMapa(estadosPorId, datoGeneral.idEstado) || {};
            const distrito = obtenerDesdeMapa(distritosPorId, datoGeneral.idDR) || {};
            const siniestro = obtenerDesdeMapa(siniestrosPorId, datoGeneral.idSiniestro) || {};

            return {
                id: parseNumeric(comunicado.id) ?? String(comunicado.id || '').trim(),
                idComunicado: parseNumeric(comunicado.id) ?? String(comunicado.id || '').trim(),
                idSustituido: parseNumeric(comunicado.idSustituido),
                idReferencia: parseNumeric(cuentaActual.id) ?? cuentaIdNumerico,
                idCuenta: parseNumeric(cuentaActual.id) ?? cuentaIdNumerico, // Mantener idCuenta por si el frontend lo usa
                cuenta: String(cuentaActual.cuenta || cuentaActual.referencia || cuentaActual.nombre || ''),
                comunicado: String(comunicado.comunicado || ''),
                status: comunicado.status ?? '',
                idDatosGenerales: parseNumeric(datoGeneral.id),
                descripcion: String(datoGeneral.descripcion || ''),
                fecha: formatDateValue(datoGeneral.fecha),
                idEstado: parseNumeric(datoGeneral.idEstado),
                estado: String(estado.estado || estado.nombre || ''),
                idDistritoRiego: parseNumeric(datoGeneral.idDR),
                distrito: String(distrito.distritoRiego || distrito.nombre || ''),
                fechaAsignacion: formatDateValue(datoGeneral.fechaAsignacion) || null,
                idSiniestro: parseNumeric(datoGeneral.idSiniestro),
                siniestro: String(siniestro.siniestro || siniestro.nombre || ''),
                fenomeno: String(siniestro.fenomeno || ''),
                fondo: String(siniestro.fondo || ''),
                fi: String(siniestro.fi || '')
            };
        }).sort((a, b) => {
            const nombreA = String(a.comunicado || '').toLowerCase();
            const nombreB = String(b.comunicado || '').toLowerCase();
            return nombreA.localeCompare(nombreB, 'es', { sensitivity: 'base' });
        });

        const datosSanitizados = JSON.parse(JSON.stringify(datosIntegrados));
        return { success: true, data: datosSanitizados, message: 'Comunicados encontrados' };

    } catch (error) {
        console.error('Error catastrófico en readComunicadosPorCuenta:', error);
        return crearRespuestaError(`Error inesperado al leer comunicados: ${error.message}`, { source: contexto, error, details: { idCuenta: idCuenta } });
    }
}

/**
 * === LISTAR TODOS LOS COMUNICADOS ===
 * Devuelve todos los comunicados enriquecidos del sistema.
 */
function readAllComunicados() {
    const contexto = 'readAllComunicados';
    try {
        const tablasAEvaluar = {
            comunicados: { response: readAllRows('comunicados'), essential: true },
            cuentas: { response: readAllRows('cuentas'), essential: true },
            datosGenerales: { response: readAllRows('datosGenerales'), essential: true },
            estados: { response: readAllRows('estados'), essential: false },
            distritosRiego: { response: readAllRows('distritosRiego'), essential: false },
            siniestros: { response: readAllRows('siniestros'), essential: false },
            actualizaciones: { response: readAllRows('actualizaciones'), essential: false },
            empresas: { response: readAllRows('empresas'), essential: false } // Para obtener contratista
        };

        const datosListas = {};
        for (const [nombreTabla, resultado] of Object.entries(tablasAEvaluar)) {
            if (!resultado.response || !resultado.response.success) {
                if (resultado.essential) {
                    return propagarRespuestaError(contexto, resultado.response, { message: `Error crítico al leer la tabla esencial '${nombreTabla}': ${resultado.response?.message}` });
                } else {
                    console.warn(`readAllComunicados: No se pudo leer tabla opcional '${nombreTabla}'.`);
                    datosListas[nombreTabla] = [];
                }
            } else {
                datosListas[nombreTabla] = resultado.response.data || [];
            }
        }

        const parseNumeric = (value) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : null;
        };
        const timeZone = (typeof Session !== 'undefined' && Session.getScriptTimeZone) ? Session.getScriptTimeZone() : 'UTC';
        const formatDateValue = (value) => {
            if (value instanceof Date && !Number.isNaN(value.getTime?.())) {
                try { return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd'); } catch (e) { return String(value); }
            }
            return value === null || value === undefined ? '' : String(value);
        };

        const comunicadosPorId = mapeoPorCampo(datosListas.comunicados || [], 'id');
        const actualizacionesPorComunicado = (datosListas.actualizaciones || []).reduce((acc, item) => {
            if (!acc[item.idComunicado]) acc[item.idComunicado] = [];
            acc[item.idComunicado].push(item);
            return acc;
        }, {});

        // Helper para mapear IDs simples
        const cuentasPorId = mapeoPorCampo(datosListas.cuentas || [], 'id');
        const datosGeneralesPorComunicadoId = mapeoPorCampo(datosListas.datosGenerales || [], 'idComunicado');
        const estadosPorId = mapeoPorCampo(datosListas.estados || [], 'id');
        const distritosPorId = mapeoPorCampo(datosListas.distritosRiego || [], 'id');
        const siniestrosPorId = mapeoPorCampo(datosListas.siniestros || [], 'id');
        const empresasPorId = mapeoPorCampo(datosListas.empresas || [], 'id'); // Mapa de empresas para contratista

        const todosComunicados = (datosListas.comunicados || []).map(comunicado => {
            const datoGeneral = obtenerDesdeMapa(datosGeneralesPorComunicadoId, comunicado.id) || {};
            const cuenta = obtenerDesdeMapa(cuentasPorId, comunicado.idCuenta) || {};
            const estado = obtenerDesdeMapa(estadosPorId, datoGeneral.idEstado) || {};
            const distrito = obtenerDesdeMapa(distritosPorId, datoGeneral.idDR) || {};
            const siniestro = obtenerDesdeMapa(siniestrosPorId, datoGeneral.idSiniestro) || {};

            // 1. Calcular Presupuesto Vigente
            const actualizaciones = actualizacionesPorComunicado[comunicado.id] || [];
            let presupuestoVigente = 0;
            let supervision = 0;
            if (actualizaciones.length > 0) {
                // Ordenar por consecutivo descendente
                const ultima = actualizaciones.sort((a, b) => Number(b.consecutivo) - Number(a.consecutivo))[0];
                const mCapturado = parseFloat(ultima.montoCapturado);
                // Check explicitly against undefined/null strings because table data might be raw strings
                const montoStr = String(ultima.montoCapturado);
                const hasCapturado = !isNaN(mCapturado) && montoStr !== '' && montoStr !== 'null' && montoStr !== 'undefined';

                const base = hasCapturado ? mCapturado : (parseFloat(ultima.monto) || 0);
                // Asegurar que supervision no sea NaN (puede venir undefined de la BD)
                supervision = parseFloat(ultima.montoSupervisión) || 0;
                // Presupuesto solo contiene el monto de obra (base), NO la suma
                presupuestoVigente = base;
            }

            // 2. Obtener Contratista desde DatosGenerales.idEmpresa -> Empresas.razonSocial
            const empresa = obtenerDesdeMapa(empresasPorId, datoGeneral.idEmpresa);
            const nombreContratista = empresa ? (empresa.razonSocial || '') : '';

            return {
                id: parseNumeric(comunicado.id) ?? String(comunicado.id || '').trim(),
                idComunicado: parseNumeric(comunicado.id) ?? String(comunicado.id || '').trim(),
                idReferencia: parseNumeric(comunicado.idReferencia),
                idCuenta: parseNumeric(comunicado.idReferencia),
                cuenta: String(cuenta.cuenta || cuenta.referencia || cuenta.nombre || 'Cuenta Desconocida'),
                comunicado: String(comunicado.comunicado || ''),
                status: comunicado.status ?? '',
                descripcion: String(datoGeneral.descripcion || ''),
                fecha: formatDateValue(datoGeneral.fecha),
                idEstado: parseNumeric(datoGeneral.idEstado),
                estado: String(estado.estado || estado.nombre || ''),
                distrito: String(distrito.distritoRiego || distrito.nombre || ''),
                siniestro: String(siniestro.siniestro || siniestro.nombre || ''),
                fenomeno: String(siniestro.fenomeno || ''),
                fondo: String(siniestro.fondo || ''),
                fi: String(siniestro.fi || ''),
                idEmpresa: parseNumeric(datoGeneral.idEmpresa),
                contratista: nombreContratista || 'Sin Asignar',
                presupuesto: presupuestoVigente,
                montoSupervision: supervision || 0
            };
        }).sort((a, b) => {
            // Ordenar por fecha descendente
            const fechaA = a.fecha || '';
            const fechaB = b.fecha || '';
            return fechaB.localeCompare(fechaA);
        });

        return { success: true, data: todosComunicados, message: 'Todos los comunicados recuperados exitosamente' };

    } catch (error) {
        console.error('Error en readAllComunicados:', error);
        return crearRespuestaError(`Error al leer todos los comunicados: ${error.message}`, { source: contexto, error });
    }
}

/**
 * === ENRIQUECER COMUNICADO ===
 * Adjunta catálogos, empresa, aseguradora, presupuesto y datos extendidos a un comunicado
 */
/**
 * === ENRIQUECER COMUNICADO ===
 * Adjunta catálogos, empresa, aseguradora, presupuesto y datos extendidos a un comunicado
 */
function enriquecerComunicado(comunicado) {
    try {
        // Leer datos generales
        const datosGeneralesResult = buscarPorCampo('datosGenerales', 'idComunicado', comunicado.id);
        if (!datosGeneralesResult.success) {
            console.warn('enriquecerComunicado: error al leer datosGenerales', { comunicadoId: comunicado.id, message: datosGeneralesResult.message });
            return { ...comunicado, datosGenerales: null, error: datosGeneralesResult.message };
        }
        const datosGenerales = datosGeneralesResult.data;
        if (!datosGenerales) return { ...comunicado, datosGenerales: null };

        // Leer catálogos
        const estadoResult = buscarPorId('estados', datosGenerales.idEstado);
        const estado = estadoResult.success ? estadoResult.data : null;

        const distritoResult = buscarPorId('distritosRiego', datosGenerales.idDR);
        const distrito = distritoResult.success ? distritoResult.data : null;

        const siniestroResult = buscarPorId('siniestros', datosGenerales.idSiniestro);
        const siniestro = siniestroResult.success ? siniestroResult.data : null;

        // NUEVO: Leer aseguradora asociada al siniestro
        let aseguradoraSiniestro = null;
        if (siniestro && siniestro.idAseguradora) {
            const aseResult = buscarPorId('aseguradoras', siniestro.idAseguradora);
            aseguradoraSiniestro = aseResult.success ? aseResult.data : null;
        }

        // NUEVO: Leer ajustador (Prioridad: ID en Datos Generales o ID en Referencia)
        // 1. Intentar obtener ID desde Datos Generales
        let idAjustadorFinal = datosGenerales.idAjustador;

        // 2. Si no está en DG, intentar obtenerlo de la Referencia ("Cuenta")
        const cuentaResult = buscarPorId('cuentas', comunicado.idReferencia || comunicado.idCuenta);
        const cuentaObj = cuentaResult.success ? cuentaResult.data : null;

        if (!idAjustadorFinal && cuentaObj && cuentaObj.idAjustador) {
            idAjustadorFinal = cuentaObj.idAjustador;
        }

        let ajustador = null;
        if (idAjustadorFinal) {
            const ajustadorResult = buscarPorId('ajustadores', idAjustadorFinal);
            ajustador = ajustadorResult.success ? ajustadorResult.data : null;
        }

        // Leer actualización vigente
        let actualizacionVigente = null;
        let empresaActual = null;
        let aseguradoraActual = null;
        let presupuestoVigente = null;

        if (datosGenerales.idActualizacion) {
            const actualizacionResult = buscarPorId('actualizaciones', datosGenerales.idActualizacion);
            actualizacionVigente = actualizacionResult.success ? actualizacionResult.data : null;

            if (actualizacionVigente) {
                if (actualizacionVigente.idEmpresa) {
                    const empresaResult = buscarPorId('empresas', actualizacionVigente.idEmpresa);
                    empresaActual = empresaResult.success ? empresaResult.data : null;
                }
                if (actualizacionVigente.idAseguradora) {
                    const aseguradoraResult = buscarPorId('aseguradoras', actualizacionVigente.idAseguradora);
                    aseguradoraActual = aseguradoraResult.success ? aseguradoraResult.data : null;
                }

                // Buscar presupuesto vigente
                const presupuestosResponse = readAllRows('presupuestos');
                if (presupuestosResponse.success) {
                    presupuestoVigente = presupuestosResponse.data.find(p =>
                        String(p.idActualizacion) === String(actualizacionVigente.id) &&
                        Number(p.vigente) === 1
                    );

                    // Si hay presupuesto, agregar detalles
                    if (presupuestoVigente) {
                        const detallesResponse = readAllRows('detallePresupuesto');
                        if (detallesResponse.success) {
                            presupuestoVigente.detalles = detallesResponse.data.filter(d =>
                                String(d.idPresupuesto) === String(presupuestoVigente.id)
                            );
                        } else {
                            presupuestoVigente.detalles = [];
                        }
                    }
                }
            }
        }

        // --- NUEVOS DATOS ---
        // Equipo (Legacy y Supervisores)
        const equipoResponse = readAllRows('equipo');
        const equipo = equipoResponse.success ? equipoResponse.data.filter(e => String(e.idComunicado) === String(comunicado.id)) : [];

        // RELACION CONTRATISTAS (Nueva Lista Histórica)
        let relacionContratistas = [];
        const relacionResponse = readAllRows('relacionContratistas');
        if (relacionResponse.success) {
            const rels = relacionResponse.data.filter(r => String(r.idComunicado) === String(comunicado.id));

            // Enriquecer con Datos de Empresa
            const empresasResponse = readAllRows('empresas');
            const mapEmpresas = mapeoPorCampo(empresasResponse.success ? empresasResponse.data : [], 'id');

            relacionContratistas = rels.map(r => {
                const emp = obtenerDesdeMapa(mapEmpresas, r.idEmpresa);
                return {
                    id: r.id,
                    idEmpresa: r.idEmpresa,
                    nombreEmpresa: emp ? emp.razonSocial : 'Desconocida',
                    esVigente: Number(r.esVigente) === 1,
                    esContratista: Number(r.esContratista) === 1,
                    fechaAsignacion: r.fechaAsignacion
                };
            }).sort((a, b) => (b.esVigente - a.esVigente)); // Vigente primero
        }

        // Financiero
        const financieroResponse = readAllRows('estimaciones'); // Nota: Antes llamada financiero, ahora estimaciones
        const itemsFinancieros = financieroResponse.success ? financieroResponse.data.filter(f => String(f.idComunicado) === String(comunicado.id)) : [];

        // Cargar Facturas de Estimaciones y anidarlas
        const facturasEstResponse = readAllRows('facturasEstimaciones');
        const todasFacturasEst = facturasEstResponse.success ? facturasEstResponse.data : [];

        itemsFinancieros.forEach(est => {
            est.facturas = todasFacturasEst.filter(f => String(f.idEstimacion) === String(est.id));
        });

        const estimaciones = itemsFinancieros.filter(f => (f.entidad || 'CONSTRUCTORA') === 'CONSTRUCTORA');
        const facturas = readAllRows('facturas'); // Facturas generales legacy
        const facturasLegacy = facturas.success ? facturas.data.filter(f => String(f.idComunicado) === String(comunicado.id)) : [];

        // Estructura para el frontend
        const financieroCompleto = {
            estimaciones: itemsFinancieros
        };

        // Tickets
        const tickets = [];

        // --- ACTUALIZACIONES DE PRESUPUESTO ---
        const actualizacionesPresResponse = readAllRows('actualizaciones');
        let actualizacionesPresupuesto = [];

        // NUEVO: Leer líneas de desglose
        const lineasResponse = readAllRows('presupuestoLineas');
        const todasLasLineas = (lineasResponse.success && lineasResponse.data) ? lineasResponse.data : [];

        // NUEVO: Leer descripciones de líneas
        const descripcionesResponse = readAllRows('descripcionLineas');
        const todasLasDescripciones = (descripcionesResponse.success && descripcionesResponse.data) ? descripcionesResponse.data : [];

        // Mapa ID -> Descripción para acceso rápido
        const mapDescripciones = new Map();
        todasLasDescripciones.forEach(d => {
            mapDescripciones.set(String(d.id), d);
        });

        if (actualizacionesPresResponse.success && actualizacionesPresResponse.data) {
            actualizacionesPresupuesto = actualizacionesPresResponse.data
                .filter(a => String(a.idComunicado) === String(comunicado.id))
                .sort((a, b) => Number(a.consecutivo) - Number(b.consecutivo))
                .map(a => {
                    const misLineas = todasLasLineas.filter(l => String(l.idActualizacion) === String(a.id))
                        .map(l => {
                            const descObj = mapDescripciones.get(String(l.idLinea));
                            let catRaw = l.categoria || (descObj ? descObj.categoria : '') || '';
                            let catFinal = catRaw;
                            if (String(catRaw) === '1') catFinal = 'DAÑO FISICO';
                            if (String(catRaw) === '2') catFinal = 'DESAZOLVES';

                            return {
                                ...l,
                                descripcion: l.descripcion || (descObj ? descObj.descripcion : ''),
                                categoria: catFinal
                            };
                        })
                        .sort((x, y) => (Number(x.consecutivo) || 999999) - (Number(y.consecutivo) || 999999));

                    return {
                        id: a.id,
                        revision: a.esOrigen == 1 ? 'Origen' : (a.revision || ''),
                        fecha: a.fecha,
                        monto: a.monto || 0,
                        montoCapturado: (a.montoCapturado !== '' && a.montoCapturado !== null && a.montoCapturado !== undefined) ? Number(a.montoCapturado) : null,
                        montoSupervision: a.montoSupervisión || 0,
                        esOrigen: a.esOrigen == 1,
                        idPresupuesto: a.idPresupuesto || null,
                        lineas: misLineas
                    };
                });
        }

        return {
            id: comunicado.id,
            idReferencia: comunicado.idReferencia,
            idCuenta: comunicado.idReferencia,
            referencia: cuentaObj ? (cuentaObj.referencia || cuentaObj.cuenta || cuentaObj.nombre || String(comunicado.idReferencia)) : String(comunicado.idReferencia),
            cuenta: cuentaObj ? (cuentaObj.cuenta || cuentaObj.referencia || cuentaObj.nombre || String(comunicado.idReferencia)) : String(comunicado.idReferencia),
            cuentaNombre: cuentaObj ? (cuentaObj.nombre || cuentaObj.cuenta || '') : '',
            comunicado: comunicado.comunicado,
            status: comunicado.status,
            idSustituido: comunicado.idSustituido || null,

            // Datos generales
            idDatosGenerales: datosGenerales.id,
            descripcion: datosGenerales.descripcion || '',
            fecha: datosGenerales.fecha || '',
            fechaAsignacion: datosGenerales.fechaAsignacion || null,

            // Catálogos
            idEstado: datosGenerales.idEstado,
            estado: estado,
            estadoNombre: estado ? estado.estado : '',
            idDistritoRiego: datosGenerales.idDR,
            distrito: distrito,
            distritoNombre: distrito ? distrito.distritoRiego : '',
            idSiniestro: datosGenerales.idSiniestro,
            siniestro: siniestro,
            siniestroNombre: siniestro ? siniestro.siniestro : '',
            siniestroDetalle: siniestro ? {
                codigo: siniestro.siniestro,
                fenomeno: siniestro.fenomeno || '',
                fondo: siniestro.fondo || '',
                fi: siniestro.fi || '',
                idAseguradora: siniestro.idAseguradora || null,
                aseguradora: aseguradoraSiniestro ? (aseguradoraSiniestro.aseguradora || aseguradoraSiniestro.nombre || '') : ''
            } : null,
            // NUEVO: Ajustador (Prioridad: DatosGenerales > Referencia)
            idAjustador: datosGenerales.idAjustador || (cuentaObj ? cuentaObj.idAjustador : null),
            ajustador: ajustador,
            ajustadorNombre: ajustador ? (ajustador.nombreAjustador || ajustador.nombre) : 'Sin Ajustador',

            // Actualización y empresa
            idActualizacion: datosGenerales.idActualizacion,
            actualizacionVigente: actualizacionVigente,
            idEmpresa: actualizacionVigente ? actualizacionVigente.idEmpresa : null,
            empresa: empresaActual,
            empresaNombre: empresaActual ? empresaActual.razonSocial : '',
            idAseguradora: actualizacionVigente ? actualizacionVigente.idAseguradora : null,
            aseguradora: aseguradoraActual,
            aseguradoraNombre: aseguradoraActual ? aseguradoraActual.descripcion : '',

            // Presupuesto
            presupuestoVigente: presupuestoVigente,
            presupuestoTotal: presupuestoVigente ? presupuestoVigente.total : null,
            presupuesto: actualizacionesPresupuesto,

            // Nuevos Tabs
            equipo: equipo, // Legacy y Supervisores
            relacionContratistas: relacionContratistas, // Nueva Lista
            financiero: financieroCompleto,
            estimaciones: estimaciones, // Para compatibilidad
            facturas: facturasLegacy, // Para compatibilidad
            tickets: tickets,

            // Objeto completo de datos generales
            datosGenerales: datosGenerales
        };

    } catch (error) {
        console.error('Error en enriquecerComunicado:', error);
        return { ...comunicado, error: error.message, datosGenerales: null };
    }
}

/**
 * === ASIGNAR CONTRATISTA ===
 * Registra una relación de empresa contratista y actualiza el vigente
 */
function asignarContratista(idComunicado, idEmpresa) {
    const contexto = 'asignarContratista';
    try {
        if (!idComunicado || !idEmpresa) return crearRespuestaError('Faltan argumentos', { source: contexto });

        // 1. Desactivar vigencia de otros
        const currentRels = readAllRows('relacionContratistas');
        if (currentRels.success) {
            const rels = currentRels.data.filter(r => String(r.idComunicado) === String(idComunicado));
            rels.forEach(r => {
                if (Number(r.esVigente) === 1) {
                    updateRow('relacionContratistas', r.id, { esVigente: 0 });
                }
            });

            // 2. Verificar si ya existe la relacion con esta empresa
            const existingRel = rels.find(r => String(r.idEmpresa) === String(idEmpresa));
            if (existingRel) {
                // Reactivar
                updateRow('relacionContratistas', existingRel.id, {
                    esVigente: 1
                });
            } else {
                // Crear nueva
                createRow('relacionContratistas', {
                    idComunicado: idComunicado,
                    idEmpresa: idEmpresa,
                    esContratista: 1,
                    esVigente: 1,
                    fechaAsignacion: new Date()
                });
            }
        }

        // 3. Actualizar Datos Generales (Puntero maestro)
        const dgRes = buscarPorCampo('datosGenerales', 'idComunicado', idComunicado);
        if (dgRes.success && dgRes.data) {
            updateRow('datosGenerales', dgRes.data.id, { idEmpresa: idEmpresa });
        }

        return { success: true, message: 'Contratista asignado correctamente' };
    } catch (e) {
        return crearRespuestaError(e.message, { source: contexto });
    }
}

/**
 * === DESVINCULAR CONTRATISTA ===
 * Elimina la vigencia y el puntero en datos generales
 */
function desvincularContratista(idComunicado, idRelacion) {
    const contexto = 'desvincularContratista';
    try {
        const relRes = buscarPorId('relacionContratistas', idRelacion);
        if (!relRes.success) return relRes;

        const rel = relRes.data;

        // Quitar vigencia (Soft Delete de la relacion activa)
        updateRow('relacionContratistas', idRelacion, { esVigente: 0 });

        // Si era la vigente, limpiar datos generales
        if (Number(rel.esVigente) === 1) {
            const dgRes = buscarPorCampo('datosGenerales', 'idComunicado', idComunicado);
            if (dgRes.success && dgRes.data) {
                // Solo limpiar si coincide (doble check)
                if (String(dgRes.data.idEmpresa) === String(rel.idEmpresa)) {
                    updateRow('datosGenerales', dgRes.data.id, { idEmpresa: '' }); // Limpiar
                }
            }
        }

        return { success: true, message: 'Contratista desvinculado.' };
    } catch (e) {
        return crearRespuestaError(e.message, { source: contexto });
    }
}

/**
 * === ACTUALIZAR COMUNICADO ===
 * Actualiza los datos de un comunicado existente
 */
function updateComunicado(id, updates) {
    const contexto = 'updateComunicado';
    try {
        const comunicadoId = String(id || '').trim();
        if (!comunicadoId) {
            return crearRespuestaError('Se requiere el ID del comunicado', { source: contexto });
        }

        // 1. Validar existencia
        const comunicadoResult = buscarPorId('comunicados', comunicadoId);
        if (!comunicadoResult.success) {
            return propagarRespuestaError(contexto, comunicadoResult);
        }
        const datosGeneralesResult = buscarPorCampo('datosGenerales', 'idComunicado', comunicadoId);
        if (!datosGeneralesResult.success) {
            return propagarRespuestaError(contexto, datosGeneralesResult);
        }
        const datosGenerales = datosGeneralesResult.data;
        const comunicado = comunicadoResult.data;

        // 2. BUSCAR ENTIDADES RELACIONADAS (Cuenta y Siniestro)
        const cuentaResult = buscarPorId('cuentas', comunicado.idReferencia);
        if (!cuentaResult.success) console.warn('Cuenta no encontrada para actualizar ajustador');
        const cuenta = cuentaResult.data;

        // --- LÓGICA DE ACTUALIZACIÓN EN CADENA ---

        // A) GESTIÓN DE AJUSTADOR (Ajustador -> Referencia)
        if (updates.ajustador) {
            const nombreAjustador = String(updates.ajustador).trim().toUpperCase();
            if (nombreAjustador) {
                // 1. Asegurar catálogo Ajustadores
                const ajResult = ensureCatalogRecord('ajustadores', { nombreAjustador: nombreAjustador });
                if (ajResult.success && ajResult.data.id) {
                    // 2. Actualizar Referencia (Tabla Cuentas) si existe
                    if (cuenta) {
                        actualizarRegistro('cuentas', cuenta.id, { idAjustador: ajResult.data.id });
                    }
                    // Opcional: Actualizar idAjustador en datosGenerales (redundancia útil)
                    updates.idAjustador = ajResult.data.id;
                }
            }
        }

        // B) GESTIÓN DE ASEGURADORA (Aseguradora -> Siniestro)
        let idSiniestroFinal = datosGenerales.idSiniestro; // ID actual

        // Primero revisamos si hay cambio de Siniestro explícito (el usuario seleccionó otro)
        if (updates.siniestro) {
            const sinResult = ensureCatalogRecord('siniestros', { siniestro: String(updates.siniestro).trim().toUpperCase() });
            if (sinResult.success && sinResult.data && sinResult.data.id) {
                idSiniestroFinal = sinResult.data.id;

                // Actualizar detalles del siniestro si se proporcionan
                const updatesSiniestro = {};
                if (updates.fenomeno !== undefined) updatesSiniestro.fenomeno = String(updates.fenomeno).toUpperCase();
                if (updates.fondo !== undefined) updatesSiniestro.fondo = String(updates.fondo).toUpperCase();
                if (updates.fi !== undefined) updatesSiniestro.fi = String(updates.fi).toUpperCase();

                if (Object.keys(updatesSiniestro).length > 0) {
                    actualizarRegistro('siniestros', idSiniestroFinal, updatesSiniestro);
                }
            }
        }

        // Luego revisamos si hay cambio de Aseguradora
        if (updates.aseguradora) {
            const nombreAseg = String(updates.aseguradora).trim().toUpperCase();
            if (nombreAseg && idSiniestroFinal) {
                // 1. Asegurar catálogo Aseguradoras
                const aseResult = ensureCatalogRecord('aseguradoras', { aseguradora: nombreAseg });
                if (aseResult.success && aseResult.data && aseResult.data.id) {
                    // 2. Actualizar Tabla Siniestros
                    actualizarRegistro('siniestros', idSiniestroFinal, { idAseguradora: aseResult.data.id });
                }
            }
        }

        // C) ACTUALIZAR COMUNICADO (Tabla principal)
        if (updates.comunicado) {
            const updateComResult = actualizarRegistro('comunicados', comunicadoId, { comunicado: updates.comunicado });
            if (!updateComResult.success) {
                return propagarRespuestaError(contexto, updateComResult);
            }
        }

        // D) ACTUALIZAR DATOS GENERALES
        const updatesDatosGenerales = {};
        if (updates.descripcion) updatesDatosGenerales.descripcion = updates.descripcion;
        if (updates.fecha) updatesDatosGenerales.fecha = updates.fecha;
        if (updates.idEstado) updatesDatosGenerales.idEstado = updates.idEstado;
        if (updates.idAjustador) updatesDatosGenerales.idAjustador = updates.idAjustador;
        if (idSiniestroFinal) updatesDatosGenerales.idSiniestro = idSiniestroFinal;

        // Manejo de Distrito
        if (updates.distrito) {
            const distritoResult = ensureCatalogRecord('distritosRiego', { distritoRiego: updates.distrito });
            if (distritoResult.success && distritoResult.data && distritoResult.data.id) {
                updatesDatosGenerales.idDR = distritoResult.data.id;
            }
        }

        if (Object.keys(updatesDatosGenerales).length > 0) {
            const updateDGResult = actualizarRegistro('datosGenerales', datosGenerales.id, updatesDatosGenerales);
            if (!updateDGResult.success) {
                return propagarRespuestaError(contexto, updateDGResult);
            }
        }

        // 3. Actualizar Equipo
        if (updates.equipo) {
            _syncChildTable('equipo', 'idComunicado', comunicadoId, updates.equipo);
        }

        // 4. Actualizar Financiero
        if (updates.financiero) {
            const estimaciones = (updates.financiero.estimaciones || []).map(e => ({ ...e, tipo: 'estimacion' }));
            const facturas = (updates.financiero.facturas || []).map(f => ({ ...f, tipo: 'factura' }));
            const allFinanciero = [...estimaciones, ...facturas];
            _syncChildTable('financiero', 'idComunicado', comunicadoId, allFinanciero);
        }

        // 5. Actualizar Tickets
        if (updates.tickets) {
            _syncChildTable('tickets', 'idComunicado', comunicadoId, updates.tickets);
        }

        // 6. Actualizar Estimaciones (NUEVO - Persistencia Inteligente con Dependencias)
        if (updates.estimaciones && Array.isArray(updates.estimaciones)) {
            // Ordenar: Constructoras primero, Supervisiones después para resolver dependencias de IDs
            const sortedEstimaciones = [...updates.estimaciones].sort((a, b) => {
                const aIsSup = a.tipo === 'SUPERVISION';
                const bIsSup = b.tipo === 'SUPERVISION';
                if (aIsSup === bIsSup) return 0;
                return aIsSup ? 1 : -1; // Supervisión al final
            });

            _syncEstimacionesSmart(comunicadoId, sortedEstimaciones);
        }

        // 6. Actualizar Presupuesto
        if (updates.presupuesto) {
            _handlePresupuestoUpdate(comunicadoId, datosGenerales, updates.presupuesto);
        }

        // F) ACTUALIZACIÓN DE EQUIPO (Contratistas y Supervisores)
        if (updates.equipo && Array.isArray(updates.equipo)) {
            // 1. Auto-crear empresas para contratistas nuevos
            const equipoProcesado = updates.equipo.map(item => {
                const itemProcesado = { ...item, idComunicado: comunicadoId };

                if (item.tipo === 'contratista' && item.nombre) {
                    const nombreEmpresa = String(item.nombre).trim().toUpperCase();
                    if (nombreEmpresa) {
                        const empResult = ensureCatalogRecord('empresas', { razonSocial: nombreEmpresa });
                        if (empResult.success) {
                            // Normalizar nombre con el del catálogo
                            itemProcesado.nombre = empResult.data.razonSocial;
                        }
                    }
                }
                return itemProcesado;
            });

            // 2. Sincronizar tabla Equipo
            _syncChildTable('equipo', 'idComunicado', comunicadoId, equipoProcesado);
        }

        // G) ACTUALIZACIÓN DE TICKETS
        if (updates.tickets && Array.isArray(updates.tickets)) {
            const ticketsProcesados = updates.tickets.map(t => ({
                idComunicado: comunicadoId,
                tipo: 'ticket', // Default
                fecha: t.fecha || new Date().toISOString(),
                numero: t.numero,
                asunto: t.asunto,
                estado: t.estado
            }));
            // Asumiendo tabla tickets existe y tiene estructura compatible
            _syncChildTable('tickets', 'idComunicado', comunicadoId, ticketsProcesados);
        }

        return { success: true, message: 'Comunicado actualizado correctamente' };

    } catch (error) {
        console.error('Error en updateComunicado:', error);
        return crearRespuestaError(`Error al actualizar comunicado: ${error.message}`, { source: contexto, error, details: { id } });
    }
}


/**
 * Sincroniza una tabla hija de forma INTELIGENTE (Upsert + Delete).
 * Preserva los IDs de registros existentes para no romper relaciones (ej: Facturas -> Estimaciones).
 */
function _syncChildTableSmart(tableName, foreignKeyField, foreignKeyValue, dataArray) {
    const contexto = `_syncChildTableSmart(${tableName})`;
    try {
        console.log(`[${contexto}] Iniciando sync para FK ${foreignKeyField}=${foreignKeyValue}. Items: ${dataArray.length}`);

        // 1. Leer existentes
        const response = readAllRows(tableName);
        const existentes = (response.success && response.data) ?
            response.data.filter(row => String(row[foreignKeyField]) === String(foreignKeyValue)) : [];

        const existentesMap = new Map(existentes.map(e => [String(e.id), e]));
        const procesadosIds = new Set();

        // 2. Upsert (Actualizar o Insertar)
        dataArray.forEach(item => {
            // Asegurar que el item tenga el FK correcto
            const itemToSave = { ...item };
            itemToSave[foreignKeyField] = foreignKeyValue;

            // Campos de auditoría/control internos no deben ir a BD si no existen columnas (limpieza básica opcional)
            delete itemToSave._isNew;
            delete itemToSave._modified;

            if (item.id && existentesMap.has(String(item.id))) {
                // ACTUALIZAR
                // Solo si hay cambios reales deberíamos actualizar, pero por simplicidad actualizamos
                actualizarRegistro(tableName, item.id, itemToSave);
                procesadosIds.add(String(item.id));
            } else {
                // INSERTAR
                // Si trae un ID temporal o no trae, se crea nuevo.
                // Aseguramos no enviar 'id' si es temporal para que el backend genere uno nuevo
                if (String(item.id).startsWith('new_') || String(item.id).startsWith('temp_')) {
                    delete itemToSave.id;
                }
                // Si no tiene id, delete itemToSave.id es inocuo

                // Caso especial: Si viene sin ID pero queremos insertarlo.
                if (!itemToSave.fechaCreacion) itemToSave.fechaCreacion = new Date(); // Timestamp basico

                const res = insertarRegistro(tableName, itemToSave);
                if (res.success && res.data && res.data.id) {
                    // Podríamos devolver el mapeo ID temp -> ID real si fuera necesario
                }
            }
        });

        // 3. Delete (Los que estaban en BD pero no vinieron en dataArray)
        existentes.forEach(existente => {
            if (!procesadosIds.has(String(existente.id))) {
                console.log(`[${contexto}] Eliminando registro huérfano ID: ${existente.id}`);
                eliminarRegistro(tableName, existente.id);
            }
        });

    } catch (e) {
        console.error(`Error en ${contexto}:`, e);
        throw e;
    }
}

function getComunicadoCompleto(id) {
    const contexto = 'getComunicadoCompleto';
    console.log(`[${contexto}] Iniciando solicitud para ID: ${id}`);
    try {
        const comunicadoId = String(id || '').trim();
        if (!comunicadoId) {
            console.warn(`[${contexto}] ID no proporcionado.`);
            return crearRespuestaError('Se requiere el ID del comunicado', { source: contexto });
        }

        const comunicadoResult = buscarPorId('comunicados', comunicadoId);
        if (!comunicadoResult.success) {
            console.warn(`[${contexto}] No se encontró el comunicado con ID: ${comunicadoId}`);
            return propagarRespuestaError(contexto, comunicadoResult);
        }

        const comunicadoEnriquecido = enriquecerComunicado(comunicadoResult.data);

        // Agregar timestamp para verificar frescura
        comunicadoEnriquecido._ts = new Date().toISOString();

        const response = { success: true, data: comunicadoEnriquecido };
        const sanitizedResponse = JSON.parse(JSON.stringify(response));

        console.log(`[${contexto}] Respuesta generada exitosamente para ID: ${comunicadoId}`);
        return sanitizedResponse;

    } catch (error) {
        console.error(`Error en ${contexto}:`, error);
        return crearRespuestaError(`Error al obtener comunicado completo: ${error.message}`, { source: contexto, error, details: { id } });
    }
}

/**
 * Sincronización específica para ESTIMACIONES que maneja dependencias de IDs temporales
 * (Ej: Supervisión vinculada a una Constructora nueva creada en el mismo lote)
 */
function _syncEstimacionesSmart(comunicadoId, dataArray) {
    const contexto = `_syncEstimacionesSmart`;
    const tableName = 'estimaciones';
    const foreignKeyField = 'idComunicado';
    const foreignKeyValue = comunicadoId;

    try {
        console.log(`[${contexto}] Inicio. Items: ${dataArray.length}`);

        // 1. Leer existentes
        const response = readAllRows(tableName);
        const existentes = (response.success && response.data) ?
            response.data.filter(row => String(row[foreignKeyField]) === String(foreignKeyValue)) : [];

        const existentesMap = new Map(existentes.map(e => [String(e.id), e]));
        const procesadosIds = new Set();

        // Mapa para resolver IDs temporales (TempID -> RealID)
        const tempIdMap = new Map();

        // 2. Procesar secuencialmente (importante el orden pre-establecido)
        dataArray.forEach(item => {
            const itemToSave = { ...item };
            itemToSave[foreignKeyField] = foreignKeyValue;

            // Limpieza
            delete itemToSave._isNew;
            delete itemToSave._modified;

            const idOriginal = String(item.id);
            const esTemp = idOriginal.startsWith('new_') || idOriginal.startsWith('temp_') || idOriginal.startsWith('temp-');

            // Resolver dependencia de vinculación si existe
            if (itemToSave.idEstimacionVinculada) {
                const vincId = String(itemToSave.idEstimacionVinculada);
                if (tempIdMap.has(vincId)) {
                    itemToSave.idEstimacionVinculada = tempIdMap.get(vincId);
                    console.log(`[${contexto}] Mapeado FK temporal ${vincId} -> ${itemToSave.idEstimacionVinculada}`);
                }
            }

            if (!esTemp && existentesMap.has(idOriginal)) {
                // UPDATE
                actualizarRegistro(tableName, idOriginal, itemToSave);
                procesadosIds.add(idOriginal);
            } else {
                // INSERT
                if (esTemp) delete itemToSave.id; // Dejar que DB asigne ID
                if (!itemToSave.fechaCreacion) itemToSave.fechaCreacion = new Date();

                const res = insertarRegistro(tableName, itemToSave);
                if (res.success && res.data && res.data.id) {
                    const newId = String(res.data.id);
                    if (esTemp) {
                        tempIdMap.set(idOriginal, newId);

                        // FIX: Re-link orphaned Facturas that point to this temp ID
                        try {
                            const facturasRes = readAllRows('facturasEstimaciones');
                            if (facturasRes.success && facturasRes.data) {
                                const huerfanas = facturasRes.data.filter(f => String(f.idEstimacion) === idOriginal);
                                huerfanas.forEach(h => {
                                    actualizarRegistro('facturasEstimaciones', h.id, { idEstimacion: newId });
                                    console.log(`[${contexto}] Revalidando Factura ${h.id}: Temp ${idOriginal} -> Real ${newId}`);
                                });
                            }

                            // FIX: Re-link orphaned Bitacora entries
                            const bitacoraRes = readAllRows('bitacoraEstimaciones');
                            if (bitacoraRes.success && bitacoraRes.data) {
                                const huerfanasB = bitacoraRes.data.filter(b => String(b.idEstimacion) === idOriginal);
                                huerfanasB.forEach(b => {
                                    actualizarRegistro('bitacoraEstimaciones', b.id, { idEstimacion: newId });
                                });
                            }
                        } catch (errLink) {
                            console.warn(`[${contexto}] Error re-linking orphans for ${idOriginal}: ${errLink.message}`);
                        }
                    }
                }
            }
        });

        // 3. Delete Huérfanos
        existentes.forEach(existente => {
            if (!procesadosIds.has(String(existente.id))) {
                console.log(`[${contexto}] Eliminando estimación huérfana ID: ${existente.id}`);
                eliminarRegistro(tableName, existente.id);
            }
        });

    } catch (e) {
        console.error(`Error en ${contexto}:`, e);
        throw e;
    }
}

function _syncChildTable(tableName, foreignKeyField, foreignKeyValue, dataArray) {
    try {
        // 1. Leer todos
        const response = readAllRows(tableName);
        if (response.success && response.data) {
            // 2. Filtrar los que pertenecen a este padre
            const toDelete = response.data.filter(row => String(row[foreignKeyField]) === String(foreignKeyValue));

            // 3. Borrar
            toDelete.forEach(row => {
                eliminarRegistro(tableName, row.id);
            });
        }

        // 4. Insertar nuevos
        dataArray.forEach(item => {
            const newItem = { ...item };
            newItem[foreignKeyField] = foreignKeyValue;
            delete newItem.id; // Asegurar que se genere nuevo ID
            insertarRegistro(tableName, newItem);
        });
    } catch (e) {
        console.error(`Error syncing table ${tableName}:`, e);
        throw e;
    }
}

/**
 * Maneja la sincronización de actualizaciones de presupuesto.
 * Cada actualización (Origen, A, B, etc.) se guarda como un registro en la tabla Actualizaciones.
 *
 * @param {number} comunicadoId - ID del comunicado
 * @param {Object} datosGenerales - Datos generales del comunicado
 * @param {Array} presupuestoItems - Array de actualizaciones de presupuesto desde el frontend
 */
function _handlePresupuestoUpdate(comunicadoId, datosGenerales, presupuestoItems) {
    if (!presupuestoItems || !Array.isArray(presupuestoItems)) {
        return;
    }

    try {
        // 1. Obtener actualizaciones existentes para este comunicado
        const allActualizaciones = readAllRows('actualizaciones');
        const existentes = (allActualizaciones.success && allActualizaciones.data) ?
            allActualizaciones.data.filter(a => String(a.idComunicado) === String(comunicadoId)) : [];

        // 2. Mapear por consecutivo para identificar actualizaciones vs inserciones
        const existentesMap = new Map();
        existentes.forEach(e => {
            existentesMap.set(Number(e.consecutivo), e);
        });

        // 3. Procesar cada item del frontend
        presupuestoItems.forEach((item, index) => {
            const consecutivo = index + 1; // 1-based
            const esOrigen = index === 0;
            const revision = esOrigen ? 'Origen' : (item.revision || '');

            const registro = {
                idComunicado: comunicadoId,
                consecutivo: consecutivo,
                esOrigen: esOrigen ? 1 : 0,
                revision: revision,
                monto: parseFloat(item.montoCalculado) || parseFloat(item.monto) || 0,
                montoCapturado: (item.montoCapturado && parseFloat(item.montoCapturado) !== 0) ? parseFloat(item.montoCapturado) : null,
                montoSupervisión: parseFloat(item.montoSupervision) || 0,
                idPresupuesto: item.idPresupuesto || null,
                fecha: item.fecha || new Date().toISOString()
            };

            const existente = existentesMap.get(consecutivo);
            let actualizacionId = null;

            if (existente) {
                // Actualizar registro existente
                actualizarRegistro('actualizaciones', existente.id, registro);
                existentesMap.delete(consecutivo); // Marcar como procesado
                actualizacionId = existente.id;
            } else {
                // Insertar nuevo registro
                const insertResult = insertarRegistro('actualizaciones', registro);
                if (insertResult.success && insertResult.data) {
                    actualizacionId = insertResult.data.id;
                }
            }

            // LÓGICA DELTA PARA LÍNEAS (Manual Entry)
            // Preserva idLinea y maneja esVigente correctamente
            if (actualizacionId && Array.isArray(item.lineas)) {
                _syncLineasConDelta(comunicadoId, actualizacionId, item.lineas, item._tipoAccion, existente);
            }
        });

        // 4. Eliminar actualizaciones que ya no existen en el frontend
        existentesMap.forEach((antiguo, consecutivo) => {
            // SEGURIDAD: Borrado en Cascada (Hijos)
            // Borra todas las líneas asociadas a esta actualización huérfana
            _syncChildTable('presupuestoLineas', 'idActualizacion', antiguo.id, []);

            // Borrado del Padre
            eliminarRegistro('actualizaciones', antiguo.id);
        });

    } catch (error) {
        console.error('Error en _handlePresupuestoUpdate:', error);
        throw error;
    }
}

/**
 * NUEVA FUNCIÓN: Sincroniza líneas de presupuesto usando lógica DELTA
 * Preserva idLinea y maneja esVigente correctamente
 * NO MODIFICA la lógica de importación IA - solo para entrada manual
 * 
 * @param {number} comunicadoId - ID del comunicado
 * @param {number} actualizacionId - ID de la actualización actual
 * @param {Array} lineasNuevas - Líneas desde el frontend
 * @param {string} tipoAccion - INFORMATIVO, ACTUALIZACION, SUSTITUCION_TOTAL
 * @param {Object} existenteAct - Actualización existente si es update
 */
function _syncLineasConDelta(comunicadoId, actualizacionId, lineasNuevas, tipoAccion, existenteAct) {
    if (!lineasNuevas || !Array.isArray(lineasNuevas)) return;

    try {
        // 1. Leer líneas existentes para esta actualización
        const allLineas = readAllRows('presupuestoLineas');
        const lineasExistentes = (allLineas.success && allLineas.data) ?
            allLineas.data.filter(l => String(l.idActualizacion) === String(actualizacionId)) : [];

        // 2. Crear mapa de líneas existentes por idLinea
        const existentesMap = new Map();
        lineasExistentes.forEach(l => {
            if (l.idLinea) existentesMap.set(String(l.idLinea), l);
        });

        // 3. Procesar cada línea nueva
        lineasNuevas.forEach(linea => {
            const idLinea = linea.idLinea;
            const importe = parseFloat(linea.importe) || 0;
            const categoria = linea.categoria || 1;

            // Si tiene idLinea, verificar si ya existe
            if (idLinea && existentesMap.has(String(idLinea))) {
                const existente = existentesMap.get(String(idLinea));
                const importeExistente = parseFloat(existente.importe) || 0;

                // Si el importe cambió, actualizar
                if (Math.abs(importe - importeExistente) > 0.01) {
                    actualizarRegistro('presupuestoLineas', existente.id, {
                        importe: importe,
                        categoria: categoria,
                        esVigente: true
                    });
                }
                existentesMap.delete(String(idLinea)); // Marcar como procesado
            } else {
                // Insertar nueva línea
                insertarRegistro('presupuestoLineas', {
                    idActualizacion: actualizacionId,
                    idLinea: idLinea || null, // Preservar o null si es nueva
                    categoria: categoria,
                    importe: importe,
                    esVigente: true,
                    fechaCreacion: new Date()
                });
            }
        });

        // 4. Líneas huérfanas: Si tipo es SUSTITUCION_TOTAL, marcar como no vigentes
        if (tipoAccion === 'SUSTITUCION_TOTAL') {
            existentesMap.forEach((linea) => {
                actualizarRegistro('presupuestoLineas', linea.id, { esVigente: false });
            });
        }

    } catch (error) {
        console.error('Error en _syncLineasConDelta:', error);
        throw error;
    }
}

/**
 * Crea una referencia y un comunicado asociado en una sola transacción lógica.
 * Utilizado por el modal de "Alta Express".
 * @param {object} datosReferencia - { referencia: '...', idAjustador: ... }
 * @param {object} datosComunicado - { comunicado: '...', fecha: ..., ... }
 */
function crearReferenciaConComunicado(datosReferencia, datosComunicado) {
    const contexto = 'crearReferenciaConComunicado';

    // 1. Crear Referencia
    const refResp = createRow('cuentas', datosReferencia);
    if (!refResp.success) {
        return propagarRespuestaError(contexto, refResp, { message: 'Error al crear la referencia.' });
    }

    const nuevaCuentaId = refResp.data.id;

    // 2. Preparar datos del comunicado con el ID de la nueva cuenta
    datosComunicado.idCuenta = nuevaCuentaId;

    // 3. Crear Comunicado
    const comResp = createComunicado(datosComunicado);

    if (!comResp.success) {
        // Rollback: intentar borrar la referencia creada para mantener consistencia
        console.warn(`[${contexto}] Falló creación de comunicado. Revirtiendo referencia ${nuevaCuentaId}...`);
        try {
            deleteRow('cuentas', nuevaCuentaId);
        } catch (e) {
            console.error(`[${contexto}] Error en rollback de referencia:`, e);
        }

        return propagarRespuestaError(contexto, comResp, {
            message: `Error al crear comunicado: ${comResp.message}. La referencia no se guardó.`
        });
    }

    return {
        success: true,
        data: {
            cuenta: refResp.data,
            comunicado: comResp.data
        },
        message: 'Referencia y comunicado creados correctamente.'
    };
}

/**
 * === ALTA EXPRESS COMPLETA ===
 * Orquesta la creación en cadena de: Ajustador -> Referencia -> Comunicado -> Detalles
 * Maneja la creación condicional de catálogos si son nuevos.
 */
function procesarAltaExpress(payload) {
    const contexto = 'procesarAltaExpress';
    console.log(`[${contexto}] Iniciando con payload:`, JSON.stringify(payload));

    try {
        // 1. GESTIÓN DE AJUSTADOR
        let idAjustador = payload.ajustador?.id;
        const nombreAjustador = String(payload.ajustador?.nombre || '').trim().toUpperCase();

        if (!idAjustador && nombreAjustador) {
            // Verificar o crear ajustador usando ensureCatalogRecord (debe estar disponible globalmente)
            // Si ensureCatalogRecord no soporta 'ajustadores' por defecto, usamos lógica manual o asumimos soporte.
            // Asumimos que ajustadores tiene campo 'nombreAjustador' según TABLE_DEFINITIONS.
            const ajResult = ensureCatalogRecord('ajustadores', { nombreAjustador: nombreAjustador });
            if (!ajResult.success) return propagarRespuestaError(contexto, ajResult);
            idAjustador = ajResult.data.id;
        }

        if (!idAjustador) return crearRespuestaError('Se requiere un ajustador válido', { source: contexto });

        // 2. GESTIÓN DE CUENTA / REFERENCIA
        let idCuenta = payload.cuenta?.id;
        const nombreCuenta = String(payload.cuenta?.nombre || '').trim().toUpperCase();

        if (!idCuenta && nombreCuenta) {
            // Verificar si ya existe por nombre para evitar duplicados manuales
            const cuentasResp = readAllRows('cuentas');
            const existente = cuentasResp.success ? cuentasResp.data.find(c => normalizarClave(c.cuenta) === normalizarClave(nombreCuenta) || normalizarClave(c.referencia) === normalizarClave(nombreCuenta)) : null;

            if (existente) {
                idCuenta = existente.id;
            } else {
                // Crear nueva cuenta ligada al ajustador
                const nuevaCuenta = {
                    cuenta: nombreCuenta, // O referencia
                    referencia: nombreCuenta,
                    idAjustador: idAjustador,
                    fechaAlta: new Date()
                };
                const cuentaResult = createRow('cuentas', nuevaCuenta);
                if (!cuentaResult.success) return propagarRespuestaError(contexto, cuentaResult);
                idCuenta = cuentaResult.data.id;
            }
        }

        if (!idCuenta) return crearRespuestaError('Se requiere una referencia válida', { source: contexto });

        // 3. GESTIÓN DE DISTRITO
        const distritoNombre = String(payload.ubicacion?.distritoNombre || '').trim().toUpperCase();
        const distritoResult = ensureCatalogRecord('distritosRiego', { distritoRiego: distritoNombre });
        if (!distritoResult.success) return propagarRespuestaError(contexto, distritoResult);
        const idDistrito = distritoResult.data.id;

        // 4. GESTIÓN DE SINIESTRO
        let idAseguradora = payload.siniestro?.idAseguradora;
        const nombreAseguradora = String(payload.siniestro?.nombreAseguradora || '').trim().toUpperCase();

        if (!idAseguradora && nombreAseguradora) {
            const asegResult = ensureCatalogRecord('aseguradoras', { aseguradora: nombreAseguradora });
            if (!asegResult.success) return propagarRespuestaError(contexto, asegResult);
            idAseguradora = asegResult.data.id;
        }

        const siniestroNombre = String(payload.siniestro?.nombre || '').trim().toUpperCase();
        const siniestroData = {
            siniestro: siniestroNombre,
            fenomeno: payload.siniestro?.fenomeno || '',
            fi: payload.siniestro?.fi || '',
            fondo: payload.siniestro?.fondo || '',
            idAseguradora: idAseguradora || ''
        };
        const siniestroResult = ensureCatalogRecord('siniestros', siniestroData);
        if (!siniestroResult.success) return propagarRespuestaError(contexto, siniestroResult);
        const idSiniestro = siniestroResult.data.id;

        // 5. CREACIÓN DE COMUNICADO
        // Nota: createRow calcula el ID automáticamente si no se pasa.
        const comunicadoNombre = String(payload.comunicado?.nombre || '').trim();
        const descripcion = String(payload.comunicado?.descripcion || '').trim();
        const fecha = payload.comunicado?.fecha;
        const idEstado = payload.ubicacion?.estadoId;

        // Validar duplicado
        const todosComunicados = readAllRows('comunicados');
        if (todosComunicados.success) {
            const duplicado = todosComunicados.data.find(c =>
                String(c.idReferencia) === String(idCuenta) &&
                normalizarClave(c.comunicado) === normalizarClave(comunicadoNombre)
            );
            if (duplicado) {
                return crearRespuestaError(`El comunicado ${comunicadoNombre} ya existe en esta referencia.`, { source: contexto });
            }
        }

        const createComResult = createRow('comunicados', {
            idReferencia: idCuenta,
            comunicado: comunicadoNombre,
            status: 1
        });

        if (!createComResult.success) return propagarRespuestaError(contexto, createComResult);
        const idComunicadoCreado = createComResult.data.id;

        // 6. CREACIÓN DATOS GENERALES
        const datosGen = {
            idComunicado: idComunicadoCreado,
            descripcion: descripcion,
            fecha: fecha,
            idEstado: idEstado,
            idDR: idDistrito,
            idSiniestro: idSiniestro,
            idAjustador: idAjustador
        };

        const createDGResult = createRow('datosGenerales', datosGen);

        if (!createDGResult.success) {
            // Intento de limpieza (opcional, arriesgado si falla)
            eliminarRegistro('comunicados', idComunicadoCreado);
            return propagarRespuestaError(contexto, createDGResult);
        }

        return {
            success: true,
            message: `Alta Express completada. Referencia: ${nombreCuenta}`,
            data: {
                idComunicado: idComunicadoCreado,
                idCuenta: idCuenta
            }
        };

    } catch (error) {
        console.error('Error en procesarAltaExpress:', error);
        return crearRespuestaError(`Error en proceso Alta Express: ${error.message}`, { source: contexto, error });
    }
}

/**
 * === ELIMINAR COMUNICADO (EN CASCADA) ===
 * Elimina un comunicado y todos sus registros dependientes.
 * Orden de eliminación:
 * 1. Hijos directos simples: Tickets, Equipo, Financiero.
 * 2. Hijos complejos: Actualizaciones (y sus líneas de presupuesto).
 * 3. Relación 1:1: Datos Generales.
 * 4. Padre: Comunicado.
 */
function deleteComunicado(id) {
    const contexto = 'deleteComunicado';
    try {
        const comunicadoId = String(id || '').trim();
        if (!comunicadoId) {
            return crearRespuestaError('Se requiere el ID del comunicado', { source: contexto });
        }

        // 1. Validar existencia del comunicado
        const comunicadoResult = buscarPorId('comunicados', comunicadoId);
        if (!comunicadoResult.success) {
            return propagarRespuestaError(contexto, comunicadoResult);
        }
        const comunicado = comunicadoResult.data;

        // 2. ELIMINAR HIJOS DIRECTOS SIMPLES
        // Tickets
        const ticketsResp = readAllRows('tickets');
        if (ticketsResp.success && ticketsResp.data) {
            const tickets = ticketsResp.data.filter(t => String(t.idComunicado) === comunicadoId);
            tickets.forEach(t => eliminarRegistro('tickets', t.id));
        }

        // Equipo
        const equipoResp = readAllRows('equipo');
        if (equipoResp.success && equipoResp.data) {
            const equipo = equipoResp.data.filter(e => String(e.idComunicado) === comunicadoId);
            equipo.forEach(e => eliminarRegistro('equipo', e.id));
        }

        // Financiero
        const financieroResp = readAllRows('financiero');
        if (financieroResp.success && financieroResp.data) {
            const items = financieroResp.data.filter(f => String(f.idComunicado) === comunicadoId);
            items.forEach(f => eliminarRegistro('financiero', f.id));
        }

        // 3. ELIMINAR ACTUALIZACIONES (Y SUS LÍNEAS DE PRESUPUESTO)
        const actualizacionesResp = readAllRows('actualizaciones');
        let idsLineaEliminadas = []; // IDs de descripcionLineas que fueron referenciadas

        if (actualizacionesResp.success && actualizacionesResp.data) {
            const actualizaciones = actualizacionesResp.data.filter(a => String(a.idComunicado) === comunicadoId);

            // Para cada actualización, eliminar sus líneas de presupuesto
            if (actualizaciones.length > 0) {
                const lineasResp = readAllRows('presupuestoLineas');
                const todasLineas = (lineasResp.success && lineasResp.data) ? lineasResp.data : [];

                actualizaciones.forEach(act => {
                    const lineasDeActualizacion = todasLineas.filter(l => String(l.idActualizacion) === String(act.id));
                    lineasDeActualizacion.forEach(l => {
                        // Guardar idLinea para limpieza de descripcionLineas
                        if (l.idLinea) idsLineaEliminadas.push(String(l.idLinea));
                        eliminarRegistro('presupuestoLineas', l.id);
                    });

                    // Eliminar la actualización misma
                    eliminarRegistro('actualizaciones', act.id);
                });
            }
        }

        // 3.5 ELIMINAR DESCRIPCIONLINEAS HUÉRFANAS
        // Solo eliminar las descripciones que ya no están referenciadas por ninguna otra línea
        if (idsLineaEliminadas.length > 0) {
            const presupuestoRestante = readAllRows('presupuestoLineas');
            const idsEnUso = new Set(
                (presupuestoRestante.success && presupuestoRestante.data)
                    ? presupuestoRestante.data.map(l => String(l.idLinea)).filter(Boolean)
                    : []
            );

            // Filtrar solo las que ya no están en uso
            const idsHuerfanas = [...new Set(idsLineaEliminadas)].filter(id => !idsEnUso.has(id));

            if (idsHuerfanas.length > 0) {
                console.log(`[${contexto}] Eliminando ${idsHuerfanas.length} descripcionLineas huérfanas...`);
                idsHuerfanas.forEach(idLinea => {
                    eliminarRegistro('descripcionLineas', idLinea);
                });
            }
        }

        // 4. ELIMINAR DATOS GENERALES
        const datosGeneralesResult = buscarPorCampo('datosGenerales', 'idComunicado', comunicadoId);
        if (datosGeneralesResult.success && datosGeneralesResult.data) {
            eliminarRegistro('datosGenerales', datosGeneralesResult.data.id);
        }

        // 5. ELIMINAR COMUNICADO (PADRE)
        const deleteResp = eliminarRegistro('comunicados', comunicadoId);
        if (!deleteResp.success) {
            return propagarRespuestaError(contexto, deleteResp);
        }

        return {
            success: true,
            message: `Comunicado "${comunicado.comunicado}" eliminado correctamente junto con todos sus datos asociados.`
        };

    } catch (error) {
        console.error('Error en deleteComunicado:', error);
        return crearRespuestaError(`Error al eliminar comunicado: ${error.message}`, { source: contexto, error, details: { id } });
    }
}


/**
 * === RECALCULAR IMPORTES VIGENTES ===
 * Recorre todas las actualizaciones de presupuesto (o de un comunicado específico)
 * y recalcula su 'monto' sumando las líneas individuales asociadas.
 * Corrige discrepancias entre el encabezado de presupuesto y el detalle.
 * 
 * @param {string|number} [idComunicado=null] - ID opcional para restringir el recálculo a un solo comunicado
 */
/**
 * === RECALCULAR IMPORTES VIGENTES ===
 * Recorre todas las actualizaciones de presupuesto (o de un comunicado específico)
 * y recalcula su 'monto' sumando las líneas individuales asociadas.
 * Corrige discrepancias entre el encabezado de presupuesto y el detalle.
 * 
 * @param {string|number} idComunicado - ID opcional para restringir el recálculo (puede ser null)
 */
function recalcularImportesVigentes(idComunicado) {
    // Manejo manual de parámetro opcional para máxima compatibilidad
    var targetId = (idComunicado === undefined) ? null : idComunicado;

    const contexto = 'recalcularImportesVigentes';
    console.log(`[${contexto}] Iniciando recálculo... Target: ${targetId ? 'Comunicado ' + targetId : 'GLOBAL'}`);
    const logs = [];

    try {
        // 1. Leer todas las actualizaciones
        const actResp = readAllRows('actualizaciones');

        // Verificación defensiva de respuesta
        if (!actResp || !actResp.success) {
            throw new Error('Falló lectura de actualizaciones: ' + (actResp ? actResp.message : 'Respuesta nula'));
        }

        // Verificación defensiva de datos
        let actualizaciones = (actResp.data && Array.isArray(actResp.data)) ? actResp.data : [];

        // Filtrar si es para un comunicado específico
        if (targetId) {
            actualizaciones = actualizaciones.filter(a => String(a.idComunicado) === String(targetId));
        }

        if (actualizaciones.length === 0) {
            return { success: true, data: { message: 'No hay actualizaciones para procesar.', logs: [] } };
        }

        // 2. Leer todas las líneas
        const lineasResp = readAllRows('presupuestoLineas');
        if (!lineasResp || !lineasResp.success) {
            throw new Error('Falló lectura de líneas: ' + (lineasResp ? lineasResp.message : 'Respuesta nula'));
        }
        const lineas = (lineasResp.data && Array.isArray(lineasResp.data)) ? lineasResp.data : [];

        let corregidos = 0;
        let totalProcesados = 0;

        // 3. Procesar cada actualización
        for (const act of actualizaciones) {
            totalProcesados++;

            // Validar ID
            if (!act.id) continue;

            // Filtrar líneas de esta actualización
            const susLineas = lineas.filter(l => String(l.idActualizacion) === String(act.id));

            // Sumar importes
            const sumaReal = susLineas.reduce((acc, l) => acc + (parseFloat(l.importe) || 0), 0);

            // Comparar con monto registrado (tolerancia 0.1)
            const montoActual = parseFloat(act.monto) || 0;
            const diff = Math.abs(montoActual - sumaReal);

            if (diff > 0.1) {
                console.log(`[${contexto}] Corrección ID ${act.id}: ${montoActual} -> ${sumaReal}`);

                // Actualizar registro
                const updateRes = actualizarRegistro('actualizaciones', act.id, {
                    monto: sumaReal
                });

                if (updateRes && updateRes.success) {
                    corregidos++;
                    logs.push(`ID ${act.id}: ${montoActual.toFixed(2)} -> ${sumaReal.toFixed(2)}`);
                } else {
                    logs.push(`Error ID ${act.id}: ${updateRes ? updateRes.message : 'Fallo update'}`);
                }
            }
        }

        return {
            success: true,
            data: {
                message: `Proceso completado. ${corregidos} actualizaciones corregidas de ${totalProcesados}.`,
                logs: logs
            }
        };

    } catch (error) {
        console.error(`Error en ${contexto}:`, error);
        // Note: On error, serverCall will reject. We can still return a structured error if needed.
        return { success: false, message: error.message || 'Error desconocido', data: null };
    }
}

