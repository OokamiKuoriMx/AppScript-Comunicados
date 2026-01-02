/**
 * datosGenerales.crud.js
 * -----------------------------------------------------------------------------
 * CRUD especializado para la hoja de Datos Generales asociada a los comunicados.
 */


function createDatosGenerales(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { success: false, message: 'Datos inválidos: se requiere un objeto con los campos del detalle.' };
    }

    const definition = TABLE_DEFINITIONS.datosGenerales;
    if (!definition) {
        return { success: false, message: 'No existe la definición de la tabla "datosGenerales".' };
    }

    const { headers, rows } = obtenerDatosTabla(definition.sheetName, definition.namedRange);
    if (!headers.length) {
        return { success: false, message: 'La hoja "DatosGenerales" no está disponible.' };
    }

    const payload = { ...data };
    const idIdx = buscarIndiceColumna(headers, definition.headers?.id || definition.idHeaders || []);
    if (idIdx !== -1 && (payload.id === undefined || payload.id === null || payload.id === '')) {
        payload.id = obtenerSiguienteId(rows, idIdx);
    }

    try {
        const result = createRow('datosGenerales', payload);
        if (!result.success) {
            return result;
        }

        const storedData = result.data || payload;
        const rowData = construirFilaPorEncabezados(headers, storedData);
        const formatted = filaAObjeto(definition, headers, rowData);

        const canonicalId = formatted.id ?? storedData.id ?? '';

        if (canonicalId !== undefined && canonicalId !== null) {
            formatted.id = canonicalId;
        }

        return {
            success: true,
            message: result.message || 'Datos generados registrados correctamente.',
            id: canonicalId,
            data: formatted,
            sheetRow: null
        };
    } catch (error) {
        console.error('Error al insertar en Datos Generales:', error);
        return { success: false, message: 'No fue posible guardar los datos generales.' };
    }
}