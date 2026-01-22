/**
 * Punto de entrada principal para la aplicación web.
 * Esta función se ejecuta cuando alguien visita la URL de la aplicación.
 */
function doGet(e) {
    return HtmlService.createTemplateFromFile('index')
        .evaluate()
        .setTitle('Gestor de Comunicados')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Permite incrustar archivos HTML dentro de otros, útil para plantillas.
 * @param {string} nombreArchivo El nombre del archivo HTML a incluir (sin la extensión .html).
 * @returns {string} El contenido del archivo HTML procesado.
 */
function include(nombreArchivo) {
    return HtmlService.createTemplateFromFile(nombreArchivo).evaluate().getContent();
}

/**
 * DEFINICIÓN DE TABLAS DE LA BASE DE DATOS
 * Actualizado al esquema: 12 de Diciembre 2025
 * Basado en archivos CSV: dbComunicados (Referencias, Ajustadores, Aseguradoras, etc.)
 */
const TABLE_DEFINITIONS = {

    // === MÓDULO PRINCIPAL ===

    cuentas: {
        sheetName: 'Referencias',
        primaryField: 'id',
        headers: ['id', 'referencia', 'idAjustador'],
        requiredFields: ['referencia'],
        uniqueFields: []
    },

    comunicados: {
        sheetName: 'Comunicados',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            idReferencia: ['idReferencia', 'Referencia', 'ID Referencia'],
            comunicado: ['comunicado', 'Comunicado', 'Clave'],
            status: ['status', 'Estatus', 'Estado'],
            idSustituido: ['idSustituido', 'Sustituido Por']
        },
        requiredFields: ['idReferencia', 'comunicado'],
        uniqueFields: []
    },

    datosGenerales: {
        sheetName: 'DatosGenerales',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            idComunicado: ['idComunicado', 'Comunicado', 'Ref - Comunicado', 'Clave', 'Folio', 'Oficio', 'No. Oficio', 'Referencia del Comunicado', 'Referencia', 'Ref', 'Num Oficio', 'Numero Oficio'],
            descripcion: ['descripcion', 'Descripción', 'Descripcion'],
            fecha: ['fecha', 'Fecha'],
            idEstado: ['idEstado', 'Estado', 'ID Estado'],
            idDR: ['idDR', 'Distrito', 'Distrito de Riego', 'ID Distrito'],
            idEmpresa: ['idEmpresa', 'Empresa'],
            fechaAsignacion: ['fechaAsignacion', 'Fecha Asignación'],
            idSiniestro: ['idSiniestro', 'Siniestro', 'ID Siniestro', 'Evento', 'Fenomeno'],
            idActualizacion: ['idActualizacion', 'Actualización'],
            idAjustador: ['idAjustador', 'Ajustador', 'Nombre Ajustador', 'ID Ajustador']
        },
        requiredFields: ['idComunicado'],
        uniqueFields: []
    },

    // === NUEVOS CATÁLOGOS Y RELACIONES ===

    ajustadores: {
        sheetName: 'Ajustadores',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            nombreAjustador: ['nombreAjustador', 'nombre', 'ajustador', 'Nombre Ajustador'],
            nombre: 'nombre' // Fallback legacy
        },
        requiredFields: [],
        uniqueFields: []
    },

    aseguradoras: {
        sheetName: 'Aseguradoras',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            // Mapeamos 'aseguradora' a los posibles nombres de columna
            aseguradora: ['aseguradora', 'nombre', 'descripción', 'descripcion', 'Aseguradora']
        },
        requiredFields: [],
        uniqueFields: []
    },

    empresas: {
        sheetName: 'Empresas',
        primaryField: 'id',
        headers: ['id', 'razonSocial'],
        requiredFields: [],
        uniqueFields: []
    },

    // === CATÁLOGOS GEOGRÁFICOS Y DE SINIESTROS ===

    estados: {
        sheetName: 'Estados',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            estado: ['estado', 'Estado', 'ESTADO', 'Nombre', 'Entidad', 'Descripcion']
        },
        requiredFields: [],
        uniqueFields: []
    },

    distritosRiego: {
        sheetName: 'DistritosRiego',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            distritoRiego: ['distritoRiego', 'Distrito', 'Nombre', 'Descripcion']
        },
        requiredFields: [],
        uniqueFields: []
    },

    siniestros: {
        sheetName: 'Siniestros',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            siniestro: ['siniestro', 'Siniestro', 'Nombre'],
            fenomeno: ['fenomeno', 'Fenómeno', 'Fenomeno'],
            fondo: ['fondo', 'Fondo'],
            fi: ['fi', 'FI', 'Fecha Incidencia'],
            idAseguradora: ['idAseguradora', 'Aseguradora', 'ID Aseguradora']
        },
        requiredFields: ['siniestro'],
        uniqueFields: []
    },

    // === PRESUPUESTO Y FINANZAS ===

    actualizaciones: {
        sheetName: 'Actualizaciones',
        primaryField: 'id',
        headers: [
            'id',
            'idComunicado',
            'consecutivo',
            'esOrigen',
            'revision',
            'monto',           // Calculado de lineas
            'montoCapturado',  // Manual / Override
            'montoSupervisión', // 5%
            'idPresupuesto',
            'fecha'
        ],
        requiredFields: ['idComunicado'],
        uniqueFields: []
    },

    presupuestos: {
        sheetName: 'Presupuestos',
        primaryField: 'id',
        headers: [
            'id',
            'idPadre',
            'esPartida',
            'consecutivo',
            'codigo',
            'descripcion',
            'unidad',
            'fecha'
        ],
        requiredFields: [],
        uniqueFields: []
    },

    detallePresupuesto: {
        sheetName: 'DetallePresupuesto',
        primaryField: 'id',
        headers: [
            'id',
            'idActualizacion',
            'idPresupuesto',
            'cantidad',
            'precioUnitario',
            'importe'
        ],
        requiredFields: [],
        uniqueFields: []
    },

    descripcionLineas: {
        sheetName: 'DescripcionLineas',
        primaryField: 'id',
        headers: ['id', 'descripcion', 'categoria'],
        requiredFields: ['descripcion'],
        uniqueFields: []
    },

    presupuestoLineas: {
        sheetName: 'PresupuestoLineas',
        primaryField: 'id',
        headers: ['id', 'idActualizacion', 'idLinea', 'categoria', 'importe', 'esVigente', 'fechaCreacion'],
        requiredFields: ['idActualizacion', 'idLinea', 'importe'],
        uniqueFields: []
    },

    // === SISTEMA ===

    bitacora: {
        sheetName: 'Bitacora',
        primaryField: 'id',
        headers: ['id', 'idComunicado', 'tipo', 'fecha', 'registro'],
        requiredFields: [],
        uniqueFields: []
    },

    equipo: {
        sheetName: 'Equipo',
        primaryField: 'id',
        headers: ['id', 'idComunicado', 'tipo', 'nombre', 'detalles'],
        requiredFields: ['idComunicado', 'tipo'],
        uniqueFields: []
    },

    relacionContratistas: {
        sheetName: 'RelacionContratistas',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            idComunicado: ['idComunicado', 'Comunicado'],
            idEmpresa: ['idEmpresa', 'Empresa', 'ID Empresa'],
            esContratista: ['esContratista', 'Es Contratista'],
            esVigente: ['esVigente', 'Es Vigente', 'Vigente'],
            fechaAsignacion: ['fechaAsignacion', 'Fecha Asignación', 'Fecha']
        },
        requiredFields: ['idComunicado', 'idEmpresa'],
        uniqueFields: []
    },

    facturas: {
        sheetName: 'Facturas',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            idComunicado: ['idComunicado', 'Comunicado', 'Ref - Comunicado'],
            folio: ['folio', 'Folio', 'Factura'],
            fecha: ['fecha', 'Fecha', 'Fecha Factura'],
            monto: ['monto', 'Monto', 'Total', 'Importe'],
            uuid: ['uuid', 'UUID', 'Folio Fiscal'],
            estatus: ['estatus', 'Estatus', 'Estado'],
            proveedor: ['proveedor', 'Proveedor', 'Emisor']
        },
        requiredFields: ['folio', 'monto'],
        uniqueFields: ['uuid']
    },

    // === MÓDULO DE ESTIMACIONES ===

    estimaciones: {
        sheetName: 'Estimaciones',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            idComunicado: ['idComunicado', 'Comunicado', 'ID Comunicado'],
            entidad: ['entidad', 'Entidad'],  // CONSTRUCTORA, SUPERVISION
            idEmpresa: ['idEmpresa', 'Empresa', 'ID Empresa'],
            tipo: ['tipo', 'Tipo'],
            numero: ['numero', 'Número', 'No.'],
            monto: ['monto', 'Monto', 'Estimado', 'Importe Estimado'],
            montoAvanceFisico: ['montoAvanceFisico', 'Monto Avance Físico', 'Avance Físico', 'Estimación', 'montoEstimado'],
            porcentajeAvanceFisico: ['porcentajeAvanceFisico', 'Porcentaje Avance Físico', 'Avance Físico %', '% Avance'],
            amortizacion: ['amortizacion', 'Amortización', 'Amortizacion'],
            iva: ['iva', 'IVA', 'Impuesto'],
            montoTotal: ['montoTotal', 'Monto Total', 'Total'],
            fechaCorte: ['fechaCorte', 'Fecha Corte', 'Fecha'],
            periodoInicio: ['periodoInicio', 'Periodo Inicio', 'Inicio'],
            periodoFin: ['periodoFin', 'Periodo Fin', 'Fin'],
            estatusInterno: ['estatusInterno', 'Estatus', 'Estado']
        },
        requiredFields: ['idComunicado', 'entidad', 'tipo'],
        uniqueFields: []
    },

    facturasEstimaciones: {
        sheetName: 'FacturasEstimaciones',
        primaryField: 'id',
        headers: {
            id: ['id', 'ID'],
            idEstimacion: ['idEstimacion', 'Estimación', 'ID Estimación'],
            folioFactura: ['folioFactura', 'Folio', 'Factura'],
            uuid: ['uuid', 'UUID', 'Folio Fiscal'],
            fecha: ['fecha', 'Fecha Factura', 'Fecha Emision'],
            monto: ['monto', 'Monto', 'Importe', 'Subtotal'],
            iva: ['iva', 'IVA', 'Impuesto'],
            total: ['total', 'Total'],
            tipo: ['tipo', 'Tipo', 'Complemento'], // Antes complemento
            idFacturaRelacionada: ['idFacturaRelacionada', 'Factura Relacionada', 'ID Relacionado'],
            fechaPago: ['fechaPago', 'Fecha Pago', 'Fecha de Pago'],
            estatusSAT: ['estatusSAT', 'Estatus SAT'],
            archivoXml: ['archivoXml', 'XML', 'Archivo XML'],
            archivoPdf: ['archivoPdf', 'PDF', 'Archivo PDF'],
            fechaEntrega: ['fechaEntrega', 'Fecha Entrega CONAGUA', 'Entrega CONAGUA']
        },
        requiredFields: ['idEstimacion', 'folioFactura'],
        uniqueFields: ['uuid']
    },

    bitacoraEstimaciones: {
        sheetName: 'BitacoraEstimaciones',
        primaryField: 'id',
        headers: ['id', 'idEstimacion', 'fecha', 'observacion', 'usuario'],
        requiredFields: ['idEstimacion'],
        uniqueFields: []
    },

    bitacoraFacturas: {
        sheetName: 'BitacoraFacturas',
        primaryField: 'id',
        headers: ['id', 'idFactura', 'fecha', 'tipoEvento', 'observacion', 'usuario', 'emisor', 'responsable'],
        requiredFields: ['idFactura'],
        uniqueFields: []
    }
};

function getAppInfo() {
    return {
        appName: 'App Comunicados',
        version: '1.0.0'
    };
}

function getTemplates(names) {
    if (!Array.isArray(names)) {
        // Comportamiento original si no se pasa un array
        return {
            sidebar: include('sidebar'),
            header: include('header')
        };
    }

    const templates = {};
    names.forEach(name => {
        try {
            // En Google Apps Script, createTemplateFromFile('foo') busca 'foo.html'
            // Si tenemos un archivo 'importaciones.js.html', debemos pasar 'importaciones.js'
            let fileName = name;
            if (name.endsWith('.html')) {
                // Si piden x.html, removemos extension porque createTemplateFromFile lo agrega automaticamente
                fileName = name.replace('.html', '');
            }
            // Para archivos .js (ej: 'catalogos.js'), el archivo físico es 'catalogos.js.html'
            // Pero createTemplateFromFile('catalogos.js') lo encontrará correctamente

            console.log(`[getTemplates] Solicitado: "${name}" -> Buscando: "${fileName}"`);

            const content = include(fileName);
            console.log(`[getTemplates] Encontrado: "${fileName}" (Longitud: ${content ? content.length : 0})`);
            templates[name] = content;
        } catch (e) {
            console.error(`[getTemplates] ERROR cargando "${name}": ${e.message}`);
            Logger.log(`No se pudo cargar la plantilla: ${name}. Error: ${e.message}`);
            templates[name] = `<!-- Error: plantilla ${name} no encontrada -->`;
        }
    });
    return templates;
}

/**
 * Wrapper específico para obtener cuentas.
 * Requerido por la lógica del cliente en script.html.
 */
function readCuentas() {
    return readAllRows('cuentas');
}

// ============================================================================
// UTILIDAD: FLUSH DATABASE (Limpiar BD para importación limpia)
// ============================================================================

/**
 * Limpia todas las tablas de la base de datos EXCEPTO 'estados'.
 * Útil para reiniciar la BD antes de una importación limpia.
 * 
 * @returns {Object} Resultado con resumen de tablas limpiadas
 */
function flushDatabase() {
    const contexto = 'flushDatabase';
    console.log(`[${contexto}] Iniciando limpieza de base de datos...`);

    // Tablas a limpiar (en orden para respetar FK)
    const tablasALimpiar = [
        'bitacoraFacturas',       // Depende de facturasEstimaciones
        'bitacoraEstimaciones',   // Depende de estimaciones
        'facturasEstimaciones',   // Depende de estimaciones
        'estimaciones',           // Depende de comunicados
        'presupuestoLineas',  // Depende de actualizaciones
        'actualizaciones',    // Depende de comunicados
        'datosGenerales',     // Depende de comunicados
        'comunicados',        // Depende de cuentas
        'cuentas',            // Depende de ajustadores
        'siniestros',         // Depende de aseguradoras
        'ajustadores',
        'aseguradoras',
        'distritosRiego',
        'empresas',
        'relacionContratistas',
        'equipo'
        // 'estados' - NO SE LIMPIA (permanente)
    ];

    const resultados = {};
    let totalEliminados = 0;

    try {
        tablasALimpiar.forEach(tabla => {
            try {
                console.log(`[${contexto}] Limpiando tabla: ${tabla}...`);

                // Obtener la hoja usando TABLE_DEFINITIONS si existe
                const ss = SpreadsheetApp.getActiveSpreadsheet();
                const def = TABLE_DEFINITIONS[tabla];
                const sheetName = def ? def.sheetName : tabla;
                const sheet = ss.getSheetByName(sheetName);

                if (!sheet) {
                    console.log(`[${contexto}] Tabla ${tabla} (${sheetName}) no encontrada, saltando.`);
                    resultados[tabla] = { status: 'NOT_FOUND', count: 0 };
                    return;
                }

                const lastRow = sheet.getLastRow();

                if (lastRow <= 1) {
                    // Solo tiene encabezado o está vacía
                    console.log(`[${contexto}] Tabla ${tabla} ya está vacía.`);
                    resultados[tabla] = { status: 'ALREADY_EMPTY', count: 0 };
                    return;
                }

                const rowsToDelete = lastRow - 1; // Excluyendo encabezado

                // Eliminar todas las filas de datos (preservar encabezado)
                sheet.deleteRows(2, rowsToDelete);

                console.log(`[${contexto}] Tabla ${tabla}: ${rowsToDelete} filas eliminadas.`);
                resultados[tabla] = { status: 'CLEARED', count: rowsToDelete };
                totalEliminados += rowsToDelete;

            } catch (e) {
                console.error(`[${contexto}] Error limpiando ${tabla}: ${e.message}`);
                resultados[tabla] = { status: 'ERROR', message: e.message };
            }
        });

        SpreadsheetApp.flush();

        console.log(`[${contexto}] Limpieza completada. Total eliminados: ${totalEliminados}`);

        return {
            success: true,
            message: `Base de datos limpiada. ${totalEliminados} registros eliminados.`,
            detalles: resultados,
            totalEliminados: totalEliminados,
            tablasPreservadas: ['estados']
        };

    } catch (e) {
        console.error(`[${contexto}] Error general: ${e.message}`);
        return {
            success: false,
            message: `Error al limpiar BD: ${e.message}`,
            detalles: resultados
        };
    }
}

/**
 * === OBTENER MATRIZ DE PRESUPUESTO ===
 * Función para el modal de matriz de actualizaciones
 * Consulta directa a BD por ID de comunicado
 * @param {number|string} idComunicado - ID del comunicado
 * @returns {Object} { success, data: { comunicado, actualizaciones: [{revision, fecha, lineas}] } }
 */
function getMatrizPresupuesto(idComunicado) {
    // VERSIÓN ULTRA-DEFENSIVA PARA DIAGNÓSTICO
    const contexto = 'getMatrizPresupuesto';

    // Si la función falla antes del try-catch, retornar algo básico
    if (!idComunicado) {
        return { success: false, message: 'ID de comunicado requerido' };
    }

    try {
        console.log(`[${contexto}] INICIO - idComunicado: ${idComunicado}`);

        // PASO 1: Verificar función buscarPorId
        if (typeof buscarPorId !== 'function') {
            return { success: false, message: 'ERROR: buscarPorId no está definida' };
        }
        console.log(`[${contexto}] PASO 1 OK - buscarPorId existe`);

        // PASO 2: Buscar comunicado
        let comunicadoResult;
        try {
            comunicadoResult = buscarPorId('comunicados', idComunicado);
        } catch (e) {
            return { success: false, message: `ERROR en buscarPorId: ${e.message}` };
        }

        if (!comunicadoResult || !comunicadoResult.success) {
            return { success: false, message: `Comunicado no encontrado: ${comunicadoResult?.message || 'sin mensaje'}` };
        }
        console.log(`[${contexto}] PASO 2 OK - Comunicado encontrado`);

        const comunicado = comunicadoResult.data;

        // PASO 3: Verificar función readAllRows
        if (typeof readAllRows !== 'function') {
            return { success: false, message: 'ERROR: readAllRows no está definida' };
        }
        console.log(`[${contexto}] PASO 3 OK - readAllRows existe`);

        // PASO 4: Leer actualizaciones
        let actualizacionesResult;
        try {
            actualizacionesResult = readAllRows('actualizaciones');
        } catch (e) {
            return { success: false, message: `ERROR en readAllRows actualizaciones: ${e.message}` };
        }

        if (!actualizacionesResult || !actualizacionesResult.success) {
            return { success: false, message: 'Error al leer actualizaciones' };
        }
        console.log(`[${contexto}] PASO 4 OK - Actualizaciones leídas: ${actualizacionesResult.data?.length || 0}`);

        // PASO 5: Filtrar actualizaciones
        const actualizaciones = (actualizacionesResult.data || [])
            .filter(a => String(a.idComunicado) === String(idComunicado))
            .sort((a, b) => Number(a.consecutivo || 0) - Number(b.consecutivo || 0));

        console.log(`[${contexto}] PASO 5 OK - Actualizaciones filtradas: ${actualizaciones.length}`);

        if (actualizaciones.length === 0) {
            return {
                success: true,
                data: {
                    comunicado: { id: comunicado.id, descripcion: comunicado.comunicado },
                    actualizaciones: []
                }
            };
        }

        // PASO 6: Leer líneas de presupuesto
        let lineasResult;
        try {
            lineasResult = readAllRows('presupuestoLineas');
        } catch (e) {
            return { success: false, message: `ERROR en readAllRows presupuestoLineas: ${e.message}` };
        }
        const todasLineas = (lineasResult?.success && lineasResult?.data) ? lineasResult.data : [];
        console.log(`[${contexto}] PASO 6 OK - Total líneas: ${todasLineas.length}`);

        // PASO 7: Leer descripciones
        let descripcionesResult;
        try {
            descripcionesResult = readAllRows('descripcionLineas');
        } catch (e) {
            return { success: false, message: `ERROR en readAllRows descripcionLineas: ${e.message}` };
        }
        const descripciones = (descripcionesResult?.success && descripcionesResult?.data) ? descripcionesResult.data : [];
        console.log(`[${contexto}] PASO 7 OK - Total descripciones: ${descripciones.length}`);

        // PASO 8: Crear mapa de descripciones
        const mapDescripciones = new Map();
        descripciones.forEach(d => {
            mapDescripciones.set(String(d.id), d);
        });
        console.log(`[${contexto}] PASO 8 OK - Mapa creado`);

        // PASO 9: Construir resultado
        const actualizacionesConLineas = actualizaciones.map(act => {
            const lineasDeActualizacion = todasLineas.filter(l =>
                String(l.idActualizacion) === String(act.id)
            );

            const lineasEnriquecidas = lineasDeActualizacion.map(linea => {
                const descObj = mapDescripciones.get(String(linea.idLinea));
                let categoria = linea.categoria || (descObj ? descObj.categoria : '') || '';
                if (String(categoria) === '1') categoria = 'DAÑO FISICO';
                if (String(categoria) === '2') categoria = 'DESAZOLVES';

                return {
                    idLinea: linea.idLinea,
                    descripcion: descObj ? descObj.descripcion : 'Sin descripción',
                    categoria: categoria,
                    importe: parseFloat(linea.importe) || 0,
                    consecutivo: linea.consecutivo
                };
            }).sort((a, b) => (Number(a.consecutivo) || 999) - (Number(b.consecutivo) || 999));

            return {
                id: act.id,
                revision: act.esOrigen == 1 ? 'Origen' : (act.revision || ''),
                fecha: act.fecha || '',
                esOrigen: act.esOrigen == 1,
                lineas: lineasEnriquecidas
            };
        });

        console.log(`[${contexto}] PASO 9 OK - Matriz construida`);

        // PASO 10: Retornar resultado
        const resultado = {
            success: true,
            data: {
                comunicado: { id: comunicado.id, descripcion: comunicado.comunicado },
                actualizaciones: actualizacionesConLineas
            }
        };

        console.log(`[${contexto}] PASO 10 OK - Retornando resultado exitoso`);
        return resultado;

    } catch (error) {
        console.error(`[${contexto}] EXCEPCIÓN GENERAL:`, error);
        return {
            success: false,
            message: `Excepción: ${error.message || 'Error desconocido'}`,
            stack: error.stack || ''
        };
    }
}

/**
 * === OBTENER MATRIZ DE PRESUPUESTO (VERSIÓN DIRECTA) ===
 * Función alternativa que hace consultas directas a las hojas
 * sin depender de buscarPorId o readAllRows
 * @param {string} idComunicado - ID del comunicado como string
 * @returns {Object} { success, data: { comunicado, actualizaciones } }
 */
function obtenerMatrizPresupuestoDirecta(idComunicado) {
    const contexto = 'obtenerMatrizPresupuestoDirecta';

    // LOG 1: Entrada a la función
    console.log(`[${contexto}] ========== INICIO ==========`);
    console.log(`[${contexto}] LOG 1 - Argumento recibido: "${idComunicado}"`);
    console.log(`[${contexto}] LOG 1 - Tipo: ${typeof idComunicado}`);
    console.log(`[${contexto}] LOG 1 - Es null: ${idComunicado === null}`);
    console.log(`[${contexto}] LOG 1 - Es undefined: ${idComunicado === undefined}`);

    try {
        // LOG 2: Validación
        if (!idComunicado) {
            console.log(`[${contexto}] LOG 2 - ID vacío, retornando error`);
            return { success: false, message: 'ID de comunicado requerido' };
        }
        console.log(`[${contexto}] LOG 2 - ID válido, continuando...`);

        // LOG 3: Obtener spreadsheet
        console.log(`[${contexto}] LOG 3 - Obteniendo spreadsheet...`);
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        console.log(`[${contexto}] LOG 3 - Spreadsheet: ${ss.getName()}`);

        const idBuscado = String(idComunicado).trim();
        console.log(`[${contexto}] LOG 3 - ID normalizado: "${idBuscado}"`);

        // LOG 4: Leer Comunicados
        console.log(`[${contexto}] LOG 4 - Buscando hoja Comunicados...`);
        const sheetComunicados = ss.getSheetByName('Comunicados');
        if (!sheetComunicados) {
            console.log(`[${contexto}] LOG 4 - ERROR: Hoja Comunicados no encontrada`);
            return { success: false, message: 'Hoja Comunicados no encontrada' };
        }
        console.log(`[${contexto}] LOG 4 - Hoja Comunicados encontrada`);

        const datosComunicados = sheetComunicados.getDataRange().getValues();
        console.log(`[${contexto}] LOG 4 - Total filas Comunicados: ${datosComunicados.length}`);

        const headersCom = datosComunicados[0];
        const idxIdCom = headersCom.indexOf('id');
        const idxComunicadoNombre = headersCom.indexOf('comunicado');
        console.log(`[${contexto}] LOG 4 - Índice columna id: ${idxIdCom}, comunicado: ${idxComunicadoNombre}`);

        let comunicadoEncontrado = null;
        for (let i = 1; i < datosComunicados.length; i++) {
            if (String(datosComunicados[i][idxIdCom]).trim() === idBuscado) {
                comunicadoEncontrado = {
                    id: datosComunicados[i][idxIdCom],
                    comunicado: datosComunicados[i][idxComunicadoNombre] || ''
                };
                console.log(`[${contexto}] LOG 4 - Comunicado encontrado en fila ${i + 1}`);
                break;
            }
        }

        if (!comunicadoEncontrado) {
            console.log(`[${contexto}] LOG 4 - Comunicado NO encontrado: ${idBuscado}`);
            return { success: false, message: `Comunicado ${idBuscado} no encontrado` };
        }
        console.log(`[${contexto}] LOG 4 - Comunicado: ${comunicadoEncontrado.comunicado}`);

        // 2. LEER ACTUALIZACIONES DIRECTO
        const sheetActualizaciones = ss.getSheetByName('Actualizaciones');
        if (!sheetActualizaciones) {
            return { success: true, data: { comunicado: comunicadoEncontrado, actualizaciones: [] } };
        }

        const datosActualizaciones = sheetActualizaciones.getDataRange().getValues();
        const headersAct = datosActualizaciones[0];
        const idxIdAct = headersAct.indexOf('id');
        const idxIdComAct = headersAct.indexOf('idComunicado');
        const idxConsecutivo = headersAct.indexOf('consecutivo');
        const idxEsOrigen = headersAct.indexOf('esOrigen');
        const idxRevision = headersAct.indexOf('revision');
        const idxFecha = headersAct.indexOf('fecha');

        const actualizaciones = [];
        for (let i = 1; i < datosActualizaciones.length; i++) {
            const row = datosActualizaciones[i];
            if (String(row[idxIdComAct]).trim() === idBuscado) {
                actualizaciones.push({
                    id: row[idxIdAct],
                    consecutivo: row[idxConsecutivo] || 0,
                    esOrigen: row[idxEsOrigen] == 1,
                    revision: row[idxRevision] || '',
                    fecha: row[idxFecha] || ''
                });
            }
        }

        actualizaciones.sort((a, b) => Number(a.consecutivo) - Number(b.consecutivo));
        console.log(`[${contexto}] Actualizaciones encontradas: ${actualizaciones.length}`);

        if (actualizaciones.length === 0) {
            return { success: true, data: { comunicado: comunicadoEncontrado, actualizaciones: [] } };
        }

        // 3. LEER LÍNEAS DE PRESUPUESTO DIRECTO
        const sheetLineas = ss.getSheetByName('PresupuestoLineas');
        const todasLineas = [];
        if (sheetLineas) {
            const datosLineas = sheetLineas.getDataRange().getValues();
            const headersLin = datosLineas[0];
            const idxIdActLin = headersLin.indexOf('idActualizacion');
            const idxIdLinea = headersLin.indexOf('idLinea');
            const idxCategoria = headersLin.indexOf('categoria');
            const idxImporte = headersLin.indexOf('importe');
            const idxConsecLin = headersLin.indexOf('consecutivo');

            for (let i = 1; i < datosLineas.length; i++) {
                todasLineas.push({
                    idActualizacion: datosLineas[i][idxIdActLin],
                    idLinea: datosLineas[i][idxIdLinea],
                    categoria: datosLineas[i][idxCategoria] || '',
                    importe: datosLineas[i][idxImporte] || 0,
                    consecutivo: datosLineas[i][idxConsecLin] || 0
                });
            }
        }
        console.log(`[${contexto}] Total líneas en BD: ${todasLineas.length}`);

        // 4. LEER DESCRIPCIONES DIRECTO
        const sheetDesc = ss.getSheetByName('DescripcionLineas');
        const mapDescripciones = new Map();
        if (sheetDesc) {
            const datosDesc = sheetDesc.getDataRange().getValues();
            const headersDesc = datosDesc[0];
            const idxIdDesc = headersDesc.indexOf('id');
            const idxDescripcion = headersDesc.indexOf('descripcion');
            const idxCatDesc = headersDesc.indexOf('categoria');

            for (let i = 1; i < datosDesc.length; i++) {
                mapDescripciones.set(String(datosDesc[i][idxIdDesc]), {
                    descripcion: datosDesc[i][idxDescripcion] || '',
                    categoria: datosDesc[i][idxCatDesc] || ''
                });
            }
        }
        console.log(`[${contexto}] Total descripciones: ${mapDescripciones.size}`);

        // 5. CONSTRUIR RESULTADO
        const actualizacionesConLineas = actualizaciones.map(act => {
            const lineasDeAct = todasLineas.filter(l => String(l.idActualizacion) === String(act.id));

            const lineasEnriquecidas = lineasDeAct.map(linea => {
                const descObj = mapDescripciones.get(String(linea.idLinea));
                let cat = linea.categoria || (descObj ? descObj.categoria : '') || '';
                if (String(cat) === '1') cat = 'DAÑO FISICO';
                if (String(cat) === '2') cat = 'DESAZOLVES';

                return {
                    idLinea: linea.idLinea,
                    descripcion: descObj ? descObj.descripcion : 'Sin descripción',
                    categoria: cat,
                    importe: parseFloat(linea.importe) || 0,
                    consecutivo: linea.consecutivo
                };
            }).sort((a, b) => (Number(a.consecutivo) || 999) - (Number(b.consecutivo) || 999));

            return {
                id: act.id,
                revision: act.esOrigen ? 'Origen' : (act.revision || ''),
                fecha: act.fecha,
                esOrigen: act.esOrigen,
                lineas: lineasEnriquecidas
            };
        });

        console.log(`[${contexto}] LOG FINAL - Matriz completada con ${actualizacionesConLineas.length} actualizaciones`);
        const resultado = { success: true, data: { comunicado: comunicadoEncontrado, actualizaciones: actualizacionesConLineas } };
        console.log(`[${contexto}] LOG FINAL - Retornando resultado exitoso`);
        return resultado;

    } catch (error) {
        console.error(`[${contexto}] EXCEPCIÓN:`, error);
        console.error(`[${contexto}] EXCEPCIÓN mensaje:`, error.message);
        return { success: false, message: `Error: ${error.message}` };
    }
}

