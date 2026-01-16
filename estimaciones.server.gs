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
        const datos = { ...datosFactura, idEstimacion };
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
        const estimaciones = (readAllRows(TABLE_ESTIMACIONES).data || [])
            .filter(e => String(e.idComunicado) === String(idComunicado));

        const facturas = readAllRows(TABLE_FACTURAS_EST).data || [];

        // Anidar facturas dentro de cada estimación
        return estimaciones.map(est => ({
            ...est,
            facturas: facturas.filter(f => String(f.idEstimacion) === String(est.id))
        }));
    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return [];
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
    const ejemplos = [
        // CONSTRUCTORA - puede tener todas las estimaciones
        ['GL098774', 'L27', 'CONSTRUCTORA', 'ANTICIPO', 'A', '500000.00', '2025-01-15', '', '', 'PAGADO'],
        ['GL098774', 'L27', 'CONSTRUCTORA', 'ESTIMACION', '1', '150000.00', '2025-02-01', '2025-01-01', '2025-01-31', 'EN_REVISION'],
        ['GL098774', 'L27', 'CONSTRUCTORA', 'ESTIMACION', '2', '200000.00', '2025-03-01', '2025-02-01', '2025-02-28', 'PENDIENTE'],
        ['GL098774', 'L27', 'CONSTRUCTORA', 'FINIQUITO', 'F', '100000.00', '2025-04-01', '', '', 'PENDIENTE'],
        // SUPERVISION - solo ANTICIPO y FINIQUITO (5%)
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
 * 
 * @param {string} razonSocial - Razón social del contratista
 * @returns {Object} { success, id, created, data }
 */
function _buscarOCrearContratista(razonSocial) {
    const contexto = '_buscarOCrearContratista';
    const normalizado = _normalizarRazonSocial(razonSocial);

    if (!normalizado) {
        return { success: false, message: 'Razón social vacía' };
    }

    try {
        // Buscar si ya existe
        const empresas = readAllRows('empresas').data || [];
        const existente = empresas.find(e =>
            _normalizarRazonSocial(e.razonSocial) === normalizado
        );

        if (existente) {
            return {
                success: true,
                created: false,
                id: existente.id,
                data: existente
            };
        }

        // No existe, crear nuevo registro
        const nuevoId = Utilities.getUuid();
        const nuevoRegistro = {
            id: nuevoId,
            razonSocial: normalizado
        };

        const resultado = createRow('empresas', nuevoRegistro);

        if (resultado.success) {
            console.log(`[${contexto}] Creado contratista: ${normalizado} -> ID: ${nuevoId}`);
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

        // Cargar datos necesarios
        const cache = _loadCatalogsCache();
        const datosGenerales = readAllRows('datosGenerales').data || [];

        const resultados = {
            procesados: 0,
            contratistasCreados: 0,
            contratistasExistentes: 0,
            comunicadosActualizados: 0,
            errores: []
        };

        dataRows.forEach((row, idx) => {
            const ref = String(row[idxRef] || '').trim();
            const sufijo = String(row[idxComunicado] || '').trim();
            const nombreContratista = String(row[idxContratista] || '').trim();

            // Validar fila
            if (!ref || !sufijo) {
                resultados.errores.push(`Fila ${idx + 2}: Referencia o ComunicadoId vacío`);
                return;
            }

            if (!nombreContratista) {
                resultados.errores.push(`Fila ${idx + 2}: Nombre de contratista vacío`);
                return;
            }

            // Construir clave del comunicado (ej: GL098774-L01)
            const comunicadoClave = `${ref}-${sufijo}`;

            // Buscar el comunicado
            const comunicado = cache.comunicados.find(c =>
                String(c.comunicado).trim().toUpperCase() === comunicadoClave.toUpperCase()
            );

            if (!comunicado) {
                resultados.errores.push(`Fila ${idx + 2}: Comunicado '${comunicadoClave}' no encontrado`);
                return;
            }

            // Verificar que el comunicado NO tenga idSustituido (es ORIGEN)
            if (comunicado.idSustituido && String(comunicado.idSustituido).trim() !== '') {
                resultados.errores.push(`Fila ${idx + 2}: '${comunicadoClave}' no es ORIGEN (tiene sustituido)`);
                return;
            }

            // Buscar o crear el contratista
            const contratista = _buscarOCrearContratista(nombreContratista);

            if (!contratista.success) {
                resultados.errores.push(`Fila ${idx + 2}: Error con contratista - ${contratista.message}`);
                return;
            }

            if (contratista.created) {
                resultados.contratistasCreados++;
            } else {
                resultados.contratistasExistentes++;
            }

            // Buscar el datosGenerales del comunicado
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
                console.log(`[${contexto}] Actualizado ${comunicadoClave} -> Empresa: ${contratista.id}`);
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
 * @returns {Object} Resultado con el contenido CSV en base64
 */
function generarPlantillaContratistas() {
    const headers = [
        'referenciaAjustador',  // Referencia del ajustador (ej: GL098774)
        'comunicadoId',         // Sufijo del comunicado ORIGEN (ej: L01)
        'nombreContratista'     // Razón Social de la empresa
    ];

    // Ejemplo de datos
    const ejemplos = [
        ['GL098774', 'L01', 'CONSTRUCTORA ABC S.A. DE C.V.'],
        ['GL098774', 'L02', 'SERVICIOS HIDRAULICOS DEL NORTE S.A.'],
        ['GL098775', 'L01', 'CONSTRUCCIONES Y PROYECTOS XYZ S.A. DE C.V.'],
        ['GL098776', 'L01A', 'CONSTRUCTORA ABC S.A. DE C.V.']  // Misma empresa, diferente comunicado
    ];

    // Construir CSV
    let csv = headers.join(',') + '\n';
    ejemplos.forEach(row => {
        csv += row.join(',') + '\n';
    });

    const base64 = Utilities.base64Encode(csv, Utilities.Charset.UTF_8);

    return {
        success: true,
        data: {
            content: base64,
            filename: 'plantilla_contratistas.csv',
            mimeType: 'text/csv'
        }
    };
}
