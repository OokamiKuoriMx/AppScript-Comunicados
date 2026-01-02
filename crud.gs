/**
 * =================================================================
 * ARCHIVO CRUD (Create, Read, Update, Delete)
 * =================================================================
 * Contiene las funciones principales para interactuar con los datos
 * de las hojas de cálculo como si fueran una base de datos.
 */

/**
 * Busca la clave lógica correspondiente a un header de la hoja.
 * Compatible con formato legado (array) y nuevo (objeto con arrays de alias).
 * @param {Object|Array} defHeaders - def.headers de TABLE_DEFINITIONS
 * @param {string} header - nombre del header a buscar
 * @returns {string|null} - la clave lógica o null si no se encuentra
 */
function buscarClavePorHeader(defHeaders, header) {
    if (!defHeaders || !header) return null;

    const normalizedHeader = normalizarTexto(header);

    // Formato nuevo: headers es un objeto { clave: ['alias1', 'alias2'] }
    if (!Array.isArray(defHeaders) && typeof defHeaders === 'object') {
        for (const key in defHeaders) {
            const aliases = defHeaders[key];
            if (Array.isArray(aliases)) {
                // { clave: ['alias1', 'alias2'] }
                if (aliases.some(alias => normalizarTexto(alias) === normalizedHeader)) {
                    return key;
                }
            } else if (typeof aliases === 'string') {
                // { clave: 'alias' } - formato mal formado pero soportado
                if (normalizarTexto(aliases) === normalizedHeader) {
                    return key;
                }
            }
        }
    }

    // Formato legado: headers es un array ['campo1', 'campo2']
    if (Array.isArray(defHeaders)) {
        const found = defHeaders.find(h => normalizarTexto(h) === normalizedHeader);
        if (found) return found; // En modo legado, la clave es el mismo header
    }

    return null;
}

/**
 * Obtiene los alias de un campo desde la definición de headers.
 * @param {Object|Array} defHeaders - def.headers de TABLE_DEFINITIONS
 * @param {string} campo - nombre lógico del campo
 * @returns {string[]} - array de alias o array con el campo mismo si es legado
 */
function obtenerAliases(defHeaders, campo) {
    if (!defHeaders || !campo) return [campo];

    // Formato nuevo: headers es un objeto
    if (!Array.isArray(defHeaders) && typeof defHeaders === 'object') {
        const aliases = defHeaders[campo];
        if (Array.isArray(aliases)) return aliases;
        if (typeof aliases === 'string') return [aliases];
    }

    // Formato legado: el campo es su propio alias
    return [campo];
}

/**
 * Crea un nuevo registro en la tabla especificada.
 * @param {string} nombreTabla La clave de la tabla en TABLE_DEFINITIONS (ej: 'cuentas').
 * @param {object} datos Objeto con los datos a insertar (ej: { cuenta: 'Nueva Cuenta' }).
 * @returns {{ success: boolean, data?: object, message: string }}
 */
function createRow(nombreTabla, datos) {
    if (typeof confirmarConfiguracion === 'function') confirmarConfiguracion();
    const contexto = 'createRow';
    const def = TABLE_DEFINITIONS[nombreTabla];
    if (!def) {
        return crearRespuestaError(`La tabla "${nombreTabla}" no está definida.`, {
            source: contexto,
            details: { nombreTabla }
        });
    }

    for (const campo of def.requiredFields) {
        if (!datos[campo] || String(datos[campo]).trim() === '') {
            return crearRespuestaError(`El campo requerido "${campo}" no puede estar vacío.`, {
                source: contexto,
                details: { nombreTabla, campo }
            });
        }
    }

    const { sheet, headers, rows } = obtenerDatosTabla(def.sheetName);
    if (!sheet) {
        return crearRespuestaError(`La hoja de cálculo "${def.sheetName}" no fue encontrada.`, {
            source: contexto,
            details: { nombreTabla, sheetName: def.sheetName }
        });
    }

    const indiceId = buscarIndiceColumna(headers, def.headers?.[def.primaryField] || def.primaryField);
    if (indiceId === -1) {
        return crearRespuestaError(`La columna del campo primario "${def.primaryField}" no se encontró en la hoja.`, {
            source: contexto,
            details: { nombreTabla, primaryField: def.primaryField }
        });
    }

    const idProporcionado = Object.prototype.hasOwnProperty.call(datos, def.primaryField)
        && String(datos[def.primaryField] ?? '').trim() !== '';

    if (!idProporcionado) {
        datos[def.primaryField] = obtenerSiguienteId(rows, indiceId);
    } else {
        const valorId = datos[def.primaryField];
        const existeId = rows.some(fila => normalizarTexto(fila[indiceId]) === normalizarTexto(valorId));
        if (existeId) {
            return crearRespuestaError(`El valor "${valorId}" para el campo primario "${def.primaryField}" ya existe.`, {
                source: contexto,
                details: { nombreTabla, primaryField: def.primaryField, valorId }
            });
        }
    }

    for (const campo of def.uniqueFields) {
        const aliases = obtenerAliases(def.headers, campo);
        const indiceCampoUnico = headers.findIndex(h => aliases.some(alias => normalizarTexto(alias) === normalizarTexto(h)));
        if (indiceCampoUnico !== -1 && datos[campo]) {
            const existe = rows.some(fila => normalizarTexto(fila[indiceCampoUnico]) === normalizarTexto(datos[campo]));
            if (existe) {
                return crearRespuestaError(`El valor "${datos[campo]}" para el campo "${campo}" ya existe y debe ser único.`, {
                    source: contexto,
                    details: { nombreTabla, campo, valor: datos[campo] }
                });
            }
        }
    }

    const nuevaFila = headers.map(header => {
        const clave = buscarClavePorHeader(def.headers, header);
        return datos[clave] ?? '';
    });

    try {
        sheet.appendRow(nuevaFila);
        return { success: true, data: datos, message: 'Registro creado con éxito.' };
    } catch (error) {
        return crearRespuestaError(`Error al escribir en la hoja: ${error.message}`, {
            source: contexto,
            error,
            details: { nombreTabla, sheetName: def.sheetName }
        });
    }
}

/**
 * Crea MULTIPLES registros en la tabla especificada (Batch Insert).
 * Optimizado para rendimiento: usa validacion en memoria y una sola escritura final.
 * 
 * @param {string} nombreTabla Clave en TABLE_DEFINITIONS (ej: 'comunicados').
 * @param {Array<Object>} loteDatos Array de objetos a insertar.
 * @returns {{ success: boolean, count: number, ids: Array<string|number>, message: string }}
 */
function createBatch(nombreTabla, loteDatos) {
    if (!loteDatos || loteDatos.length === 0) return { success: true, count: 0, ids: [] };

    const contexto = 'createBatch';
    console.log(`[${contexto}] Iniciando batch insert de ${loteDatos.length} registros en "${nombreTabla}"`);

    // 1. Validaciones previas
    const def = TABLE_DEFINITIONS[nombreTabla];
    if (!def) throw new Error(`Tabla "${nombreTabla}" no definida.`);

    const { sheet, headers, rows } = obtenerDatosTabla(def.sheetName);
    if (!sheet) throw new Error(`Hoja "${def.sheetName}" no encontrada.`);

    // 2. Preparar ID Generator
    // Encontrar último ID numérico para incrementar
    const indiceId = buscarIndiceColumna(headers, def.headers?.[def.primaryField] || def.primaryField);
    if (indiceId === -1) throw new Error(`Columna ID no encontrada en "${def.sheetName}".`);

    // Calcular siguiente ID inicial
    let nextId = 1;
    if (rows.length > 0) {
        const maxId = rows.reduce((max, row) => {
            const val = parseFloat(row[indiceId]);
            return (!isNaN(val) && val > max) ? val : max;
        }, 0);
        nextId = maxId + 1;
    }

    // 3. Procesar Lote
    const matrixToWrite = [];
    const generatedIds = [];

    loteDatos.forEach((datos, i) => {
        // Asignar ID si no viene
        if (!datos[def.primaryField]) {
            datos[def.primaryField] = nextId++;
        }

        // Mapear a fila de hoja
        const fila = headers.map(header => {
            const clave = buscarClavePorHeader(def.headers, header);
            return datos[clave] !== undefined ? datos[clave] : ''; // null/undef -> cadena vacia
        });

        matrixToWrite.push(fila);
        generatedIds.push(datos[def.primaryField]);
        // Debug first row construction
        if (i === 0) {
            console.log(`[createBatch] Sample Row 0 construction. Headers: ${headers.join(', ')}`);
            console.log(`[createBatch] Sample Row 0 Data: ${JSON.stringify(datos)}`);
        }
    });

    // 4. Escritura Batch (Una sola llamada a API)
    try {
        if (matrixToWrite.length > 0) {
            // getRange(filaInicio, colInicio, filas, columnas)
            const startRow = sheet.getLastRow() + 1;
            sheet.getRange(startRow, 1, matrixToWrite.length, headers.length).setValues(matrixToWrite);
        }

        console.log(`[${contexto}] Éxito. Insertados ${matrixToWrite.length} registros.`);
        return {
            success: true,
            count: matrixToWrite.length,
            ids: generatedIds,
            message: `Insertados ${matrixToWrite.length} registros correctamente.`
        };

    } catch (error) {
        console.error(`[${contexto}] Error escribiendo batch:`, error);
        return crearRespuestaError(`Error Batch Write en "${nombreTabla}": ${error.message}`, {
            source: contexto, error
        });
    }
}

/**
 * Lee un único registro de la tabla por su ID.
 * @param {string} nombreTabla La clave de la tabla.
 * @param {string|number} id El ID del registro a buscar.
 * @returns {{ success: boolean, data?: object, message: string }}
 */
function readRow(nombreTabla, id) {
    const contexto = 'readRow';
    const def = TABLE_DEFINITIONS[nombreTabla];
    if (!def) {
        return crearRespuestaError(`Tabla "${nombreTabla}" no definida.`, {
            source: contexto,
            details: { nombreTabla }
        });
    }

    const { headers, rows } = obtenerDatosTabla(def.sheetName);
    const indiceId = headers.findIndex(h => normalizarTexto(h) === normalizarTexto(def.primaryField));
    if (indiceId === -1) {
        return crearRespuestaError('No se encontró la columna ID.', {
            source: contexto,
            details: { nombreTabla, sheetName: def.sheetName }
        });
    }

    const filaEncontrada = rows.find(fila => fila[indiceId] == id);
    if (!filaEncontrada) {
        return crearRespuestaError(`Registro con ID "${id}" no encontrado.`, {
            source: contexto,
            details: { nombreTabla, id }
        });
    }

    const objetoFila = filaAObjeto(def, headers, filaEncontrada);
    return { success: true, data: objetoFila, message: 'Registro encontrado.' };
}

/**
 * Actualiza un registro existente en la tabla por su ID.
 * @param {string} nombreTabla La clave de la tabla.
 * @param {string|number} id El ID del registro a actualizar.
 * @param {object} nuevosDatos Objeto con los campos y valores a modificar.
 * @returns {{ success: boolean, data?: object, message: string }}
 */
function updateRow(nombreTabla, id, nuevosDatos) {
    const contexto = 'updateRow';
    const def = TABLE_DEFINITIONS[nombreTabla];
    if (!def) {
        return crearRespuestaError(`Tabla "${nombreTabla}" no definida.`, {
            source: contexto,
            details: { nombreTabla }
        });
    }

    // OBTENER LA HOJA usando obtenerDatosTabla
    const tablaData = SpreadsheetApp.getActive().getSheetByName(def.sheetName);
    const sheet = tablaData;
    if (!sheet) {
        return crearRespuestaError(`No se pudo acceder a la hoja "${def.sheetName}" para tabla "${nombreTabla}".`, {
            source: contexto,
            details: { nombreTabla }
        });
    }

    // REFACTOR: Read raw data to ensure physical row indices are correct (ignoring filters)
    const rawValues = sheet.getDataRange().getValues();
    const headers = rawValues[0];
    const rawRows = rawValues.slice(1);

    // Find index using primary field in raw data
    // Assuming 'id' is always the first column or finding column index
    const idColIndex = buscarIndiceColumna(headers, def.primaryField || 'id');
    const indiceFila = rawRows.findIndex(row => String(row[idColIndex]) === String(id));

    if (indiceFila === -1) {
        return crearRespuestaError(`Registro con ID ${id} no encontrado en tabla "${nombreTabla}"`, {
            source: contexto,
            details: { nombreTabla, id }
        });
    }

    // Use rawRows[indiceFila] as the base 'rows[indiceFila]'
    const currentRow = rawRows[indiceFila];

    console.log(`[updateRow_Raw] Found ID ${id} at Index ${indiceFila} (Sheet Row ${indiceFila + 2})`);

    console.log(`[updateRow] Update Payload Keys: ${Object.keys(nuevosDatos).join(', ')}`);
    console.log(`[updateRow] Headers in Sheet: ${headers.join(', ')}`);

    const filaActualizada = headers.map((header, i) => {
        const clave = buscarClavePorHeader(def.headers, header);
        const nuevoValor = nuevosDatos[clave];
        // Use currentRow from RAW data
        const valorActual = currentRow[i];

        // Debug specific fields if needed
        if (clave === 'fecha' || clave === 'descripcion') {
            console.log(`[updateRow_DBG] Header: "${header}" -> Clave: "${clave}" | NewVal: "${nuevoValor}" vs CurrVal: "${valorActual}"`);
        }

        return nuevoValor !== undefined ? nuevoValor : valorActual;
    });

    // Check if anything actually changed in the array
    const hasChanges = filaActualizada.some((val, i) => String(val) !== String(currentRow[i]));
    console.log(`[updateRow] Computed Row Changes? ${hasChanges}`);

    try {
        sheet.getRange(indiceFila + 2, 1, 1, filaActualizada.length).setValues([filaActualizada]);
        return { success: true, data: filaAObjeto(def, headers, filaActualizada), message: 'Registro actualizado con éxito.' };
    } catch (error) {
        return crearRespuestaError(`Error al actualizar la hoja: ${error.message}`, {
            source: contexto,
            error,
            details: { nombreTabla, id }
        });
    }
}

/**
 * Elimina un registro de la tabla por su ID.
 * @param {string} nombreTabla La clave de la tabla.
 * @param {string|number} id El ID del registro a eliminar.
 * @returns {{ success: boolean, message: string }}
 */
function deleteRow(nombreTabla, id) {
    const contexto = 'deleteRow';
    const def = TABLE_DEFINITIONS[nombreTabla];
    if (!def) {
        return crearRespuestaError(`Tabla "${nombreTabla}" no definida.`, {
            source: contexto,
            details: { nombreTabla }
        });
    }

    const { sheet, headers, rows } = obtenerDatosTabla(def.sheetName);
    const indiceId = headers.findIndex(h => normalizarTexto(h) === normalizarTexto(def.primaryField));
    if (indiceId === -1) {
        return crearRespuestaError('No se encontró la columna ID.', {
            source: contexto,
            details: { nombreTabla, sheetName: def.sheetName }
        });
    }

    const indiceFila = rows.findIndex(fila => fila[indiceId] == id);
    if (indiceFila === -1) {
        return crearRespuestaError(`Registro con ID "${id}" no encontrado para eliminar.`, {
            source: contexto,
            details: { nombreTabla, id }
        });
    }

    try {
        sheet.deleteRow(indiceFila + 2);
        return { success: true, message: 'Registro eliminado con éxito.' };
    } catch (error) {
        return crearRespuestaError(`Error al eliminar la fila: ${error.message}`, {
            source: contexto,
            error,
            details: { nombreTabla, id }
        });
    }
}

/**
 * Lee todos los registros de una tabla y los devuelve como un arreglo de objetos.
 * @param {string} nombreTabla La clave de la tabla en TABLE_DEFINITIONS.
 * @returns {{ success: boolean, data?: object[], message: string }}
 */
function readAllRows(nombreTabla) {
    const contexto = 'readAllRows';
    try {
        console.log(`[${contexto}] Iniciando lectura de tabla: "${nombreTabla}"`);

        const def = TABLE_DEFINITIONS[nombreTabla];
        if (!def) {
            console.error(`[${contexto}] Tabla no definida: "${nombreTabla}"`);
            return crearRespuestaError(`Tabla "${nombreTabla}" no está definida.`, {
                source: contexto,
                details: { nombreTabla }
            });
        }

        console.log(`[${contexto}] Definición encontrada. sheetName: "${def.sheetName}"`);

        const { headers, rows } = obtenerDatosTabla(def.sheetName);

        console.log(`[${contexto}] obtenerDatosTabla retornó:`, {
            headersLength: headers?.length || 0,
            rowsLength: rows?.length || 0,
            headers: headers
        });

        if (!headers || headers.length === 0) {
            console.warn(`[${contexto}] Headers vacíos para tabla "${nombreTabla}"`);
            return { success: true, data: [], message: 'No se encontraron datos.' };
        }

        const datos = rows.map(fila => filaAObjeto(def, headers, fila));

        console.log(`[${contexto}] Datos procesados para "${nombreTabla}":`, {
            totalRegistros: datos.length,
            primerRegistro: datos[0] || null
        });

        return { success: true, data: datos, message: 'Registros leídos con éxito.' };

    } catch (error) {
        console.error(`[${contexto}] Error fatal:`, error);
        return crearRespuestaError(`Error leyendo tabla "${nombreTabla}": ${error.message}`, {
            source: contexto,
            error
        });
    }
}

/**
 * Busca un registro por su identificador primario.
 * @param {string} nombreTabla - Clave de la tabla definida en TABLE_DEFINITIONS.
 * @param {string|number} id - Valor del campo primario a localizar.
 * @return {{ success: boolean, data?: object|null, message?: string }}
 */
function buscarPorId(nombreTabla, id) {
    const contexto = 'buscarPorId';
    try {
        const tabla = String(nombreTabla || '').trim();
        if (!tabla) {
            return crearRespuestaError('Se requiere el nombre de la tabla.', { source: contexto });
        }

        const def = TABLE_DEFINITIONS[tabla];
        if (!def) {
            return crearRespuestaError(`Tabla "${tabla}" no definida.`, {
                source: contexto,
                details: { nombreTabla: tabla }
            });
        }

        const idValor = String(id ?? '').trim();
        if (!idValor) {
            return crearRespuestaError('Se requiere el ID para realizar la búsqueda.', {
                source: contexto,
                details: { nombreTabla: tabla }
            });
        }

        const response = readAllRows(tabla);
        if (!response || response.success !== true || !Array.isArray(response.data)) {
            return propagarRespuestaError(contexto, response, {
                message: response?.message || `No fue posible leer los registros de "${tabla}".`
            });
        }

        const registro = response.data.find(row => String(row?.id ?? '').trim() === idValor) || null;
        if (!registro) {
            return crearRespuestaError(`No se encontró un registro con ID "${idValor}" en la tabla "${tabla}".`, {
                source: contexto,
                details: { nombreTabla: tabla, id: idValor }
            });
        }

        return { success: true, data: registro };
    } catch (error) {
        console.error('Error en buscarPorId:', error, { nombreTabla, id });
        return crearRespuestaError(error.message, {
            source: contexto,
            error,
            details: { nombreTabla, id }
        });
    }
}

/**
 * Busca un registro por el valor de un campo específico.
 * @param {string} nombreTabla - Clave de la tabla definida en TABLE_DEFINITIONS.
 * @param {string} campo - Nombre lógico del campo a comparar.
 * @param {*} valor - Valor a comparar (se compara como string normalizado).
 * @return {{ success: boolean, data?: object|null, message?: string }}
 */
function buscarPorCampo(nombreTabla, campo, valor) {
    const contexto = 'buscarPorCampo';
    try {
        const tabla = String(nombreTabla || '').trim();
        if (!tabla) {
            return crearRespuestaError('Se requiere el nombre de la tabla.', { source: contexto });
        }

        const def = TABLE_DEFINITIONS[tabla];
        if (!def) {
            return crearRespuestaError(`Tabla "${tabla}" no definida.`, {
                source: contexto,
                details: { nombreTabla: tabla }
            });
        }

        const campoBusqueda = String(campo || '').trim();
        if (!campoBusqueda) {
            return crearRespuestaError('Se requiere el nombre del campo para realizar la búsqueda.', {
                source: contexto,
                details: { nombreTabla: tabla }
            });
        }

        const response = readAllRows(tabla);
        if (!response || response.success !== true || !Array.isArray(response.data)) {
            return propagarRespuestaError(contexto, response, {
                message: response?.message || `No fue posible leer los registros de "${tabla}".`
            });
        }

        const normalizedField = normalizarTexto(campoBusqueda);
        const normalizedValue = String(valor ?? '').trim().toLowerCase();

        const registro = response.data.find(row => {
            if (!row || typeof row !== 'object') return false;
            const matchKey = Object.keys(row).find(key => normalizarTexto(key) === normalizedField);
            if (!matchKey) return false;
            const rowValue = row[matchKey];
            if (rowValue instanceof Date && valor instanceof Date) {
                return rowValue.getTime() === valor.getTime();
            }
            return String(rowValue ?? '').trim().toLowerCase() === normalizedValue;
        }) || null;

        if (!registro) {
            return {
                success: true,
                data: null,
                message: `No se encontró un registro en "${tabla}" donde "${campoBusqueda}" coincida con el valor solicitado.`
            };
        }

        return { success: true, data: registro };
    } catch (error) {
        console.error('Error en buscarPorCampo:', error, { nombreTabla, campo, valor });
        return crearRespuestaError(error.message, {
            source: contexto,
            error,
            details: { nombreTabla, campo, valor }
        });
    }
}

/**
 * Wrappers en español para mantener compatibilidad con módulos existentes.
 * Delegan en las funciones CRUD estándar.
 */
function insertarRegistro(nombreTabla, datos) {
    const resultado = createRow(nombreTabla, datos);
    return resultado && resultado.success === false
        ? propagarRespuestaError('insertarRegistro', resultado)
        : resultado;
}

function actualizarRegistro(nombreTabla, id, nuevosDatos) {
    const resultado = updateRow(nombreTabla, id, nuevosDatos);
    return resultado && resultado.success === false
        ? propagarRespuestaError('actualizarRegistro', resultado)
        : resultado;
}

function eliminarRegistro(nombreTabla, id) {
    const resultado = deleteRow(nombreTabla, id);
    return resultado && resultado.success === false
        ? propagarRespuestaError('eliminarRegistro', resultado)
        : resultado;
}

function debugReadCampo() {
    const resultado = buscarPorCampo('datosGenerales', 'idComunicado', 1)
    console.log(resultado, typeof resultado);
}

/**
 * Garantiza que exista un registro en el catálogo indicado.
 * Si el registro ya existe (búsqueda por campo principal), devuelve su ID.
 * Si no existe, lo crea y devuelve el ID del nuevo registro.
 * 
 * @param {string} catalogKey Clave del catálogo en TABLE_DEFINITIONS (ej: 'distritosRiego', 'siniestros').
 * @param {Object} data Datos del registro a buscar/crear. Debe incluir el campo principal del catálogo.
 * @returns {{ success: boolean, created?: boolean, id?: string|number, data?: Object|null, message?: string }}
 */
function ensureCatalogRecord(catalogKey, data) {
    try {
        const definition = TABLE_DEFINITIONS[catalogKey];
        if (!definition) {
            return { success: false, message: `No existe el catálogo "${catalogKey}".` };
        }

        if (!data || typeof data !== 'object') {
            return { success: true, created: false, id: '', data: null };
        }

        // Determinar el campo para búsqueda (no necesariamente el ID principal, sino el campo "nombre")
        let searchField = 'nombre';
        if (catalogKey === 'ajustadores') searchField = 'nombreAjustador';
        else if (catalogKey === 'siniestros') searchField = 'siniestro';
        else if (catalogKey === 'distritosRiego') searchField = 'distritoRiego';
        else if (catalogKey === 'aseguradoras') searchField = 'descripción';
        else if (catalogKey === 'comunicados') searchField = 'comunicado';
        else if (catalogKey === 'cuentas') searchField = 'referencia';
        else if (definition.headers) {
            // Fallback: buscar un campo que parezca nombre
            const headers = Array.isArray(definition.headers) ? definition.headers : Object.keys(definition.headers);
            searchField = headers.find(h => h.toLowerCase().includes('nombre') || h.toLowerCase().includes('descrip')) || headers[1];
        }

        // Obtener el valor a buscar usando el campo determinado
        const searchValue = data[searchField] || data.nombre || data.descripcion || data.label || '';

        if (!searchValue || String(searchValue).trim() === '') {
            return { success: true, created: false, id: '', data: null };
        }

        const normalizedSearch = String(searchValue).trim().toLowerCase();

        // Buscar si ya existe
        const allRecords = readAllRows(catalogKey);
        if (allRecords.success && allRecords.data) {
            const existing = allRecords.data.find(record => {
                const recordValue = record[searchField] || record.nombre || '';
                return String(recordValue).trim().toLowerCase() === normalizedSearch;
            });

            if (existing) {
                return {
                    success: true,
                    created: false,
                    id: existing.id || '',
                    data: existing
                };
            }
        }

        // No existe, crear nuevo registro
        const createResult = createRow(catalogKey, data);
        if (createResult.success) {
            return {
                success: true,
                created: true,
                id: createResult.data?.id || '',
                data: createResult.data || null
            };
        } else {
            return {
                success: false,
                message: createResult.message || 'Error al crear registro en catálogo.'
            };
        }

    } catch (error) {
        console.error('Error en ensureCatalogRecord:', error);
        return { success: false, message: error.message };
    }
}

/**
 * FUNCIÓN DE DIAGNÓSTICO - Ejecutar desde el editor para probar
 * Ve a Ejecutar > Ejecutar función > debugReadCuentas
 * Luego revisa los logs en Ejecuciones
 */
function debugReadCuentas() {
    console.log('=== INICIO DIAGNÓSTICO ===');

    // 1. Verificar TABLE_DEFINITIONS
    const def = TABLE_DEFINITIONS['cuentas'];
    console.log('1. TABLE_DEFINITIONS.cuentas:', JSON.stringify(def, null, 2));

    // 2. Verificar que la hoja existe
    const hoja = SpreadsheetApp.getActive().getSheetByName(def.sheetName);
    console.log('2. Hoja encontrada:', !!hoja, 'Nombre:', def.sheetName);

    if (!hoja) {
        console.error('ERROR: La hoja no existe');
        return;
    }

    // 3. Leer datos directamente
    const valores = hoja.getDataRange().getValues();
    console.log('3. Total filas (incluyendo headers):', valores.length);
    console.log('4. Primera fila (headers):', JSON.stringify(valores[0]));
    if (valores.length > 1) {
        console.log('5. Segunda fila (primer dato):', JSON.stringify(valores[1]));
    }

    // 4. Probar obtenerDatosTabla
    const datosTabla = obtenerDatosTabla(def.sheetName);
    console.log('6. obtenerDatosTabla headers:', JSON.stringify(datosTabla.headers));
    console.log('7. obtenerDatosTabla rows count:', datosTabla.rows.length);

    // 5. Probar filaAObjeto con la primera fila
    if (datosTabla.rows.length > 0) {
        const objetoPrueba = filaAObjeto(def, datosTabla.headers, datosTabla.rows[0]);
        console.log('8. filaAObjeto resultado:', JSON.stringify(objetoPrueba));
    }

    // 6. Probar readAllRows completo
    const resultado = readAllRows('cuentas');
    console.log('9. readAllRows resultado:', JSON.stringify(resultado, null, 2));

    console.log('=== FIN DIAGNÓSTICO ===');
    return resultado;
}

/**
 * Función dedicada para leer Datos Generales.
 * Retorna JSON STRING para evitar errores de serialización de Apps Script (fechas, nulos, etc).
 */
function readDatosGenerales() {
    const contexto = 'readDatosGenerales';
    try {
        console.log(`[${contexto}] Iniciando lectura directa...`);

        // Definición explícita para garantizar que existe
        // Definición explícita con ALIAS para garantizar mapeo correcto
        const def = {
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
            }
        };

        const { headers, rows } = obtenerDatosTabla(def.sheetName);

        // Diagnóstico de hojas si no encuentra la tabla
        if (!headers) {
            const availableSheets = SpreadsheetApp.getActive().getSheets().map(s => s.getName());
            console.warn(`[${contexto}] Hoja '${def.sheetName}' no hallada. Hojas disponibles: ${availableSheets.join(', ')}`);
            return JSON.stringify({ success: true, data: [], message: 'Sheet not found', available: availableSheets });
        }

        if (headers.length === 0) {
            console.warn(`[${contexto}] Headers vacíos`);
            return JSON.stringify({ success: true, data: [], message: 'No records found.' });
        }

        const datos = rows.map(fila => filaAObjeto(def, headers, fila));

        console.log(`[${contexto}] Registros leídos: ${datos.length}`);

        // Retornamos un objeto estándar para que serverCall no falle.
        // Pero la DATA va como string para protegerla.
        return {
            success: true,
            data: JSON.stringify(datos),
            debugHeaders: headers, // DEBUG: Para diagnosticar columnas
            message: 'OK'
        };

    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message, error: String(e) };
    }
}

/**
 * Función dedicada para actualizar Datos Generales.
 * Bypass de updateRow para evitar problemas de TABLE_DEFINITIONS.
 */
function updateDatosGenerales(id, nuevosDatos) {
    const contexto = 'updateDatosGenerales';
    try {
        console.log(`[${contexto}] Actualizando ID: ${id}`, nuevosDatos);

        const def = {
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
            }
        };

        const { headers, sheet, rows } = obtenerDatosTabla(def.sheetName);

        if (!sheet) return JSON.stringify({ success: false, message: 'Hoja no encontrada' });

        const indiceId = headers.findIndex(h => normalizarTexto(h) === 'id');
        const indiceFila = rows.findIndex(fila => String(fila[indiceId]) === String(id));

        if (indiceFila === -1) {
            return JSON.stringify({ success: false, message: 'Registro no encontrado' });
        }

        // Mapear nuevos datos a fila completa (actualizando solo lo enviado)
        // OJO: rows[indiceFila] tiene los datos viejos. 
        // newRow debe construirse combinando viejo + nuevo.
        const currentRow = rows[indiceFila];
        const newRow = headers.map((header, colIndex) => {
            // "header" es el nombre de la columna.
            // Si nuevosDatos tiene esa llave, usamos el nuevo valor.
            let key = header;
            // Ajuste manual de alias si fuera necesario, pero aquí usamos exact match con headers definidos arriba

            if (nuevosDatos[key] !== undefined) {
                return nuevosDatos[key];
            }
            return currentRow[colIndex];
        });

        // Escribir fila (indiceFila + 2, pues rows es dataRange sin header, y Sheets es 1-based)
        // rows comienza en fila 2. 
        // indice 0 es fila 2.
        sheet.getRange(indiceFila + 2, 1, 1, newRow.length).setValues([newRow]);

        return {
            success: true,
            data: JSON.stringify({ success: true, message: 'Actualizado correctamente' }),
            message: 'OK'
        };

    } catch (e) {
        console.error(`[${contexto}] Error:`, e);
        return { success: false, message: e.message, error: String(e) };
    }
}

/**
 * Actualización por lotes para Datos Generales.
 * Recibe un array de objetos con estructura: { id: <id>, data: { campo: valor, ... } }
 */
function updateBatchDatosGenerales(updates) {
    const contexto = 'updateBatchDatosGenerales';
    try {
        console.log(`[${contexto}] Procesando ${updates.length} actualizaciones.`);

        const def = {
            sheetName: 'DatosGenerales',
            primaryField: 'id',
            headers: {
                id: ['id', 'ID'],
                idComunicado: ['idComunicado', 'Comunicado', 'Ref - Comunicado'],
                descripcion: ['descripcion', 'Descripción', 'Descripcion'],
                fecha: ['fecha', 'Fecha'],
                idEstado: ['idEstado', 'Estado', 'ID Estado'],
                idDR: ['idDR', 'Distrito', 'Distrito de Riego', 'ID Distrito'],
                idEmpresa: ['idEmpresa', 'Empresa'],
                fechaAsignacion: ['fechaAsignacion', 'Fecha Asignación'],
                idSiniestro: ['idSiniestro', 'Siniestro', 'ID Siniestro'],
                idActualizacion: ['idActualizacion', 'Actualización'],
                idAjustador: ['idAjustador', 'Ajustador', 'Nombre Ajustador', 'ID Ajustador']
            }
        };

        const { headers, sheet, rows } = obtenerDatosTabla(def.sheetName);
        if (!sheet) return { success: true, data: JSON.stringify({ success: false, message: 'Hoja no encontrada' }) };

        const indiceId = headers.findIndex(h => normalizarTexto(h) === 'id');

        // Crear un mapa de ID -> IndiceFila para búsqueda rápida O(1)
        const mapIdFila = new Map();
        rows.forEach((row, index) => {
            const idVal = String(row[indiceId]);
            mapIdFila.set(idVal, index);
        });

        let successCount = 0;
        let errors = [];

        updates.forEach(update => {
            const id = String(update.id);
            const nuevosDatos = update.data;

            if (!mapIdFila.has(id)) {
                errors.push(`ID ${id} no encontrado`);
                return;
            }

            const rowIndex = mapIdFila.get(id); // Índice en array 'rows'
            const currentRow = rows[rowIndex];

            // Construir nueva fila combinando
            const newRow = headers.map((header, colIndex) => {
                let key = header;
                if (nuevosDatos[key] !== undefined) {
                    return nuevosDatos[key];
                }
                return currentRow[colIndex];
            });

            // Actualizar en hoja (rowIndex + 2)
            try {
                sheet.getRange(rowIndex + 2, 1, 1, newRow.length).setValues([newRow]);
                // Actualizar también en memoria 'rows'
                rows[rowIndex] = newRow;
                successCount++;
            } catch (err) {
                errors.push(`Error actualizando ID ${id}: ${err.message}`);
            }
        });

        return {
            success: true,
            data: JSON.stringify({
                success: true,
                message: `Actualizados ${successCount} de ${updates.length}`,
                errors: errors
            }),
            message: 'Batch Processed'
        };

    } catch (e) {
        console.error(`[${contexto}] Error general:`, e);
        return { success: false, message: e.message, error: String(e) };
    }
}