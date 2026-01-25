/**
 * =================================================================
 * SERVICIO DE ESTIMACIONES
 * =================================================================
 * Maneja la importación y gestión de Estimaciones, Facturas y Bitácora.
 * Vinculado a Comunicados para seguimiento de avances de obra.
 */

// ============================================================================
// CONSTANTES
// ============================================================================
const TABLE_ESTIMACIONES = 'estimaciones';
const TABLE_FACTURAS_EST = 'facturasEstimaciones';
const TABLE_BITACORA_EST = 'bitacoraEstimaciones';
const TABLE_BITACORA_FACT = 'bitacoraFacturas';

// ============================================================================
// IMPORTACIÓN DESDE CSV
// ============================================================================

/**
 * Importa estimaciones desde CSV estilo base de datos
 * Columnas esperadas: referenciaAjustador, sufijo, tipo, numero, montoAutorizado, fechaCorte, periodoInicio, periodoFin, estatusInterno
 * 
 * @param {string} fileContent - Contenido del archivo CSV
 * @returns {Object} Resultado de la importación
 */
function importarEstimacionesDesdeCSV(fileContent) {
    const contexto = 'importarEstimacionesDesdeCSV';

    try {
        const rows = Utilities.parseCsv(fileContent);
        if (rows.length < 2) throw new Error('CSV vacío o sin datos');

        const headers = rows[0].map(h => String(h).trim().toUpperCase());
        const dataRows = rows.slice(1);

        // Mapeo de columnas
        const idxRef = headers.findIndex(h => h.includes('REFERENCIA') || h.includes('AJUSTADOR'));
        const idxSufijo = headers.findIndex(h => h === 'SUFIJO' || h.includes('COMUNICADO'));
        const idxEntidad = headers.findIndex(h => h === 'ENTIDAD');
        const idxTipo = headers.findIndex(h => h === 'TIPO');
        const idxNumero = headers.findIndex(h => h === 'NUMERO' || h === 'NO');
        const idxMonto = headers.findIndex(h => h.includes('MONTO') || h === 'IMPORTE');
        const idxFechaCorte = headers.findIndex(h => h.includes('FECHACORTE') || h.includes('FECHA_CORTE') || h === 'FECHA');
        const idxPeriodoInicio = headers.findIndex(h => h.includes('PERIODOINICIO') || h.includes('INICIO'));
        const idxPeriodoFin = headers.findIndex(h => h.includes('PERIODOFIN') || h.includes('FIN'));
        const idxEstatus = headers.findIndex(h => h.includes('ESTATUS') || h.includes('ESTADO'));

        if (idxRef === -1 && idxSufijo === -1) throw new Error('Falta columna REFERENCIAAJUSTADOR o SUFIJO');
        if (idxEntidad === -1) throw new Error('Falta columna ENTIDAD');
        if (idxTipo === -1) throw new Error('Falta columna TIPO');

        // Cargar datos necesarios
        const cache = _loadCatalogsCache();
        const estimacionesExistentes = readAllRows(TABLE_ESTIMACIONES).data || [];

        const nuevasEstimaciones = [];
        const nuevasBitacoras = [];
        const errores = [];

        dataRows.forEach((row, idx) => {
            const ref = idxRef > -1 ? String(row[idxRef]).trim() : '';
            const sufijo = idxSufijo > -1 ? String(row[idxSufijo]).trim() : '';
            const entidad = idxEntidad > -1 ? String(row[idxEntidad]).trim().toUpperCase() : 'CONSTRUCTORA';
            const tipo = idxTipo > -1 ? String(row[idxTipo]).trim().toUpperCase() : 'ESTIMACION';
            const numero = idxNumero > -1 ? String(row[idxNumero]).trim() : '';

            if (!ref || !sufijo) {
                errores.push(`Fila ${idx + 2}: Referencia o Sufijo vacío`);
                return;
            }

            // Validar entidad
            if (!['CONSTRUCTORA', 'SUPERVISION'].includes(entidad)) {
                errores.push(`Fila ${idx + 2}: Entidad '${entidad}' inválida. Use CONSTRUCTORA o SUPERVISION`);
                return;
            }

            // Validar reglas de negocio: SUPERVISION solo permite ANTICIPO y FINIQUITO
            if (entidad === 'SUPERVISION' && !['ANTICIPO', 'FINIQUITO'].includes(tipo)) {
                errores.push(`Fila ${idx + 2}: SUPERVISION solo permite ANTICIPO o FINIQUITO, no ${tipo}`);
                return;
            }

            // Construir clave del comunicado (ej: GL098774-L27)
            const comunicadoClave = `${ref}-${sufijo}`;

            // Buscar el comunicado
            const comunicado = cache.comunicados.find(c =>
                String(c.comunicado).trim().toUpperCase() === comunicadoClave.toUpperCase()
            );

            if (!comunicado) {
                errores.push(`Fila ${idx + 2}: Comunicado '${comunicadoClave}' no encontrado`);
                return;
            }

            // Verificar duplicados (ahora incluye entidad)
            const existe = estimacionesExistentes.some(e =>
                String(e.idComunicado) === String(comunicado.id) &&
                String(e.entidad || 'CONSTRUCTORA').toUpperCase() === entidad &&
                String(e.numero).trim().toUpperCase() === numero.toUpperCase() &&
                String(e.tipo).toUpperCase() === tipo
            );

            if (existe) {
                errores.push(`Fila ${idx + 2}: ${entidad} ${tipo} #${numero} ya existe para ${comunicadoClave}`);
                return;
            }

            const nuevoId = Utilities.getUuid();
            const monto = idxMonto > -1 ? parseFloat(String(row[idxMonto]).replace(/[$,]/g, '')) || 0 : 0;

            nuevasEstimaciones.push({
                id: nuevoId,
                idComunicado: comunicado.id,
                entidad: entidad,
                tipo: tipo,
                numero: numero || (tipo === 'ANTICIPO' ? 'A' : tipo === 'FINIQUITO' ? 'F' : '1'),
                idEstimacionVinculada: '', // Se vinculará después si es SUPERVISION
                montoAutorizado: monto,
                fechaCorte: idxFechaCorte > -1 ? String(row[idxFechaCorte]).trim() : new Date().toISOString().split('T')[0],
                periodoInicio: idxPeriodoInicio > -1 ? String(row[idxPeriodoInicio]).trim() : '',
                periodoFin: idxPeriodoFin > -1 ? String(row[idxPeriodoFin]).trim() : '',
                estatusInterno: idxEstatus > -1 ? String(row[idxEstatus]).trim() : 'PENDIENTE'
            });

            nuevasBitacoras.push({
                id: Utilities.getUuid(),
                idEstimacion: nuevoId,
                fecha: new Date(),
                observacion: `[Importación CSV] ${entidad} - ${comunicadoClave}, Tipo: ${tipo}, No: ${numero}`,
                usuario: 'SISTEMA'
            });
        });

        // Guardar en lote
        if (nuevasEstimaciones.length > 0) {
            createBatch(TABLE_ESTIMACIONES, nuevasEstimaciones);
            createBatch(TABLE_BITACORA_EST, nuevasBitacoras);

            // Vincular automáticamente SUPERVISION con CONSTRUCTORA
            const vinculadas = _vincularSupervisionPost(comunicado.id, nuevasEstimaciones, estimacionesExistentes);
            console.log(`[${contexto}] Estimaciones de supervisión vinculadas: ${vinculadas}`);
        }

        let mensaje = `Se importaron ${nuevasEstimaciones.length} estimaciones correctamente.`;
        if (errores.length > 0) {
            mensaje += ` ${errores.length} filas con errores.`;
        }

        return {
            success: true,
            message: mensaje,
            data: {
                importadas: nuevasEstimaciones.length,
                errores: errores.slice(0, 10)
            }
        };

    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

/**
 * Importa facturas de estimaciones desde CSV
 * Busca la estimación por referenciaAjustador + comunicadoId + noEstimacion
 * 
 * @param {string} fileContent - Contenido del archivo CSV
 * @returns {Object} Resultado de la importación
 */
function importarFacturasEstimacionesDesdeCSV(fileContent) {
    const contexto = 'importarFacturasEstimacionesDesdeCSV';

    try {
        const rows = Utilities.parseCsv(fileContent);
        if (rows.length < 2) throw new Error('CSV vacío o sin datos');

        const headers = rows[0].map(h => String(h).trim().toUpperCase());
        const dataRows = rows.slice(1);

        // Mapeo de columnas - nuevos campos de búsqueda
        const idxRefAjustador = headers.findIndex(h => h.includes('REFERENCIA') || h.includes('AJUSTADOR'));
        const idxComunicado = headers.findIndex(h => h.includes('COMUNICADO'));
        const idxEntidad = headers.findIndex(h => h === 'ENTIDAD');
        const idxNoEstimacion = headers.findIndex(h => h.includes('NOESTIMACION') || h.includes('NO_ESTIMACION') || h === 'NUMERO');
        const idxFolio = headers.findIndex(h => h.includes('FOLIO') && !h.includes('FISCAL') && !h.includes('UUID'));
        const idxUuid = headers.findIndex(h => h === 'UUID' || h.includes('FOLIO_FISCAL') || h.includes('FOLIO FISCAL'));
        const idxMonto = headers.findIndex(h => h === 'MONTO' || h === 'TOTAL' || h === 'IMPORTE');
        const idxEstatus = headers.findIndex(h => h.includes('ESTATUS') || h.includes('SAT') || h === 'ESTADO');

        if (idxComunicado === -1) throw new Error('Falta columna COMUNICADOID o COMUNICADO');
        if (idxEntidad === -1) throw new Error('Falta columna ENTIDAD');
        if (idxNoEstimacion === -1) throw new Error('Falta columna NOESTIMACION o NUMERO');

        // Cargar datos necesarios para lookup
        const cache = _loadCatalogsCache();
        const estimaciones = readAllRows(TABLE_ESTIMACIONES).data || [];

        const facturas = [];
        const bitacoras = [];
        const errores = [];

        dataRows.forEach((row, idx) => {
            const refAjustador = idxRefAjustador > -1 ? String(row[idxRefAjustador]).trim() : '';
            const comunicadoId = String(row[idxComunicado]).trim();
            const entidad = idxEntidad > -1 ? String(row[idxEntidad]).trim().toUpperCase() : 'CONSTRUCTORA';
            const noEstimacion = String(row[idxNoEstimacion]).trim();

            if (!comunicadoId || !noEstimacion) {
                errores.push(`Fila ${idx + 2}: Comunicado o NoEstimacion vacío`);
                return;
            }

            // Validar entidad
            if (!['CONSTRUCTORA', 'SUPERVISION'].includes(entidad)) {
                errores.push(`Fila ${idx + 2}: Entidad '${entidad}' inválida. Use CONSTRUCTORA o SUPERVISION`);
                return;
            }

            // Buscar el comunicado por clave
            const comunicado = cache.comunicados.find(c =>
                String(c.comunicado).trim().toUpperCase() === comunicadoId.toUpperCase()
            );

            if (!comunicado) {
                errores.push(`Fila ${idx + 2}: Comunicado '${comunicadoId}' no encontrado`);
                return;
            }

            // Buscar la estimación por idComunicado, entidad y numero
            const estimacion = estimaciones.find(e =>
                String(e.idComunicado) === String(comunicado.id) &&
                String(e.entidad || 'CONSTRUCTORA').toUpperCase() === entidad &&
                String(e.numero).trim().toUpperCase() === noEstimacion.toUpperCase()
            );

            if (!estimacion) {
                errores.push(`Fila ${idx + 2}: ${entidad} Estimación #${noEstimacion} no encontrada para ${comunicadoId}`);
                return;
            }

            const nuevoId = Utilities.getUuid();

            facturas.push({
                id: nuevoId,
                idEstimacion: estimacion.id,
                folioFactura: idxFolio > -1 ? String(row[idxFolio]).trim() : 'S/N',
                uuid: idxUuid > -1 ? String(row[idxUuid]).trim() : '',
                monto: idxMonto > -1 ? parseFloat(String(row[idxMonto]).replace(/[$,]/g, '')) || 0 : 0,
                estatusSAT: idxEstatus > -1 ? String(row[idxEstatus]).trim() : 'VIGENTE',
                archivoXml: '',
                archivoPdf: ''
            });

            bitacoras.push({
                id: Utilities.getUuid(),
                idFactura: nuevoId,
                fecha: new Date(),
                tipoEvento: 'CREACION',
                observacion: `[Importación CSV] Comunicado: ${comunicadoId}, Est: ${noEstimacion}`,
                usuario: 'SISTEMA'
            });
        });

        if (facturas.length > 0) {
            createBatch(TABLE_FACTURAS_EST, facturas);
            createBatch(TABLE_BITACORA_FACT, bitacoras);
        }

        let mensaje = `Se importaron ${facturas.length} facturas correctamente.`;
        if (errores.length > 0) {
            mensaje += ` ${errores.length} filas con errores.`;
        }

        return {
            success: true,
            message: mensaje,
            data: {
                importadas: facturas.length,
                errores: errores.slice(0, 10) // Limitar a 10 errores
            }
        };

    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

// ============================================================================
// PARSING XML (CFDI)
// ============================================================================

/**
 * Extrae datos de un XML de factura CFDI 4.0
 * 
 * @param {string} xmlContent - Contenido del archivo XML
 * @returns {Object} Datos extraídos del CFDI
 */
function parsearXmlFactura(xmlContent) {
    const contexto = 'parsearXmlFactura';

    try {
        const doc = XmlService.parse(xmlContent);
        const root = doc.getRootElement();

        // Namespaces CFDI 4.0
        const ns = XmlService.getNamespace('cfdi', 'http://www.sat.gob.mx/cfd/4');
        const tfd = XmlService.getNamespace('tfd', 'http://www.sat.gob.mx/TimbreFiscalDigital');

        const complemento = root.getChild('Complemento', ns);
        const timbre = complemento ? complemento.getChild('TimbreFiscalDigital', tfd) : null;
        const emisor = root.getChild('Emisor', ns);

        return {
            success: true,
            data: {
                uuid: timbre ? timbre.getAttribute('UUID').getValue() : null,
                fecha: root.getAttribute('Fecha') ? root.getAttribute('Fecha').getValue() : null,
                total: parseFloat(root.getAttribute('Total') ? root.getAttribute('Total').getValue() : 0),
                emisorRfc: emisor ? emisor.getAttribute('Rfc').getValue() : null,
                emisorNombre: emisor ? emisor.getAttribute('Nombre').getValue() : null,
                version: root.getAttribute('Version') ? root.getAttribute('Version').getValue() : '4.0'
            }
        };
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: `Error parseando XML: ${e.message}` };
    }
}

// ============================================================================
// CRUD CON BITÁCORA AUTOMÁTICA
// ============================================================================

/**
 * Crea una nueva estimación con registro automático en bitácora
 * 
 * @param {Object} datos - Datos de la estimación
 * @returns {Object} Resultado de la operación
 */
function crearEstimacion(datos) {
    const contexto = 'crearEstimacion';

    try {
        // Sanitize: Force new ID generation by removing any incoming ID
        if (datos.id) {
            delete datos.id;
        }

        const resultado = createRow(TABLE_ESTIMACIONES, datos);

        if (resultado.success) {
            createRow(TABLE_BITACORA_EST, {
                idEstimacion: resultado.data.id,
                fecha: new Date(),
                observacion: `Estimación creada. Tipo: ${datos.tipo}, Monto: ${datos.montoAutorizado}`,
                usuario: Session.getActiveUser().getEmail() || 'SISTEMA'
            });
        }

        return resultado;
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

/**
 * Agrega una factura a una estimación existente
 * 
 * @param {string|number} idEstimacion - ID de la estimación
 * @param {Object} datosFactura - Datos de la factura
 * @returns {Object} Resultado de la operación
 */
function agregarFactura(idEstimacion, datosFactura) {
    const contexto = 'agregarFactura';

    try {
        // Sanitize: Remove ID to force new generation
        const { id, ...cleanDatos } = datosFactura;
        const datos = { ...cleanDatos, idEstimacion };
        const resultado = createRow(TABLE_FACTURAS_EST, datos);

        if (resultado.success) {
            createRow(TABLE_BITACORA_FACT, {
                idFactura: resultado.data.id,
                fecha: new Date(),
                tipoEvento: 'CREACION',
                observacion: `Factura ${datosFactura.folioFactura || 'S/N'} agregada. UUID: ${datosFactura.uuid || 'N/A'}`,
                usuario: Session.getActiveUser().getEmail() || 'SISTEMA'
            });
        }

        return resultado;
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

/**
 * Actualiza el estatus de una factura (ej. Cancelar)
 * 
 * @param {string|number} idFactura - ID de la factura
 * @param {string} nuevoEstatus - Nuevo estatus (VIGENTE, CANCELADA)
 * @param {string} observacion - Observación opcional
 * @returns {Object} Resultado de la operación
 */
function actualizarEstatusFactura(idFactura, nuevoEstatus, observacion) {
    const contexto = 'actualizarEstatusFactura';

    try {
        const resultado = updateRow(TABLE_FACTURAS_EST, idFactura, { estatusSAT: nuevoEstatus });

        if (resultado.success) {
            createRow(TABLE_BITACORA_FACT, {
                idFactura: idFactura,
                fecha: new Date(),
                tipoEvento: nuevoEstatus === 'CANCELADA' ? 'CANCELACION' : 'ACTUALIZACION',
                observacion: observacion || `Estatus cambiado a ${nuevoEstatus}`,
                usuario: Session.getActiveUser().getEmail() || 'SISTEMA'
            });
        }

        return resultado;
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

function actualizarFactura(idFactura, datos) {
    const contexto = 'actualizarFactura';

    // Safety: Redirect temp IDs to creation
    if (String(idFactura).startsWith('temp-') && datos.idEstimacion) {
        console.warn(`[${contexto}] Redirigiendo a agregarFactura para ID: ${idFactura}`);
        return agregarFactura(datos.idEstimacion, datos);
    }

    try {
        const resultado = updateRow(TABLE_FACTURAS_EST, idFactura, datos);
        return resultado;
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

function eliminarFactura(idFactura) {
    const contexto = 'eliminarFactura';
    try {
        const resultado = deleteRow(TABLE_FACTURAS_EST, idFactura);
        return resultado;
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

/**
 * Elimina una estimación de la base de datos
 * NOTA: La eliminación en cascada (facturas, complementos) se maneja en el frontend
 * 
 * @param {string|number} idEstimacion - ID de la estimación a eliminar
 * @returns {Object} Resultado de la operación
 */
function eliminarEstimacion(idEstimacion) {
    const contexto = 'eliminarEstimacion';
    try {
        // Registrar en bitácora antes de eliminar
        createRow(TABLE_BITACORA_EST, {
            idEstimacion: idEstimacion,
            fecha: new Date(),
            observacion: 'Estimación eliminada por el usuario',
            usuario: Session.getActiveUser().getEmail() || 'SISTEMA'
        });

        const resultado = deleteRow(TABLE_ESTIMACIONES, idEstimacion);

        if (resultado.success) {
            console.log(`[${contexto}] Estimación ${idEstimacion} eliminada correctamente`);
        }

        return resultado;
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

/**
 * Actualiza una estimación existente
 * 
 * @param {string|number} idEstimacion - ID de la estimación
 * @param {Object} nuevosDatos - Datos a actualizar
 * @param {string} observacion - Observación para bitácora
 * @returns {Object} Resultado de la operación
 */
function actualizarEstimacion(idEstimacion, nuevosDatos, observacion) {
    const contexto = 'actualizarEstimacion';

    try {
        const resultado = updateRow(TABLE_ESTIMACIONES, idEstimacion, nuevosDatos);

        if (resultado.success) {
            createRow(TABLE_BITACORA_EST, {
                idEstimacion: idEstimacion,
                fecha: new Date(),
                observacion: observacion || `Estimación actualizada: ${JSON.stringify(nuevosDatos)}`,
                usuario: Session.getActiveUser().getEmail() || 'SISTEMA'
            });
        }

        return resultado;
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

// ============================================================================
// LECTURA DE DATOS
// ============================================================================

/**
 * Obtiene todas las estimaciones de un comunicado con sus facturas anidadas
 * 
 * @param {string|number} idComunicado - ID del comunicado
 * @returns {Array} Lista de estimaciones con facturas
 */
function leerEstimacionesPorComunicado(idComunicado) {
    const contexto = 'leerEstimacionesPorComunicado';

    try {
        const todasEstimaciones = readAllRows(TABLE_ESTIMACIONES).data || [];
        const estimaciones = todasEstimaciones.filter(e => String(e.idComunicado) === String(idComunicado));
        const facturas = readAllRows(TABLE_FACTURAS_EST).data || [];

        // Anidar facturas y datos de vinculación dentro de cada estimación
        const resultado = estimaciones.map(est => {
            const estConFacturas = {
                ...est,
                facturas: facturas.filter(f => String(f.idEstimacion) === String(est.id))
            };

            // Si es SUPERVISION y tiene vinculación, agregar datos de la constructora vinculada
            if (est.entidad === 'SUPERVISION' && est.idEstimacionVinculada) {
                const constructoraVinculada = todasEstimaciones.find(
                    e => String(e.id) === String(est.idEstimacionVinculada)
                );
                if (constructoraVinculada) {
                    estConFacturas.constructoraVinculada = {
                        id: constructoraVinculada.id,
                        tipo: constructoraVinculada.tipo,
                        numero: constructoraVinculada.numero,
                        montoAutorizado: constructoraVinculada.montoAutorizado
                    };
                }
            }

            return estConFacturas;
        });

        console.log(`[${contexto}] Encontradas ${resultado.length} estimaciones para comunicado ${idComunicado}`);

        // CLEANUP: Ensure data is clean JSON (remove Date objects, prototypes, etc. that might break google.script.run)
        const cleanData = JSON.parse(JSON.stringify(resultado));

        return { success: true, data: cleanData };
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message, data: [] };
    }
}

/**
 * Obtiene el historial de bitácora de una estimación
 * 
 * @param {string|number} idEstimacion - ID de la estimación
 * @returns {Array} Historial de la estimación
 */
function leerBitacoraEstimacion(idEstimacion) {
    const contexto = 'leerBitacoraEstimacion';

    try {
        return (readAllRows(TABLE_BITACORA_EST).data || [])
            .filter(b => String(b.idEstimacion) === String(idEstimacion))
            .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return [];
    }
}

/**
 * Obtiene el historial de bitácora de una factura
 * 
 * @param {string|number} idFactura - ID de la factura
 * @returns {Array} Historial de la factura
 */
function leerBitacoraFactura(idFactura) {
    const contexto = 'leerBitacoraFactura';

    try {
        return (readAllRows(TABLE_BITACORA_FACT).data || [])
            .filter(b => String(b.idFactura) === String(idFactura))
            .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return [];
    }
}

// ============================================================================
// GENERACIÓN DE PLANTILLAS DESCARGABLES
// ============================================================================

/**
 * Genera una plantilla CSV para importar Facturas de Estimaciones (estilo base de datos)
 * @returns {Object} Resultado con el contenido CSV en base64
 */
function generarPlantillaFacturasEstimaciones() {
    // Columnas para identificar la estimación por campos legibles
    const headers = [
        'referenciaAjustador',  // Referencia del ajustador (ej: GL098774)
        'comunicadoId',         // Clave del comunicado (ej: GL098774-L27)
        'entidad',              // CONSTRUCTORA o SUPERVISION
        'noEstimacion',         // Número de estimación (1, 2, 3, A, F)
        'folioFactura',         // Folio de la factura
        'uuid',                 // UUID/Folio Fiscal del SAT
        'monto',                // Monto de la factura
        'estatusSAT'            // VIGENTE, CANCELADA
    ];

    // Ejemplo de datos
    const ejemplos = [
        // Facturas de CONSTRUCTORA
        ['GL098774', 'L27', 'CONSTRUCTORA', '1', 'F-001', '12345678-ABCD-1234-EFGH-123456789012', '150000.00', 'VIGENTE'],
        ['GL098774', 'L27', 'CONSTRUCTORA', '1', 'F-002', '87654321-DCBA-4321-HGFE-210987654321', '75000.50', 'VIGENTE'],
        ['GL098774', 'L27', 'CONSTRUCTORA', 'A', 'F-003', 'XXXXXXXX-YYYY-ZZZZ-AAAA-BBBBBBBBBBBB', '500000.00', 'VIGENTE'],
        // Facturas de SUPERVISION
        ['GL098774', 'L27', 'SUPERVISION', 'A', 'F-004', 'SSSSSSSS-PPPP-VVVV-NNNN-TTTTTTTTTTTT', '25000.00', 'VIGENTE']
    ];

    // Construir CSV limpio
    let csv = headers.join(',') + '\n';
    ejemplos.forEach(row => {
        csv += row.join(',') + '\n';
    });

    const base64 = Utilities.base64Encode(csv, Utilities.Charset.UTF_8);

    return {
        success: true,
        data: {
            content: base64,
            filename: 'plantilla_facturas_estimaciones.csv',
            mimeType: 'text/csv'
        }
    };
}

/**
 * Genera una plantilla CSV para importar Estimaciones (estilo base de datos)
 * @returns {Object} Resultado con el contenido CSV en base64
 */
function generarPlantillaEstimaciones() {
    // Columnas basadas en TABLE_DEFINITIONS.estimaciones
    // Nota: vinculadaA es opcional - si se omite, el sistema vincula automáticamente por tipo
    const headers = [
        'referenciaAjustador',  // Referencia del ajustador (ej: GL098774)
        'sufijo',               // Sufijo del comunicado (ej: L27, L27A)
        'entidad',              // CONSTRUCTORA o SUPERVISION
        'tipo',                 // ESTIMACION, ANTICIPO, FINIQUITO
        'numero',               // Número de estimación (1, 2, 3, A, F)
        'montoAutorizado',      // Monto en pesos
        'fechaCorte',           // Fecha de corte (YYYY-MM-DD)
        'periodoInicio',        // Fecha inicio del periodo
        'periodoFin',           // Fecha fin del periodo
        'estatusInterno'        // PENDIENTE, EN_REVISION, APROBADO, PAGADO
    ];

    // Ejemplo de datos - Constructora y Supervisión
    // NOTA: SUPERVISION se vincula automáticamente a CONSTRUCTORA por tipo (ANTICIPO↔ANTICIPO, FINIQUITO↔FINIQUITO)
    const ejemplos = [
        // CONSTRUCTORA - puede tener todas las estimaciones
        ['GL098774', 'L27', 'CONSTRUCTORA', 'ANTICIPO', 'A', '500000.00', '2025-01-15', '', '', 'PAGADO'],
        ['GL098774', 'L27', 'CONSTRUCTORA', 'ESTIMACION', '1', '150000.00', '2025-02-01', '2025-01-01', '2025-01-31', 'EN_REVISION'],
        ['GL098774', 'L27', 'CONSTRUCTORA', 'ESTIMACION', '2', '200000.00', '2025-03-01', '2025-02-01', '2025-02-28', 'PENDIENTE'],
        ['GL098774', 'L27', 'CONSTRUCTORA', 'FINIQUITO', 'F', '100000.00', '2025-04-01', '', '', 'PENDIENTE'],
        // SUPERVISION - solo ANTICIPO y FINIQUITO (se vinculan automáticamente a CONSTRUCTORA)
        ['GL098774', 'L27', 'SUPERVISION', 'ANTICIPO', 'A', '25000.00', '2025-01-15', '', '', 'PAGADO'],
        ['GL098774', 'L27', 'SUPERVISION', 'FINIQUITO', 'F', '5000.00', '2025-04-01', '', '', 'PENDIENTE']
    ];

    // Construir CSV limpio
    let csv = headers.join(',') + '\n';
    ejemplos.forEach(row => {
        csv += row.join(',') + '\n';
    });

    const base64 = Utilities.base64Encode(csv, Utilities.Charset.UTF_8);

    return {
        success: true,
        data: {
            content: base64,
            filename: 'plantilla_estimaciones.csv',
            mimeType: 'text/csv'
        }
    };
}

/**
 * Genera ambas plantillas en un solo llamado
 * @returns {Object} Objeto con ambas plantillas
 */
function generarPlantillasEstimacionesYFacturas() {
    return {
        success: true,
        data: {
            plantillaEstimaciones: generarPlantillaEstimaciones().data,
            plantillaFacturas: generarPlantillaFacturasEstimaciones().data
        }
    };
}

// ============================================================================
// IMPORTACIÓN DE RELACIÓN CONTRATISTAS
// ============================================================================

/**
 * Normaliza el nombre de un contratista (Razón Social)
 * - Elimina espacios extras
 * - Convierte a mayúsculas
 * - Normaliza caracteres especiales
 * 
 * @param {string} nombre - Nombre del contratista
 * @returns {string} Nombre normalizado
 */
function _normalizarRazonSocial(nombre) {
    if (!nombre) return '';

    return String(nombre)
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' ')           // Múltiples espacios a uno solo
        .replace(/\./g, '.')            // Mantener puntos
        .normalize('NFD')               // Descomponer acentos
        .replace(/[\u0300-\u036f]/g, '') // Eliminar diacríticos
        .replace(/Ñ/g, 'N')             // Normalizar Ñ
        .trim();
}

/**
 * Busca o crea un contratista (empresa) en el catálogo
 * Usa un caché opcional para evitar duplicados en importaciones masivas
 * 
 * @param {string} razonSocial - Razón social del contratista
 * @param {Array} cacheEmpresas - Opcional: Array de empresas en caché (se actualiza si se crea una nueva)
 * @returns {Object} { success, id, created, data }
 */
function _buscarOCrearContratista(razonSocial, cacheEmpresas) {
    const contexto = '_buscarOCrearContratista';
    const normalizado = _normalizarRazonSocial(razonSocial);

    if (!normalizado) {
        return { success: false, message: 'Razón social vacía' };
    }

    try {
        // Usar el caché proporcionado o leer de la BD
        const empresas = cacheEmpresas || readAllRows('empresas').data || [];

        const existente = empresas.find(e =>
            _normalizarRazonSocial(e.razonSocial) === normalizado
        );

        if (existente) {
            console.log(`[${contexto}] Empresa existente: '${normalizado}' -> ID: ${existente.id}`);
            return {
                success: true,
                created: false,
                id: existente.id,
                data: existente
            };
        }

        // No existe, crear nuevo registro con ID autonumérico
        // Calcular el siguiente ID (máximo + 1)
        const maxId = empresas.reduce((max, e) => {
            const id = parseInt(e.id, 10);
            return isNaN(id) ? max : Math.max(max, id);
        }, 0);
        const nuevoId = maxId + 1;

        const nuevoRegistro = {
            id: nuevoId,
            razonSocial: normalizado
        };

        const resultado = createRow('empresas', nuevoRegistro);

        if (resultado.success) {
            console.log(`[${contexto}] NUEVA empresa creada: '${normalizado}' -> ID: ${nuevoId}`);

            // Si se proporcionó un caché, agregar la nueva empresa para evitar duplicados
            if (cacheEmpresas) {
                cacheEmpresas.push(nuevoRegistro);
            }

            return {
                success: true,
                created: true,
                id: nuevoId,
                data: nuevoRegistro
            };
        } else {
            return { success: false, message: resultado.message };
        }

    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

/**
 * Importa relación de contratistas desde CSV
 * Columnas esperadas: referenciaAjustador | comunicadoId (sufijo) | nombreContratista
 * 
 * Proceso:
 * 1. Normaliza el nombre del contratista
 * 2. Busca/Crea el registro en tabla 'empresas'
 * 3. Asocia el idEmpresa al datosGenerales del comunicado ORIGEN
 * 
 * @param {string} fileContent - Contenido del archivo CSV
 * @returns {Object} Resultado de la importación
 */
function importarRelacionContratistas(fileContent) {
    const contexto = 'importarRelacionContratistas';

    try {
        const rows = Utilities.parseCsv(fileContent);
        if (rows.length < 2) throw new Error('CSV vacío o sin datos');

        const headers = rows[0].map(h => String(h).trim().toUpperCase());
        const dataRows = rows.slice(1);

        // Mapeo de columnas
        const idxRef = headers.findIndex(h =>
            h.includes('REFERENCIA') || h.includes('AJUSTADOR') || h === 'REF'
        );
        const idxComunicado = headers.findIndex(h =>
            h.includes('COMUNICADO') || h === 'SUFIJO' || h === 'ORIGEN'
        );
        const idxContratista = headers.findIndex(h =>
            h.includes('CONTRATISTA') || h.includes('EMPRESA') || h.includes('RAZON') || h === 'NOMBRE'
        );

        if (idxRef === -1) throw new Error('Falta columna REFERENCIAAJUSTADOR o REF');
        if (idxComunicado === -1) throw new Error('Falta columna COMUNICADOID o SUFIJO');
        if (idxContratista === -1) throw new Error('Falta columna NOMBRECONTRATISTA o EMPRESA');

        // ═══════════════════════════════════════════════════════════════
        // CONSTRUCCIÓN DEL MAPA DE COMUNICADOS VÁLIDOS DESDE LA BD
        // Estructura: Cuentas.referencia + "-" + Comunicados.comunicado (sufijo)
        // Ejemplo: "GL098774" + "-" + "L12" = "GL098774-L12"
        // ═══════════════════════════════════════════════════════════════
        const cuentas = readAllRows('cuentas').data || [];
        const comunicados = readAllRows('comunicados').data || [];
        const datosGenerales = readAllRows('datosGenerales').data || [];

        // Crear mapa de id -> referencia (ej: "1" -> "GL098774")
        const mapaReferencias = {};
        cuentas.forEach(c => {
            mapaReferencias[String(c.id)] = String(c.referencia || '').trim().toUpperCase();
        });

        // Crear mapa inverso: referencia -> id (ej: "GL098774" -> "1")
        const mapaReferenciaToId = {};
        cuentas.forEach(c => {
            const ref = String(c.referencia || '').trim().toUpperCase();
            if (ref) mapaReferenciaToId[ref] = String(c.id);
        });

        // Crear mapa de comunicados válidos: { "GL098774-L12": comunicadoObj }
        // La clave se construye: referencia (de Cuentas via idReferencia) + "-" + comunicado (sufijo)
        const mapaComunicadosValidos = {};
        comunicados.forEach(com => {
            const idRef = String(com.idReferencia || '').trim();
            const referencia = mapaReferencias[idRef]; // Obtener "GL098774" desde id "1"
            const sufijo = String(com.comunicado || '').trim().toUpperCase(); // Ya es solo el sufijo "L12"

            if (referencia && sufijo) {
                // Construir clave completa: "GL098774-L12"
                const claveCompleta = `${referencia}-${sufijo}`;
                mapaComunicadosValidos[claveCompleta] = com;
            }
        });

        console.log(`[${contexto}] Mapa de comunicados válidos construido: ${Object.keys(mapaComunicadosValidos).length} entradas`);

        const resultados = {
            procesados: 0,
            contratistasCreados: 0,
            contratistasExistentes: 0,
            comunicadosActualizados: 0,
            sinCoincidencia: 0,
            errores: []
        };

        // Caché de empresas para evitar duplicados en importación masiva
        const cacheEmpresas = readAllRows('empresas').data || [];

        dataRows.forEach((row, idx) => {
            const ref = String(row[idxRef] || '').trim();
            const sufijo = String(row[idxComunicado] || '').trim();
            const nombreContratista = String(row[idxContratista] || '').trim();

            // ═══════════════════════════════════════════════════════════════
            // PASO 1: Validar que los campos no estén vacíos
            // ═══════════════════════════════════════════════════════════════
            if (!ref || !sufijo) {
                resultados.errores.push(`Fila ${idx + 2}: referencia o comunicadoId vacío`);
                return;
            }

            if (!nombreContratista) {
                resultados.errores.push(`Fila ${idx + 2}: Nombre de contratista vacío`);
                return;
            }

            // ═══════════════════════════════════════════════════════════════
            // PASO 2: Buscar en el mapa de comunicados válidos de la BD
            //         La clave es "REFERENCIA-SUFIJO" (ej: "AM005955-L01")
            // ═══════════════════════════════════════════════════════════════
            const comunicadoClave = `${ref}-${sufijo}`.toUpperCase();
            const comunicado = mapaComunicadosValidos[comunicadoClave];

            if (!comunicado) {
                // No existe en BD, saltar sin error (solo contar)
                resultados.sinCoincidencia++;
                return;
            }

            // ═══════════════════════════════════════════════════════════════
            // PASO 3: Verificar que sea comunicado ORIGEN (sin idSustituido)
            // ═══════════════════════════════════════════════════════════════
            if (comunicado.idSustituido && String(comunicado.idSustituido).trim() !== '') {
                resultados.errores.push(`Fila ${idx + 2}: '${comunicadoClave}' no es ORIGEN`);
                return;
            }

            // ═══════════════════════════════════════════════════════════════
            // PASO 4: Verificar si la empresa ya existe (por razón social)
            //         Si existe: solo usar el ID existente
            //         Si no existe: crear nueva empresa normalizada en mayúsculas
            // ═══════════════════════════════════════════════════════════════
            const contratista = _buscarOCrearContratista(nombreContratista, cacheEmpresas);

            if (!contratista.success) {
                resultados.errores.push(`Fila ${idx + 2}: Error con contratista - ${contratista.message}`);
                return;
            }

            if (contratista.created) {
                resultados.contratistasCreados++;
                console.log(`[${contexto}] NUEVA empresa creada: '${_normalizarRazonSocial(nombreContratista)}' -> ID: ${contratista.id}`);
            } else {
                resultados.contratistasExistentes++;
                console.log(`[${contexto}] Empresa EXISTENTE encontrada: '${contratista.data.razonSocial}' -> ID: ${contratista.id}`);
            }

            // ═══════════════════════════════════════════════════════════════
            // PASO 5: Asociar el comunicado a la empresa
            //         Actualizar idEmpresa en datosGenerales del comunicado
            // ═══════════════════════════════════════════════════════════════
            const dg = datosGenerales.find(d =>
                String(d.idComunicado) === String(comunicado.id)
            );

            if (!dg) {
                resultados.errores.push(`Fila ${idx + 2}: No se encontró DatosGenerales para '${comunicadoClave}'`);
                return;
            }

            // Actualizar el idEmpresa en datosGenerales
            const updateResult = updateRow('datosGenerales', dg.id, {
                idEmpresa: contratista.id
            });

            if (updateResult.success) {
                resultados.comunicadosActualizados++;
                console.log(`[${contexto}] Comunicado '${comunicadoClave}' asociado a empresa ID: ${contratista.id}`);
            } else {
                resultados.errores.push(`Fila ${idx + 2}: Error actualizando DG - ${updateResult.message}`);
                return;
            }

            resultados.procesados++;
        });

        // Construir mensaje de resumen
        let mensaje = `Procesadas ${resultados.procesados} relaciones. `;
        mensaje += `Contratistas: ${resultados.contratistasCreados} nuevos, ${resultados.contratistasExistentes} existentes. `;
        mensaje += `Comunicados actualizados: ${resultados.comunicadosActualizados}.`;
        mensaje += ` Sin coincidencia en BD: ${resultados.sinCoincidencia}.`;

        if (resultados.errores.length > 0) {
            mensaje += ` ${resultados.errores.length} errores.`;
        }

        return {
            success: true,
            message: mensaje,
            data: resultados
        };

    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

/**
 * Genera una plantilla CSV para importar relación de contratistas
 * Exporta automáticamente los comunicados ORIGEN que NO tienen empresa asignada (idEmpresa null/vacío)
 * 
 * Estructura de BD:
 * - Cuentas: id -> referencia (ej: 1 -> "GL098774")
 * - Comunicados: id, idReferencia, comunicado (solo sufijo: "L12", "L30")
 * - DatosGenerales: idComunicado, idEmpresa (null = sin empresa)
 * 
 * @returns {Object} Resultado con el contenido CSV en base64
 */
function generarPlantillaContratistas() {
    const contexto = 'generarPlantillaContratistas';

    const headers = [
        'referenciaAjustador',  // Referencia del ajustador (ej: GL098774)
        'comunicadoId',         // Sufijo del comunicado ORIGEN (ej: L12, L30)
        'nombreContratista'     // Razón Social de la empresa (vacío para llenar)
    ];

    try {
        // ═══════════════════════════════════════════════════════════════
        // CARGAR DATOS DE BD
        // ═══════════════════════════════════════════════════════════════
        const cuentas = readAllRows('cuentas').data || [];
        const comunicados = readAllRows('comunicados').data || [];
        const datosGenerales = readAllRows('datosGenerales').data || [];

        console.log(`[${contexto}] Cuentas: ${cuentas.length}, Comunicados: ${comunicados.length}, DatosGenerales: ${datosGenerales.length}`);

        // Crear mapa de id -> referencia (ej: "1" -> "GL098774")
        const mapaReferencias = {};
        cuentas.forEach(c => {
            mapaReferencias[String(c.id)] = String(c.referencia || '').trim().toUpperCase();
        });

        // ═══════════════════════════════════════════════════════════════
        // FILTRAR COMUNICADOS ORIGEN SIN EMPRESA ASIGNADA
        // ═══════════════════════════════════════════════════════════════
        const filasDatos = [];

        comunicados.forEach(com => {
            // Solo comunicados ORIGEN (sin idSustituido)
            if (com.idSustituido && String(com.idSustituido).trim() !== '') {
                return; // Saltar sustituciones
            }

            // Buscar datosGenerales del comunicado por idComunicado
            const dg = datosGenerales.find(d =>
                String(d.idComunicado) === String(com.id)
            );

            if (!dg) {
                console.log(`[${contexto}] Comunicado ID ${com.id} sin DatosGenerales, saltando.`);
                return;
            }

            // Verificar si NO tiene empresa asignada (idEmpresa vacío o null)
            const tieneEmpresa = dg.idEmpresa && String(dg.idEmpresa).trim() !== '';
            if (tieneEmpresa) {
                return; // Ya tiene empresa, saltar
            }

            // Obtener la referencia del ajustador desde Cuentas
            const idRef = String(com.idReferencia || '').trim();
            const referencia = mapaReferencias[idRef] || '';

            // El campo comunicado YA ES el sufijo (L12, L30, L03A)
            const sufijo = String(com.comunicado || '').trim();

            if (referencia && sufijo) {
                filasDatos.push([referencia, sufijo, '']); // nombreContratista vacío para llenar
                console.log(`[${contexto}] Agregado: ${referencia}-${sufijo} (DG id: ${dg.id}, idEmpresa vacío)`);
            }
        });

        console.log(`[${contexto}] Total encontrados sin empresa: ${filasDatos.length}`);

        // ═══════════════════════════════════════════════════════════════
        // CONSTRUIR CSV
        // ═══════════════════════════════════════════════════════════════
        let csv = headers.join(',') + '\n';

        if (filasDatos.length === 0) {
            csv += '# Todos los comunicados ORIGEN ya tienen empresa asignada\n';
            csv += '# Ejemplo de formato:\n';
            csv += 'GL098774,L12,CONSTRUCTORA ABC S.A. DE C.V.\n';
        } else {
            filasDatos.forEach(row => {
                csv += row.join(',') + '\n';
            });
        }

        const base64 = Utilities.base64Encode(csv, Utilities.Charset.UTF_8);

        return {
            success: true,
            message: `Plantilla generada con ${filasDatos.length} comunicados sin empresa asignada`,
            data: {
                content: base64,
                filename: 'plantilla_contratistas.csv',
                mimeType: 'text/csv',
                totalSinEmpresa: filasDatos.length
            }
        };

    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

// ============================================================================
// VINCULACIÓN SUPERVISION ↔ CONSTRUCTORA
// ============================================================================

/**
 * Vincula automáticamente estimaciones de SUPERVISION con CONSTRUCTORA
 * después de una importación. Busca por coincidencia de tipo.
 * 
 * @param {string|number} idComunicado - ID del comunicado procesado
 * @param {Array} nuevasEstimaciones - Estimaciones recién importadas
 * @param {Array} estimacionesExistentes - Estimaciones ya en BD
 * @returns {number} Cantidad de vinculaciones realizadas
 * @private
 */
function _vincularSupervisionPost(idComunicado, nuevasEstimaciones, estimacionesExistentes) {
    const contexto = '_vincularSupervisionPost';
    let vinculadas = 0;

    try {
        // Combinar estimaciones nuevas con existentes del mismo comunicado
        const todasEstimaciones = [
            ...estimacionesExistentes.filter(e => String(e.idComunicado) === String(idComunicado)),
            ...nuevasEstimaciones.filter(e => String(e.idComunicado) === String(idComunicado))
        ];

        // Filtrar CONSTRUCTORA (posibles destinos de vinculación)
        const constructoras = todasEstimaciones.filter(e =>
            String(e.entidad || 'CONSTRUCTORA').toUpperCase() === 'CONSTRUCTORA'
        );

        // Filtrar SUPERVISION sin vínculo (candidatos para vincular)
        const supervisionSinVinculo = nuevasEstimaciones.filter(e =>
            String(e.entidad).toUpperCase() === 'SUPERVISION' &&
            !e.idEstimacionVinculada
        );

        console.log(`[${contexto}] Constructoras disponibles: ${constructoras.length}, SUPERVISION sin vínculo: ${supervisionSinVinculo.length}`);

        supervisionSinVinculo.forEach(sup => {
            // Buscar CONSTRUCTORA con mismo tipo (ANTICIPO↔ANTICIPO, FINIQUITO↔FINIQUITO)
            const match = constructoras.find(c =>
                String(c.tipo).toUpperCase() === String(sup.tipo).toUpperCase()
            );

            if (match) {
                // Actualizar en BD
                const resultado = updateRow(TABLE_ESTIMACIONES, sup.id, {
                    idEstimacionVinculada: match.id
                });

                if (resultado.success) {
                    vinculadas++;
                    console.log(`[${contexto}] Vinculado: SUPERVISION ${sup.tipo} (${sup.id}) → CONSTRUCTORA ${match.tipo} (${match.id})`);
                }
            } else {
                console.log(`[${contexto}] Sin match: SUPERVISION ${sup.tipo} no encontró CONSTRUCTORA del mismo tipo`);
            }
        });

        return vinculadas;

    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return vinculadas;
    }
}

/**
 * Vincula todas las estimaciones de SUPERVISION existentes a sus correspondientes CONSTRUCTORA
 * Útil para datos históricos o migración
 * 
 * @returns {Object} Resultado con cantidad de vinculaciones
 */
function vincularSupervisionAConstructoraExistentes() {
    const contexto = 'vincularSupervisionAConstructoraExistentes';
    console.log(`[${contexto}] Iniciando vinculación masiva...`);

    try {
        const estimaciones = readAllRows(TABLE_ESTIMACIONES).data || [];

        // Agrupar por idComunicado
        const porComunicado = {};
        estimaciones.forEach(e => {
            const idCom = String(e.idComunicado);
            if (!porComunicado[idCom]) porComunicado[idCom] = [];
            porComunicado[idCom].push(e);
        });

        let totalVinculadas = 0;
        let comunicadosProcesados = 0;

        Object.entries(porComunicado).forEach(([idCom, ests]) => {
            const constructoras = ests.filter(e =>
                String(e.entidad || 'CONSTRUCTORA').toUpperCase() === 'CONSTRUCTORA'
            );

            const supervisionSinVinculo = ests.filter(e =>
                String(e.entidad).toUpperCase() === 'SUPERVISION' &&
                !e.idEstimacionVinculada
            );

            if (supervisionSinVinculo.length > 0 && constructoras.length > 0) {
                comunicadosProcesados++;

                supervisionSinVinculo.forEach(sup => {
                    const match = constructoras.find(c =>
                        String(c.tipo).toUpperCase() === String(sup.tipo).toUpperCase()
                    );

                    if (match) {
                        const res = updateRow(TABLE_ESTIMACIONES, sup.id, {
                            idEstimacionVinculada: match.id
                        });
                        if (res.success) {
                            totalVinculadas++;
                            console.log(`[${contexto}] Comm ${idCom}: ${sup.tipo} → ID ${match.id}`);
                        }
                    }
                });
            }
        });

        console.log(`[${contexto}] FIN. Comunicados: ${comunicadosProcesados}, Vinculadas: ${totalVinculadas}`);

        return {
            success: true,
            message: `Se vincularon ${totalVinculadas} estimaciones de SUPERVISION`,
            data: {
                vinculadas: totalVinculadas,
                comunicadosProcesados: comunicadosProcesados
            }
        };

    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

// ============================================================================
// BITÁCORA DE FACTURAS
// ============================================================================

function agregarBitacoraFactura(idFactura, observacion, emisor, responsable, fecha) {
    const contexto = 'agregarBitacoraFactura';
    try {
        const usuario = Session.getActiveUser().getEmail();
        const fechaRegistro = fecha ? new Date(fecha) : new Date(); // Use provided date or now

        const resultado = createRow('bitacoraFacturas', {
            idFactura: idFactura,
            fecha: fechaRegistro,
            observacion: observacion,
            usuario: usuario,
            tipoEvento: 'OBSERVACION',
            emisor: emisor || '',
            responsable: responsable || ''
        });
        return resultado;
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}

function leerBitacoraFactura(idFactura) {
    const contexto = 'leerBitacoraFactura';
    try {
        const registros = readAllRows('bitacoraFacturas');
        if (!registros.success) return { success: true, data: [] };

        const filtrados = (registros.data || [])
            .filter(r => String(r.idFactura) === String(idFactura))
            .sort((a, b) => new Date(b.fecha) - new Date(a.fecha)); // Descendente

        return { success: true, data: filtrados };
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message, data: [] };
    }
}

/**
 * Registra un complemento de pago vinculado a una factura
 */
function registrarComplemento(idFactura, datos) {
    const contexto = 'registrarComplemento';
    try {
        if (!idFactura) throw new Error('Se requiere el ID de la factura.');
        if (!datos.folio || !datos.fecha) throw new Error('Folio y Fecha son obligatorios.');

        // 1. Verificar Factura Padre
        const facturaRes = buscarPorId(TABLE_FACTURAS_EST, idFactura);
        if (!facturaRes.success) throw new Error('Factura no encontrada.');
        const factura = facturaRes.data;

        // 2. Crear Registro de Complemento
        const nuevoComplemento = {
            idEstimacion: factura.idEstimacion, // Misma estimación
            idFacturaRelacionada: idFactura,
            folioFactura: datos.folio, // Referencia del pago
            uuid: datos.uuid || '',     // UUID
            fecha: datos.fecha, // Fecha del complemento
            fechaPago: datos.fecha, // Fecha de pago
            tipo: 2, // 2 = COMPLEMENTO (Numerico por requerimiento)
            monto: datos.monto || 0,
            iva: datos.iva || 0,
            total: datos.total || 0,
            estatusSAT: 'VIGENTE',
            fechaCreo: new Date()
        };

        const crearRes = insertarRegistro(TABLE_FACTURAS_EST, nuevoComplemento);
        if (!crearRes.success) throw new Error(crearRes.message);

        // 3. Actualizar Factura Padre (Fecha Pago)
        actualizarRegistro(TABLE_FACTURAS_EST, idFactura, {
            fechaPago: datos.fecha,
            estatusSAT: 'PAGADO' // Asumimos pagado al registrar complemento
        });

        return { success: true, data: { message: 'Complemento registrado correctamente.' } };

    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message };
    }
}
