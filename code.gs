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

    presupuestoLineas: {
        sheetName: 'PresupuestoLineas',
        primaryField: 'id',
        headers: ['id', 'idActualizacion', 'descripcion', 'categoria', 'importe', 'fechaCreacion'],
        requiredFields: ['idActualizacion', 'descripcion', 'importe'],
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