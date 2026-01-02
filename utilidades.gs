/**
 * =================================================================
 * ARCHIVO DE UTILIDADES
 * =================================================================
 * Contiene funciones de ayuda para interactuar con Google Sheets
 * y manipular datos.
 */

/**
 * Normaliza un texto a un formato consistente para comparaciones.
 * Convierte a minúsculas, quita acentos y caracteres no alfanuméricos.
 * @param {*} valor El valor a normalizar.
 * @returns {string} El texto normalizado.
 */
function normalizarTexto(valor) {
    // Convierte el valor a string, asegurando que no sea nulo o indefinido.
    return String(valor ?? '')
        .toLowerCase()
        // Separa los caracteres de sus acentos (ej: "é" se convierte en "e" + "´").
        .normalize('NFD')
        // Elimina los acentos diacríticos.
        .replace(/\p{Diacritic}/gu, '')
        // Elimina cualquier caracter que no sea una letra (a-z) o un número (0-9).
        .replace(/[^a-z0-9]/g, '');
}

/**
 * Normaliza claves o identificadores de catálogo reutilizando la lógica base.
 * Se mantiene como alias semántico para mantener compatibilidad con llamadas anteriores.
 * @param {*} valor Valor a normalizar.
 * @returns {string} Clave normalizada.
 */
function normalizarClave(valor) {
    return normalizarTexto(valor);
}

/**
 * Convierte un valor a identificador numérico cuando es posible.
 * Devuelve null si el valor no representa un número finito.
 * @param {*} value Valor a evaluar.
 * @returns {number|null} Número convertido o null.
 */
function toNumericId(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Obtiene el objeto de una hoja de cálculo por su nombre.
 * @param {string} nombreHoja El nombre exacto de la pestaña en Google Sheets.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet|null} El objeto de la hoja o null si no se encuentra.
 */
function obtenerHoja(nombreHoja) {
    // Obtiene la hoja activa y busca la pestaña por su nombre.
    return SpreadsheetApp.getActive().getSheetByName(nombreHoja);
}

/**
 * Lee todos los datos de una tabla, separando encabezados y filas de datos.
 * @param {string} nombreHoja El nombre de la hoja a leer.
 * @returns {{
 * sheet: GoogleAppsScript.Spreadsheet.Sheet,
 * headers: string[],
 * rows: any[][]
 * }} Un objeto con la hoja, sus encabezados y las filas de datos no vacías.
 */
function obtenerDatosTabla(nombreHoja) {
    const hoja = obtenerHoja(nombreHoja);
    if (!hoja) {
        // Si la hoja no existe, devuelve una estructura vacía para evitar errores.
        return { sheet: null, headers: [], rows: [] };
    }
    // Obtiene todos los valores del rango de datos de la hoja.
    const valores = hoja.getDataRange().getValues();
    if (valores.length === 0) {
        // Si no hay valores, devuelve los encabezados y filas como arreglos vacíos.
        return { sheet: hoja, headers: [], rows: [] };
    }

    // Desestructura el arreglo para separar la primera fila (encabezados) del resto.
    const [encabezados, ...filas] = valores;

    // Filtra las filas para eliminar aquellas que estén completamente vacías.
    const filasNoVacias = filas.filter(fila => fila.join('').trim() !== '');

    return { sheet: hoja, headers: encabezados, rows: filasNoVacias };
}

/**
 * Convierte una fila en un objeto utilizando el mapeo lógico de la definición.
 * @param {{headers: Object<string, string[]>}} def Definición de la tabla en TABLE_DEFINITIONS.
 * @param {string[]} encabezados Encabezados reales obtenidos de la hoja.
 * @param {any[]} fila Datos crudos correspondientes a los encabezados.
 * @returns {object} Objeto normalizado (ej: {id: 1, cuenta: '...'}).
 */
function filaAObjeto(def, encabezados, fila) {
    // Mapa para relacionar headers normalizados con sus claves lógicas
    const headerMap = {};

    // --- INICIO PATCH DE COMPATIBILIDAD ---
    // Detectamos si 'def.headers' es un Array (viejo) o un Objeto (nuevo)
    if (Array.isArray(def.headers)) {
        // Modo Legado: headers = ['id', 'nombre', ...]
        def.headers.forEach(headerName => {
            // En modo legado, la clave y el header son lomos
            headerMap[normalizarTexto(headerName)] = headerName;
        });
    } else {
        // Modo Nuevo: headers = { id: ['id', 'ID'], ... }
        for (const key in def.headers) {
            const val = def.headers[key];
            if (Array.isArray(val)) {
                val.forEach(headerVariant => {
                    headerMap[normalizarTexto(headerVariant)] = key;
                });
            } else if (val) {
                // Protección contra definiciones mal formadas { id: 'id' }
                headerMap[normalizarTexto(val)] = key;
            }
        }
    }
    // --- FIN PATCH DE COMPATIBILIDAD ---

    const objetoFila = {};
    encabezados.forEach((encabezado, i) => {
        if (encabezado) {
            const normalizedHeader = normalizarTexto(encabezado);
            const key = headerMap[normalizedHeader];
            if (key) {
                objetoFila[key] = fila[i];
            }
        }
    });
    return objetoFila;
}

/**
 * Busca el índice de una columna dentro de un arreglo de encabezados considerando
 * posibles alias configurados en las definiciones de tabla.
 * @param {string[]} headers Lista de encabezados reales de la hoja de cálculo.
 * @param {string|string[]} candidates Lista (o valor único) con los nombres esperados del encabezado.
 * @returns {number} Índice de la columna o -1 si no se encontró coincidencia.
 */
function buscarIndiceColumna(headers, candidates) {
    if (!Array.isArray(headers) || !headers.length) {
        return -1;
    }

    const candidateList = Array.isArray(candidates) ? candidates : [candidates];
    const normalizedCandidates = candidateList
        .filter(value => value != null && value !== '')
        .map(value => normalizarTexto(value));

    if (!normalizedCandidates.length) {
        return -1;
    }

    for (let index = 0; index < headers.length; index++) {
        const header = headers[index];
        if (header == null || header === '') continue;

        const normalizedHeader = normalizarTexto(header);
        if (normalizedCandidates.includes(normalizedHeader)) {
            return index;
        }
    }

    return -1;
}

/**
 * Construye una fila alineada con los encabezados proporcionados utilizando los valores
 * de un objeto de registro.
 * @param {string[]} headers Encabezados de la hoja de cálculo.
 * @param {Object<string, any>} record Objeto que contiene los valores a colocar en la fila.
 * @returns {any[]} Arreglo listo para escribirse en la hoja.
 */
function construirFilaPorEncabezados(headers, record) {
    const row = [];
    const normalizedRecord = {};

    if (record && typeof record === 'object') {
        Object.keys(record).forEach(key => {
            const normalizedKey = normalizarTexto(key);
            normalizedRecord[normalizedKey] = record[key];
        });
    }

    headers.forEach(header => {
        const normalizedHeader = normalizarTexto(header);

        if (Object.prototype.hasOwnProperty.call(normalizedRecord, normalizedHeader)) {
            row.push(normalizedRecord[normalizedHeader]);
        } else if (record && Object.prototype.hasOwnProperty.call(record, header)) {
            row.push(record[header]);
        } else {
            row.push('');
        }
    });

    return row;
}

/**
 * Calcula el siguiente identificador numérico consecutivo con base en las filas existentes.
 * @param {any[][]} rows Colección de filas actuales de la tabla.
 * @param {number} [idIndex=0] Índice de la columna donde se almacena el identificador.
 * @returns {number} El siguiente ID disponible (1 si no existían registros).
 */
function obtenerSiguienteId(rows, idIndex) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return 1;
    }

    const firstRow = rows.find(row => row !== null && row !== undefined);
    if (firstRow === undefined) {
        return 1;
    }

    const isObjectRow = typeof firstRow === 'object' && !Array.isArray(firstRow);

    let extractor;
    if (isObjectRow) {
        const candidateKeys = Array.isArray(idIndex)
            ? idIndex.filter(key => typeof key === 'string' && key.trim() !== '')
            : [];

        if (typeof idIndex === 'string' && idIndex.trim() !== '') {
            candidateKeys.push(idIndex);
        }

        if (!candidateKeys.length) {
            candidateKeys.push('id');
        }

        extractor = row => {
            if (!row || typeof row !== 'object') return undefined;
            for (const key of candidateKeys) {
                if (Object.prototype.hasOwnProperty.call(row, key)) {
                    return row[key];
                }
            }
            if (Object.prototype.hasOwnProperty.call(row, 'id')) {
                return row.id;
            }
            return undefined;
        };
    } else {
        const index = Number.isInteger(idIndex) && idIndex >= 0 ? idIndex : 0;
        extractor = row => Array.isArray(row) ? row[index] : undefined;
    }

    let maxId = 0;
    rows.forEach(row => {
        const rawValue = extractor(row);
        const numericId = Number(rawValue);
        if (!Number.isNaN(numericId) && numericId > maxId) {
            maxId = numericId;
        }
    });

    return maxId + 1;
}

function esRespuestaError(respuesta) {
    return !!(respuesta && typeof respuesta === 'object' && respuesta.success === false);
}

function crearRespuestaError(mensaje, options) {
    const response = {
        success: false,
        message: mensaje || 'Error desconocido',
        trace: []
    };

    if (options && typeof options === 'object') {
        const { source, error, trace, code, details } = options;

        if (trace && Array.isArray(trace)) {
            response.trace = trace.slice();
        }

        if (source) {
            response.trace.unshift(String(source));
        }

        if (code !== undefined) {
            response.code = code;
        }

        if (details !== undefined) {
            response.details = details;
        }

        if (error instanceof Error) {
            response.errorType = error.name;
            response.errorMessage = error.message;
            response.stack = error.stack;
        }
    }

    if (!Array.isArray(response.trace)) {
        response.trace = [];
    }

    return response;
}

function propagarRespuestaError(source, respuesta, extras) {
    let result;

    if (esRespuestaError(respuesta)) {
        result = { ...respuesta };
    } else {
        const mensajeBase = extras && extras.message ? extras.message : 'Error desconocido';
        result = crearRespuestaError(mensajeBase, { source });
    }

    const trace = Array.isArray(result.trace) ? result.trace.slice() : [];
    if (source) {
        trace.unshift(String(source));
    }
    result.trace = trace;

    if (extras && typeof extras === 'object') {
        if (extras.message) {
            result.message = extras.message;
        }
        if (extras.code !== undefined) {
            result.code = extras.code;
        }
        if (extras.details !== undefined) {
            result.details = extras.details;
        }
    }

    return result;
}

/**
 * Crea un Map a partir de un array de objetos, usando el valor de un campo específico como clave.
 * @param {Array<Object>} array El array de objetos a mapear.
 * @param {string} keyFieldName El nombre de la propiedad cuyo valor se usará como clave en el Map (ej: 'id', 'idComunicado').
 * @returns {Map<string|number, Object>} Un Map donde las claves son los valores del campo especificado y los valores son los objetos completos.
 */
function mapeoPorCampo(array, keyFieldName) {
    const map = new Map();
    if (!Array.isArray(array) || !keyFieldName) {
        // Devuelve un mapa vacío si la entrada no es válida
        return map;
    }

    array.forEach(item => {
        // Verifica que el item sea un objeto y tenga la propiedad clave
        if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, keyFieldName)) {
            const key = item[keyFieldName];
            // Opcional: convertir la clave a string si siempre quieres claves string
            // const key = String(item[keyFieldName] ?? '').trim(); 

            // Evita claves nulas o indefinidas si no las quieres en el mapa
            if (key !== null && key !== undefined) {
                // Si ya existe una clave (en caso de duplicados en el array original),
                // esta línea sobrescribirá con el último item encontrado.
                // Podrías añadir lógica aquí si necesitas manejar duplicados de otra forma.
                map.set(key, item);
            }
        }
    });

    return map;
}


/**
 * Busca un valor en un Map usando una clave, intentando tanto la versión
 * string como la numérica de la clave.
 * @param {Map<string|number, any>} mapa El Map en el que se buscará.
 * @param {string|number|null|undefined} id La clave a buscar. Se intentará como string y como número.
 * @returns {any|null} El valor encontrado en el mapa asociado a la clave, o null si la clave no se encuentra o es inválida.
 */
const obtenerDesdeMapa = (mapa, id) => {
    const clave = String(id ?? '').trim();
    if (!clave) {
        return null;
    }
    // Intenta buscar con la clave como string
    if (mapa.has(clave)) {
        return mapa.get(clave);
    }
    // Si falla como string, intenta como número (si es un número válido)
    const claveNumerica = Number(clave);
    if (Number.isFinite(claveNumerica) && mapa.has(claveNumerica)) {
        return mapa.get(claveNumerica);
    }
    // Si no se encuentra de ninguna forma, devuelve null
    return null;
};



/**
 * Lee una tabla usando {@link readAllRows} y devuelve sus registros mapeados
 * por el campo clave solicitado.
 * @param {string} nombreTabla - Clave definida en TABLE_DEFINITIONS (ej. "cuentas").
 * @param {string} campoClave - Nombre de la propiedad que se usará como llave en el mapa.
 * @returns {Map<string|number, Object>} Mapa con los registros indexados por el campo dado.
 */
function obtenerCamposMapeados(nombreTabla, campoClave) {
    const lista = readAllRows(nombreTabla);
    if (!lista.success) {
        return new Map();
    }
    return mapeoPorCampo(lista.data || [], campoClave);
}


/**
* Busca el primer objeto en un array cuyo valor en un campo específico
* coincida con el valor buscado, usando comparación segura de strings.
* @param {string|number|null|undefined} valorBuscado El valor a buscar.
* @param {string} campoDeBusqueda El nombre de la propiedad (campo) a comparar en cada objeto.
* @param {Array<Object>} arrayDatos El array de objetos donde buscar.
* @returns {Object|null} El primer objeto encontrado que cumple la condición, o null si no se encuentra o las entradas son inválidas.
*/
function encontrarObjeto(valorBuscado, campoDeBusqueda, arrayDatos) {
    // 1. Validar entradas
    if (!Array.isArray(arrayDatos)) {
        console.error("encontrarObjeto: El tercer argumento ('arrayDatos') debe ser un array.");
        return null;
    }
    if (!campoDeBusqueda || typeof campoDeBusqueda !== 'string') {
        console.error("encontrarObjeto: El segundo argumento ('campoDeBusqueda') debe ser un string con el nombre del campo.");
        return null;
    }

    // 2. Preparar el valor a buscar para comparación segura
    const valorNormalizado = String(valorBuscado ?? '').trim();

    // 3. Usar Array.prototype.find() para buscar
    const encontrado = arrayDatos.find(item => {
        // Verifica que 'item' sea un objeto y tenga la propiedad 'campoDeBusqueda'
        if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, campoDeBusqueda)) {
            // Obtiene y prepara el valor del campo en el item actual
            const valorItem = String(item[campoDeBusqueda] ?? '').trim();
            // Compara
            return valorItem === valorNormalizado;
        }
        // Si el item no es válido o no tiene el campo, no coincide
        return false;
    });

    // 4. Devolver el objeto encontrado o null si no se encontró
    return encontrado || null;
}

// --- Ejemplo de Uso ---

// const misDatos = [
//   { id: 101, codigo: 'A5', descripcion: 'Detalle A' },
//   { id: 102, codigo: 'B8', descripcion: 'Detalle B' },
//   { id: 103, codigo: 'A5', descripcion: 'Detalle C' }
// ];
// const valorQueBusco = 'B8';
// const campoDondeBuscar = 'codigo';

// const objetoEncontrado = encontrarObjeto(valorQueBusco, campoDondeBuscar, misDatos);

// console.log(objetoEncontrado); // Devolvería { id: 102, codigo: 'B8', descripcion: 'Detalle B' }

/**
 * Parche de Configuración Dinámico
 * Inyecta definiciones faltantes en TABLE_DEFINITIONS para asegurar compatibilidad.
 */
var _CONFIG_PARCHEADA = false;
function confirmarConfiguracion() {
    if (_CONFIG_PARCHEADA) return;

    if (typeof TABLE_DEFINITIONS === 'undefined') return;

    // 1. Agregar columna idAseguradora a Siniestros
    if (TABLE_DEFINITIONS.siniestros) {
        if (!TABLE_DEFINITIONS.siniestros.headers) TABLE_DEFINITIONS.siniestros.headers = {};

        if (!TABLE_DEFINITIONS.siniestros.headers.idAseguradora) {
            TABLE_DEFINITIONS.siniestros.headers.idAseguradora = ['idAseguradora', 'ID ASEGURADORA', 'Aseguradora ID', 'id_aseguradora'];
        }
    }

    // 2. Definir Tabla Aseguradoras si no existe
    if (!TABLE_DEFINITIONS.aseguradoras) {
        TABLE_DEFINITIONS.aseguradoras = {
            sheetName: 'Aseguradoras',
            primaryField: 'nombre',
            headers: {
                id: ['id', 'ID'],
                nombre: ['Aseguradora', 'Nombre', 'NOMBRE'],
                descripcion: ['Descripcion', 'DESCRIPCION']
            }
        };
    }
    _CONFIG_PARCHEADA = true;
}