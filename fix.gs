/**
 * Script de Corrección de Duplicados en Descripciones
 * Objetivo: Unificar descripciones idénticas que se duplicaron por categoría
 * y re-apuntar las líneas de presupuesto al ID único.
 */
function corregirDuplicadosDescripciones() {
    const DRY_RUN = false; // <--- CAMBIA A false PARA APLICAR CAMBIOS REALES

    console.log(`[INICIO] Modo: ${DRY_RUN ? 'SIMULACIÓN (No se borrará nada)' : 'EJECUCIÓN REAL (Cuidado)'}`);

    // 1. Cargar Datos
    const respDesc = readAllRows('descripcionLineas');
    const respPres = readAllRows('presupuestoLineas');

    if (!respDesc.success || !respPres.success) {
        console.error("Error leyendo tablas.");
        return;
    }

    let descripciones = respDesc.data;
    let presupuestos = respPres.data;

    console.log(`Leídas ${descripciones.length} descripciones y ${presupuestos.length} líneas de presupuesto.`);

    // 2. Identificar Duplicados y Crear Mapa de Migración
    const mapaUnicos = new Map(); // Key: Descripcion Normalizada -> ID Maestro
    const mapaMigracion = new Map(); // Key: ID Viejo -> ID Maestro
    const idsParaBorrar = [];

    descripciones.forEach(d => {
        // Normalizar: Mayúsculas y quitar espacios extra
        const textoNorm = String(d.descripcion).toUpperCase().trim();

        if (!mapaUnicos.has(textoNorm)) {
            // Es la primera vez que vemos esta descripción -> Es el MAESTRO
            mapaUnicos.set(textoNorm, d.id);
            // Su destino es él mismo (no cambia)
            mapaMigracion.set(String(d.id), d.id);
        } else {
            // Ya existe -> Es un DUPLICADO
            const idMaestro = mapaUnicos.get(textoNorm);
            mapaMigracion.set(String(d.id), idMaestro);
            idsParaBorrar.push(d.id);
        }
    });

    console.log(`Diagnóstico:`);
    console.log(`- Descripciones Únicas (Maestras): ${mapaUnicos.size}`);
    console.log(`- Duplicados a eliminar: ${idsParaBorrar.length}`);

    if (idsParaBorrar.length === 0) {
        console.log("¡No hay duplicados! Tu base de datos está limpia.");
        return;
    }

    // 3. Calcular actualizaciones en PresupuestoLineas
    const actualizacionesPresupuesto = [];

    presupuestos.forEach(p => {
        const idActual = String(p.idLinea);
        const idNuevo = String(mapaMigracion.get(idActual));

        // Si el ID al que apunta debe cambiar
        if (idNuevo && idActual !== idNuevo) {
            actualizacionesPresupuesto.push({
                idRow: p.id,
                idLineaAnterior: idActual,
                idLineaNuevo: idNuevo
            });
        }
    });

    console.log(`- Líneas de presupuesto a corregir: ${actualizacionesPresupuesto.length}`);

    // 4. EJECUCIÓN (Si no es Dry Run)
    if (!DRY_RUN) {

        // A) Actualizar PresupuestoLineas
        console.log("A) Actualizando referencias en PresupuestoLineas...");
        let contUpd = 0;
        actualizacionesPresupuesto.forEach(upd => {
            try {
                // Asumiendo que tienes una función updateRow, si no, usa batch
                const res = updateRow('presupuestoLineas', upd.idRow, { idLinea: upd.idLineaNuevo });
                if (res.success) contUpd++;
            } catch (e) {
                console.error(`Error actualizando presupuesto ID ${upd.idRow}: ${e.message}`);
            }
        });
        console.log(`   -> ${contUpd} líneas de presupuesto re-apuntadas.`);

        // B) Borrar Descripciones Duplicadas
        console.log("B) Eliminando descripciones obsoletas...");
        let contDel = 0;
        // Ordenar descendente para borrar sin afectar índices si fuera hoja de cálculo, 
        // pero con ID directo no importa tanto.
        idsParaBorrar.forEach(idDel => {
            try {
                const res = deleteRow('descripcionLineas', idDel);
                if (res.success) contDel++;
            } catch (e) {
                console.error(`Error borrando descripción ID ${idDel}: ${e.message}`);
            }
        });
        console.log(`   -> ${contDel} descripciones eliminadas.`);

        console.log("PROCESO TERMINADO EXITOSAMENTE.");

    } else {
        console.log("--- FIN DE SIMULACIÓN ---");
        console.log("Cambia DRY_RUN = false para ejecutar los cambios.");
        if (actualizacionesPresupuesto.length > 0) {
            console.log("Ejemplo de cambio:", actualizacionesPresupuesto[0]);
        }
    }
}

/**
 * Script de Reenumeración de IDs en DescripcionLineas
 * VERSIÓN SEGURA: Reenumera primero descripcionLineas, luego actualiza presupuestoLineas
 * Puede re-ejecutarse si se interrumpe.
 */
function reenumerarDescripciones() {
    const DRY_RUN = false; // <--- CAMBIA A false PARA APLICAR CAMBIOS REALES

    console.log(`[INICIO] Modo: ${DRY_RUN ? 'SIMULACIÓN' : 'EJECUCIÓN REAL'}`);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetDesc = ss.getSheetByName('DescripcionLineas');
    const sheetPres = ss.getSheetByName('PresupuestoLineas');

    if (!sheetDesc || !sheetPres) {
        console.error("No se encontraron las hojas DescripcionLineas o PresupuestoLineas");
        return;
    }

    // 1. Leer datos actuales
    const dataDesc = sheetDesc.getDataRange().getValues();
    const dataPres = sheetPres.getDataRange().getValues();

    const headersDesc = dataDesc[0];
    const headersPres = dataPres[0];

    const idDescCol = headersDesc.indexOf('id');
    const idLineaPresCol = headersPres.indexOf('idLinea');

    console.log(`DescripcionLineas: ${dataDesc.length - 1} registros`);
    console.log(`PresupuestoLineas: ${dataPres.length - 1} registros`);

    // 2. Crear mapa de migración basado en posición de fila
    // Fila 2 -> ID 1, Fila 3 -> ID 2, etc.
    const mapaMigracion = new Map();

    for (let i = 1; i < dataDesc.length; i++) {
        const idViejo = String(dataDesc[i][idDescCol]);
        const idNuevo = i; // Fila 2 = ID 1
        mapaMigracion.set(idViejo, idNuevo);
    }

    console.log(`Mapa de migración: ${mapaMigracion.size} registros`);

    // 3. Preparar nuevos valores para PresupuestoLineas
    const nuevosIdLinea = [];
    let cambiosNecesarios = 0;

    for (let i = 1; i < dataPres.length; i++) {
        const idLineaActual = String(dataPres[i][idLineaPresCol]);
        const idLineaNuevo = mapaMigracion.get(idLineaActual);

        if (idLineaNuevo !== undefined) {
            nuevosIdLinea.push([idLineaNuevo]);
            if (idLineaActual !== String(idLineaNuevo)) {
                cambiosNecesarios++;
            }
        } else {
            // Mantener el valor actual si no está en el mapa (caso raro)
            nuevosIdLinea.push([dataPres[i][idLineaPresCol]]);
            console.warn(`idLinea ${idLineaActual} no encontrado en mapa, manteniendo valor`);
        }
    }

    console.log(`Cambios necesarios en PresupuestoLineas: ${cambiosNecesarios}`);

    // 4. Preparar nuevos IDs para DescripcionLineas
    const nuevosIdDesc = [];
    let renumeracionesNecesarias = 0;

    for (let i = 1; i < dataDesc.length; i++) {
        const idViejo = Number(dataDesc[i][idDescCol]);
        const idNuevo = i; // Fila 2 = ID 1
        nuevosIdDesc.push([idNuevo]);
        if (idViejo !== idNuevo) {
            renumeracionesNecesarias++;
        }
    }

    console.log(`Reenumeraciones necesarias en DescripcionLineas: ${renumeracionesNecesarias}`);

    // 5. EJECUCIÓN (Si no es Dry Run)
    if (!DRY_RUN) {

        // ORDEN CRÍTICO: Actualizar ambas tablas en una sola operación batch
        // Esto minimiza el riesgo de inconsistencias

        console.log("Aplicando cambios en batch...");

        // A) Reenumerar DescripcionLineas (columna ID)
        if (nuevosIdDesc.length > 0) {
            const rangeDesc = sheetDesc.getRange(2, idDescCol + 1, nuevosIdDesc.length, 1);
            rangeDesc.setValues(nuevosIdDesc);
            console.log(`✓ ${nuevosIdDesc.length} IDs reenumerados en DescripcionLineas`);
        }

        // B) Actualizar PresupuestoLineas (columna idLinea)
        if (nuevosIdLinea.length > 0) {
            const rangePres = sheetPres.getRange(2, idLineaPresCol + 1, nuevosIdLinea.length, 1);
            rangePres.setValues(nuevosIdLinea);
            console.log(`✓ ${nuevosIdLinea.length} referencias actualizadas en PresupuestoLineas`);
        }

        console.log("=== PROCESO TERMINADO EXITOSAMENTE ===");

    } else {
        console.log("--- FIN DE SIMULACIÓN ---");
        console.log("Cambia DRY_RUN = false para ejecutar los cambios.");

        // Mostrar ejemplos de migración
        let count = 0;
        for (let [viejo, nuevo] of mapaMigracion) {
            if (count++ < 5 && viejo !== String(nuevo)) {
                console.log(`  Ejemplo: ID ${viejo} -> ${nuevo}`);
            }
        }
    }
}

/**
 * ===================================================================
 * SCRIPT DE LIMPIEZA: Eliminar descripcionLineas Huérfanas
 * ===================================================================
 * 
 * Este script identifica y elimina entradas en la tabla `descripcionLineas`
 * que ya no están referenciadas por ninguna `presupuestoLineas`.
 * 
 * Esto puede ocurrir cuando:
 * - Se eliminaron comunicados sin limpiar las descripciones asociadas
 * - Errores durante el proceso de importación
 * - Datos corruptos del proceso de normalización anterior
 * 
 * INSTRUCCIONES:
 * 1. Ejecutar primero en modo simulación (DRY_RUN = true)
 * 2. Revisar el log para verificar qué se eliminará
 * 3. Cambiar DRY_RUN = false y ejecutar para aplicar cambios
 * ===================================================================
 */

function limpiarDescripcionesHuerfanas() {
    const DRY_RUN = true; // <--- CAMBIA A false PARA APLICAR CAMBIOS REALES

    console.log(`[INICIO] Limpieza de descripcionLineas huérfanas`);
    console.log(`[MODO] ${DRY_RUN ? 'SIMULACIÓN (No se borrará nada)' : '⚠️ EJECUCIÓN REAL (Se eliminarán registros)'}`);
    console.log('---------------------------------------------------');

    // 1. Cargar todas las descripcionLineas
    const respDesc = readAllRows('descripcionLineas');
    if (!respDesc.success) {
        console.error('Error leyendo descripcionLineas:', respDesc.message);
        return;
    }
    const descripciones = respDesc.data || [];
    console.log(`[1] Total descripcionLineas: ${descripciones.length}`);

    // 2. Cargar todas las presupuestoLineas
    const respPres = readAllRows('presupuestoLineas');
    if (!respPres.success) {
        console.error('Error leyendo presupuestoLineas:', respPres.message);
        return;
    }
    const lineasPresupuesto = respPres.data || [];
    console.log(`[2] Total presupuestoLineas: ${lineasPresupuesto.length}`);

    // 3. Crear Set de todos los idLinea que están en uso
    const idsEnUso = new Set();
    lineasPresupuesto.forEach(linea => {
        if (linea.idLinea) {
            idsEnUso.add(String(linea.idLinea));
        }
    });
    console.log(`[3] IDs de descripción en uso: ${idsEnUso.size}`);

    // 4. Identificar descripciones huérfanas (no están en el Set)
    const huerfanas = descripciones.filter(desc => !idsEnUso.has(String(desc.id)));
    console.log(`[4] Descripciones huérfanas encontradas: ${huerfanas.length}`);

    if (huerfanas.length === 0) {
        console.log('✅ No hay descripciones huérfanas. La base de datos está limpia.');
        return;
    }

    // 5. Mostrar muestra de las huérfanas
    console.log('');
    console.log('[MUESTRA] Primeras 10 huérfanas:');
    huerfanas.slice(0, 10).forEach((h, i) => {
        console.log(`  ${i + 1}. ID=${h.id}: "${String(h.descripcion || '').substring(0, 50)}..."`);
    });
    console.log('');

    // 6. Eliminar (o simular eliminación)
    if (DRY_RUN) {
        console.log(`[SIMULACIÓN] Se eliminarían ${huerfanas.length} registros.`);
        console.log('[SIMULACIÓN] Cambia DRY_RUN = false para aplicar cambios.');
    } else {
        console.log(`[ELIMINANDO] ${huerfanas.length} descripciones huérfanas...`);

        let eliminadas = 0;
        let errores = 0;

        huerfanas.forEach((h, index) => {
            try {
                const result = deleteRow('descripcionLineas', h.id);
                if (result && result.success) {
                    eliminadas++;
                } else {
                    errores++;
                    console.warn(`  Error eliminando ID ${h.id}: ${result?.message || 'Error desconocido'}`);
                }

                // Log de progreso cada 100 registros
                if ((index + 1) % 100 === 0) {
                    console.log(`  Progreso: ${index + 1} / ${huerfanas.length}`);
                }
            } catch (e) {
                errores++;
                console.error(`  Excepción eliminando ID ${h.id}:`, e);
            }
        });

        console.log('');
        console.log(`[RESULTADO] Eliminadas: ${eliminadas}, Errores: ${errores}`);
    }

    console.log('---------------------------------------------------');
    console.log('[FIN] Proceso completado.');
}

/**
 * ===================================================================
 * SCRIPT DE SETUP: Crear Hojas para módulo de Estimaciones
 * ===================================================================
 * 
 * Este script crea las hojas necesarias para el módulo de Estimaciones
 * si no existen en el Spreadsheet.
 * 
 * INSTRUCCIONES:
 * 1. Ejecutar desde el editor de Apps Script: Ejecutar > crearHojasEstimaciones
 * 2. Verificar que se crearon las 4 hojas en el Spreadsheet
 * ===================================================================
 */
function crearHojasEstimaciones() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const hojas = [
        {
            nombre: 'Estimaciones',
            headers: ['id', 'idComunicado', 'tipo', 'numero', 'montoAutorizado',
                'fechaCorte', 'periodoInicio', 'periodoFin', 'estatusInterno']
        },
        {
            nombre: 'FacturasEstimaciones',
            headers: ['id', 'idEstimacion', 'folioFactura', 'uuid', 'monto',
                'estatusSAT', 'archivoXml', 'archivoPdf']
        },
        {
            nombre: 'BitacoraEstimaciones',
            headers: ['id', 'idEstimacion', 'fecha', 'observacion', 'usuario']
        },
        {
            nombre: 'BitacoraFacturas',
            headers: ['id', 'idFactura', 'fecha', 'tipoEvento', 'observacion', 'usuario']
        }
    ];

    console.log('=== INICIO: Creación de hojas para Estimaciones ===');

    hojas.forEach(hoja => {
        let sheet = ss.getSheetByName(hoja.nombre);
        if (!sheet) {
            sheet = ss.insertSheet(hoja.nombre);
            sheet.getRange(1, 1, 1, hoja.headers.length).setValues([hoja.headers]);
            // Formato de encabezado
            sheet.getRange(1, 1, 1, hoja.headers.length)
                .setBackground('#4285f4')
                .setFontColor('#ffffff')
                .setFontWeight('bold');
            // Congelar fila de encabezado
            sheet.setFrozenRows(1);
            console.log(`✓ Hoja "${hoja.nombre}" creada con ${hoja.headers.length} columnas.`);
        } else {
            console.log(`○ Hoja "${hoja.nombre}" ya existe, se omite.`);
        }
    });

    console.log('=== FIN: Proceso terminado ===');
}

/**
 * ===================================================================
 * SCRIPT DE MIGRACIÓN: Agregar columnas a Estimaciones
 * ===================================================================
 * 
 * Agrega las columnas 'entidad' e 'idEstimacionVinculada' a la hoja
 * Estimaciones para soportar el nuevo modelo de vinculación.
 * 
 * INSTRUCCIONES:
 * 1. Ejecutar desde el editor de Apps Script
 * 2. Verificar que las columnas se agregaron correctamente
 * ===================================================================
 */
function migrarHojaEstimaciones() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Estimaciones');

    if (!sheet) {
        console.error('❌ Hoja "Estimaciones" no encontrada');
        return;
    }

    console.log('=== INICIO: Migración hoja Estimaciones ===');

    // Headers esperados después de la migración
    const headersEsperados = [
        'id', 'idComunicado', 'entidad', 'tipo', 'numero',
        'idEstimacionVinculada', 'montoAutorizado', 'fechaCorte',
        'periodoInicio', 'periodoFin', 'estatusInterno'
    ];

    // Leer headers actuales
    const headersActuales = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    console.log('Headers actuales:', headersActuales);

    // Verificar si ya tiene los nuevos campos
    const tieneEntidad = headersActuales.includes('entidad');
    const tieneVinculada = headersActuales.includes('idEstimacionVinculada');

    if (tieneEntidad && tieneVinculada) {
        console.log('✓ La hoja ya tiene todos los campos necesarios');
        console.log('=== FIN: No se requieren cambios ===');
        return;
    }

    // Insertar columnas faltantes
    let colOffset = 0;

    // 'entidad' va después de 'idComunicado' (posición 3)
    if (!tieneEntidad) {
        const posEntidad = headersActuales.indexOf('idComunicado') + 2; // +2 porque es 1-indexed y después de
        sheet.insertColumnAfter(posEntidad + colOffset);
        sheet.getRange(1, posEntidad + 1 + colOffset).setValue('entidad');

        // Valor por defecto: CONSTRUCTORA
        const numRows = sheet.getLastRow();
        if (numRows > 1) {
            sheet.getRange(2, posEntidad + 1 + colOffset, numRows - 1, 1).setValue('CONSTRUCTORA');
        }
        console.log('✓ Columna "entidad" agregada con valor por defecto CONSTRUCTORA');
        colOffset++;
    }

    // Releer headers después de posible inserción
    const headersPostEntidad = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    // 'idEstimacionVinculada' va después de 'numero'
    if (!tieneVinculada) {
        const posVinculada = headersPostEntidad.indexOf('numero') + 1; // +1 porque indexOf es 0-based
        sheet.insertColumnAfter(posVinculada);
        sheet.getRange(1, posVinculada + 1).setValue('idEstimacionVinculada');
        console.log('✓ Columna "idEstimacionVinculada" agregada (vacía)');
    }

    // Formatear encabezados
    sheet.getRange(1, 1, 1, sheet.getLastColumn())
        .setBackground('#4285f4')
        .setFontColor('#ffffff')
        .setFontWeight('bold');

    console.log('=== FIN: Migración completada ===');
    console.log('Headers finales:', sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
}

/**
 * ===================================================================
 * TEST: Diagnóstico de getMatrizPresupuesto
 * ===================================================================
 * Ejecutar desde el editor de Apps Script para ver logs detallados.
 * Verifica que la función devuelve datos correctamente.
 * ===================================================================
 */
function testGetMatrizPresupuesto() {
    const ID_PRUEBA = 202; // <--- Cambia este ID si quieres probar otro comunicado

    console.log('='.repeat(60));
    console.log('TEST: getMatrizPresupuesto');
    console.log('='.repeat(60));
    console.log(`ID a probar: ${ID_PRUEBA}`);
    console.log('');

    try {
        // 1. Verificar que la función existe
        if (typeof getMatrizPresupuesto !== 'function') {
            console.error('❌ ERROR: La función getMatrizPresupuesto NO está definida');
            return;
        }
        console.log('✓ Función getMatrizPresupuesto existe');

        // 2. Llamar a la función
        console.log('');
        console.log('[EJECUTANDO] getMatrizPresupuesto...');
        const resultado = getMatrizPresupuesto(ID_PRUEBA);

        // 3. Verificar resultado
        console.log('');
        console.log('[RESULTADO]');
        console.log('  - Tipo:', typeof resultado);
        console.log('  - Es null:', resultado === null);
        console.log('  - Es undefined:', resultado === undefined);

        if (!resultado) {
            console.error('❌ ERROR: La función devolvió null/undefined');
            console.log('');
            console.log('[DIAGNÓSTICO] Verificando datos base...');

            // Verificar comunicado
            const comRes = buscarPorId('comunicados', ID_PRUEBA);
            console.log('  - buscarPorId comunicados:', comRes.success ? '✓ Encontrado' : `❌ ${comRes.message}`);

            // Verificar actualizaciones
            const actRes = readAllRows('actualizaciones');
            if (actRes.success) {
                const actFiltradas = actRes.data.filter(a => String(a.idComunicado) === String(ID_PRUEBA));
                console.log(`  - Actualizaciones para ID ${ID_PRUEBA}: ${actFiltradas.length}`);
            }

            // Verificar presupuestoLineas
            const linRes = readAllRows('presupuestoLineas');
            console.log('  - presupuestoLineas total:', linRes.success ? `${linRes.data.length} registros` : `❌ ${linRes.message}`);

            // Verificar descripcionLineas
            const descRes = readAllRows('descripcionLineas');
            console.log('  - descripcionLineas total:', descRes.success ? `${descRes.data.length} registros` : `❌ ${descRes.message}`);

            return;
        }

        console.log('  - success:', resultado.success);
        console.log('  - message:', resultado.message || '(sin mensaje)');

        if (resultado.data) {
            console.log('  - data.comunicado:', JSON.stringify(resultado.data.comunicado || null));
            console.log('  - data.actualizaciones:', Array.isArray(resultado.data.actualizaciones) ? `${resultado.data.actualizaciones.length} items` : 'NO es array');

            if (resultado.data.actualizaciones && resultado.data.actualizaciones.length > 0) {
                console.log('');
                console.log('[DETALLE] Primera actualización:');
                const primera = resultado.data.actualizaciones[0];
                console.log('  - id:', primera.id);
                console.log('  - revision:', primera.revision);
                console.log('  - fecha:', primera.fecha);
                console.log('  - esOrigen:', primera.esOrigen);
                console.log('  - lineas:', Array.isArray(primera.lineas) ? `${primera.lineas.length} líneas` : 'NO es array');

                if (primera.lineas && primera.lineas.length > 0) {
                    console.log('');
                    console.log('[DETALLE] Primera línea:');
                    const primeraLinea = primera.lineas[0];
                    console.log('  - descripcion:', primeraLinea.descripcion);
                    console.log('  - categoria:', primeraLinea.categoria);
                    console.log('  - importe:', primeraLinea.importe);
                }
            }
        } else {
            console.log('  - data: null/undefined');
        }

        console.log('');
        console.log('='.repeat(60));
        console.log(resultado.success ? '✓ TEST PASÓ' : '❌ TEST FALLÓ');
        console.log('='.repeat(60));

        // Mostrar JSON completo para referencia
        console.log('');
        console.log('[JSON COMPLETO]');
        console.log(JSON.stringify(resultado, null, 2));

    } catch (error) {
        console.error('');
        console.error('❌ EXCEPCIÓN NO CAPTURADA:');
        console.error('  - message:', error.message);
        console.error('  - stack:', error.stack);
    }
}

/**
 * FUNCIÓN DE PRUEBA ULTRA-SIMPLE
 * Llama desde el frontend: serverCall('testFuncionSimple', '202')
 * Esto verifica si el sistema de funciones del servidor funciona
 */
function testFuncionSimple(idComunicado) {
    console.log('[TEST] Función llamada con:', idComunicado);
    return {
        success: true,
        data: {
            mensaje: 'La función funciona correctamente',
            idRecibido: idComunicado,
            timestamp: new Date().toISOString()
        }
    };
}

/**
 * FUNCIÓN DE PRUEBA QUE LEE DIRECTAMENTE LA HOJA
 * Llama desde el frontend: serverCall('testLecturaDirecta', '202')
 */
function testLecturaDirecta(idComunicado) {
    console.log('[TEST] testLecturaDirecta con ID:', idComunicado);

    try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        console.log('[TEST] Spreadsheet obtenido:', ss.getName());

        const sheet = ss.getSheetByName('Comunicados');
        if (!sheet) {
            return { success: false, message: 'Hoja Comunicados no encontrada' };
        }
        console.log('[TEST] Hoja Comunicados encontrada');

        const data = sheet.getDataRange().getValues();
        console.log('[TEST] Rows:', data.length);

        // Buscar el comunicado
        const headers = data[0];
        const idxId = headers.indexOf('id');

        for (let i = 1; i < data.length; i++) {
            if (String(data[i][idxId]).trim() === String(idComunicado).trim()) {
                return {
                    success: true,
                    data: {
                        encontrado: true,
                        fila: i + 1,
                        headers: headers,
                        valores: data[i]
                    }
                };
            }
        }

        return { success: true, data: { encontrado: false, totalRows: data.length } };

    } catch (e) {
        console.error('[TEST] Error:', e);
        return { success: false, message: e.message };
    }
}

/**
 * ===================================================================
 * SCRIPT DE MIGRACIÓN: Poblar tabla RelacionContratistas
 * ===================================================================
 * 
 * Crea la hoja 'RelacionContratistas' si no existe y migra los datos
 * existentes de contratistas (idEmpresa) desde 'DatosGenerales'.
 * 
 * INSTRUCCIONES:
 * 1. Ejecutar desde el editor de Apps Script > migrarRelacionContratistas
 * ===================================================================
 */
function migrarRelacionContratistas() {
    const DRY_RUN = false;

    console.log('=== INICIO: Migración RelacionContratistas ===');
    console.log(`Modo: ${DRY_RUN ? 'SIMULACIÓN (No cambios)' : 'EJECUCIÓN REAL'}`);

    // 1. Verificar/Crear Hoja
    crearTablaRelacionContratistas();

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const nombreHoja = 'RelacionContratistas';
    let sheet = ss.getSheetByName(nombreHoja);

    // 2. Leer Datos Origen (DatosGenerales)
    const respDG = readAllRows('datosGenerales');
    if (!respDG.success) {
        console.error('Error leyendo DatosGenerales:', respDG.message);
        return;
    }
    const datosGenerales = respDG.data;
    console.log(`Registros en DatosGenerales: ${datosGenerales.length}`);

    // 3. Leer Datos Destino (RelacionContratistas) para evitar duplicados
    let relacionesExistentes = [];
    if (sheet || DRY_RUN) {
        const respRel = readAllRows('relacionContratistas');
        if (respRel.success) relacionesExistentes = respRel.data;
    }

    // Mapa de claves únicas para evitar duplicar lo que ya está en la hoja
    const mapaExistentes = new Set();
    relacionesExistentes.forEach(r => {
        mapaExistentes.add(`${r.idComunicado}-${r.idEmpresa}`);
    });

    // 4. Identificar Registros a Migrar
    let nuevosRegistros = 0;

    datosGenerales.forEach(dg => {
        // Solo nos interesan los que tienen idEmpresa asignado
        if (!dg.idEmpresa) return;

        const clave = `${dg.idComunicado}-${dg.idEmpresa}`;

        // Verificar duplicidad
        if (!mapaExistentes.has(clave)) {
            // Preparar objeto
            // Usamos fechaAsignacion si existe, sino fechaCreacion/FechaDocumento, sino hoy
            let fecha = dg.fechaAsignacion || dg.fecha;
            if (!fecha || fecha === '') fecha = new Date().toISOString().split('T')[0];
            else {
                // Formato YYYY-MM-DD
                try { fecha = new Date(fecha).toISOString().split('T')[0]; } catch (e) { }
            }

            const nuevaRelacion = {
                idComunicado: dg.idComunicado,
                idEmpresa: dg.idEmpresa,
                esContratista: 1, // Asumimos true al venir de idEmpresa principal
                esVigente: 1,     // Asumimos true porque es el asignado actualmente
                fechaAsignacion: fecha
            };

            if (!DRY_RUN) {
                // Crear usando crud para generar ID correctamente y validaciones
                // IMPORTANTE: createRow devuelve objeto resultado
                const resultado = createRow('relacionContratistas', nuevaRelacion);
                if (resultado.success) {
                    console.log(`✓ Migrado: Comunicado ${dg.idComunicado} -> Empresa ${dg.idEmpresa}`);
                    nuevosRegistros++;
                    // Agregar al set para evitar duplicar en esta misma ejecución si hubiera datos corruptos
                    mapaExistentes.add(clave);
                } else {
                    console.error(`Error migrando fila para Comunicado ${dg.idComunicado}: ${resultado.message}`);
                }
            } else {
                console.log(`[SIMULACIÓN] Se migraría: Com ${dg.idComunicado} -> Emp ${dg.idEmpresa} (${fecha})`);
                nuevosRegistros++;
            }
        }
    });

    console.log('---------------------------------------------------');
    if (DRY_RUN) {
        console.log(`[FIN SIMULACIÓN] Se habrían creado ${nuevosRegistros} registros.`);
    } else {
        console.log(`[FIN] Se crearon ${nuevosRegistros} registros nuevos en RelacionContratistas.`);
    }
}

/**
 * ===================================================================
 * SCRIPT DE SETUP: Crear Tabla RelacionContratistas
 * ===================================================================
 * 
 * Crea la hoja 'RelacionContratistas' con los encabezados correctos.
 * Útil para inicializar la tabla sin ejecutar la migración completa.
 * ===================================================================
 */
function crearTablaRelacionContratistas() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const nombreHoja = 'RelacionContratistas';
    let sheet = ss.getSheetByName(nombreHoja);

    if (!sheet) {
        console.log(`[SETUP] Hoja "${nombreHoja}" no existe. Creándola...`);
        sheet = ss.insertSheet(nombreHoja);

        // Headers definidos explícitamente para garantizar orden
        const headers = ['id', 'idComunicado', 'idEmpresa', 'esContratista', 'esVigente', 'fechaAsignacion'];

        // Escribir headers
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

        // Estilos
        sheet.getRange(1, 1, 1, headers.length)
            .setBackground('#4285f4')
            .setFontColor('#ffffff')
            .setFontWeight('bold');

        sheet.setFrozenRows(1);
        console.log(`✓ Hoja "${nombreHoja}" creada exitosamente.`);
    } else {
        console.log(`[SETUP] Hoja "${nombreHoja}" ya existe. No se requieren cambios.`);
    }
}

/**
 * ===================================================================
 * SCRIPT DE LIMPIEZA PROFUNDA: Limpiar TODA la Base de Datos de Huérfanos
 * ===================================================================
 * 
 * Elimina registros huérfanos en cascada segura:
 * 1. Actualizaciones sin Comunicado padre
 * 2. DatosGenerales sin Comunicado padre
 * 3. PresupuestoLineas sin Actualización padre
 * 4. Descripciones sin uso en PresupuestoLineas
 * 
 * INSTRUCCIONES:
 * 1. Ejecutar en MODO SIMULACIÓN (DRY_RUN = true)
 * 2. Verificar logs
 * 3. Ejecutar con DRY_RUN = false para limpiar
 * ===================================================================
 */
function limpiarBaseDatosCompleta(config) {
    // Configuración por defecto: Simulación y Verbose
    // Si se llama desde código sin argumentos, es segura (Dry Run)
    const defaultConfig = { dryRun: true, silent: false };
    const finalConfig = { ...defaultConfig, ...(config || {}) };

    const DRY_RUN = finalConfig.dryRun;
    const SILENT = finalConfig.silent;

    const log = (msg) => { if (!SILENT) console.log(msg); };
    const err = (msg) => { console.error(msg); };

    log('='.repeat(60));
    log(`[LIMPIEZA PROFUNDA] INICIO`);
    log(`[MODO] ${DRY_RUN ? 'SIMULACIÓN (Seguro)' : '⚠️ EJECUCIÓN REAL (Destructivo)'}`);
    log('='.repeat(60));

    // 1. CARGA DE DATOS MAESTROS (Comunicados)
    // ============================================
    const respCom = readAllRows('comunicados');
    if (!respCom.success) { err('Error leyendo comunicados'); return; }
    const comunicados = respCom.data;
    const idsComunicados = new Set(comunicados.map(c => String(c.id)));
    log(`[MAESTRO] Comunicados Activos: ${idsComunicados.size}`);

    // 2. LIMPIEZA DE ACTUALIZACIONES HUÉRFANAS
    // ============================================
    const respAct = readAllRows('actualizaciones');
    let actualizaciones = respAct.success ? respAct.data : [];
    const actHuerfanas = actualizaciones.filter(a => !idsComunicados.has(String(a.idComunicado)));

    console.log(`\n[ANÁLISIS] Actualizaciones:`);
    console.log(`  - Total: ${actualizaciones.length}`);
    console.log(`  - Huérfanos (sin comunicado): ${actHuerfanas.length}`);

    // Construir lista de IDs de actualizaciones VÁLIDAS (excluyendo las que vamos a borrar)
    // Esto es necesario para el siguiente paso (limpiar líneas)
    let idsActualizacionesValidas = new Set(
        actualizaciones
            .filter(a => idsComunicados.has(String(a.idComunicado)))
            .map(a => String(a.id))
    );
    console.log(`  - Actualizaciones Válidas (Padres para líneas): ${idsActualizacionesValidas.size}`);


    // 3. LIMPIEZA DE DATOS GENERALES HUÉRFANOS
    // ============================================
    const respDG = readAllRows('datosGenerales');
    let datosGenerales = respDG.success ? respDG.data : [];
    const dgHuerfanos = datosGenerales.filter(d => !idsComunicados.has(String(d.idComunicado)));

    console.log(`\n[ANÁLISIS] Datos Generales:`);
    console.log(`  - Total: ${datosGenerales.length}`);
    console.log(`  - Huérfanos: ${dgHuerfanos.length}`);


    // 4. LIMPIEZA DE LÍNEAS DE PRESUPUESTO HUÉRFANAS
    // ============================================
    const respLin = readAllRows('presupuestoLineas');
    let lineas = respLin.success ? respLin.data : [];
    // Una línea es huérfana si su actualización padre NO existe O si su actualización padre es huérfana (ya excluida de validas)
    const linHuerfanas = lineas.filter(l => !idsActualizacionesValidas.has(String(l.idActualizacion)));

    console.log(`\n[ANÁLISIS] PresupuestoLineas:`);
    console.log(`  - Total: ${lineas.length}`);
    console.log(`  - Huérfanas (sin actualización válida): ${linHuerfanas.length}`);

    // Construir lista de IDs de descripciones EN USO por líneas válidas
    let idsDescripcionesEnUso = new Set(
        lineas
            .filter(l => idsActualizacionesValidas.has(String(l.idActualizacion))) // Solo líneas que quedarán vivas
            .map(l => String(l.idLinea))
    );


    // 5. LIMPIEZA DE DESCRIPCIONES HUÉRFANAS (Sin uso)
    // ============================================
    const respDesc = readAllRows('descripcionLineas');
    let descripciones = respDesc.success ? respDesc.data : [];
    const descHuerfanas = descripciones.filter(d => !idsDescripcionesEnUso.has(String(d.id)));

    console.log(`\n[ANÁLISIS] DescripcionLineas:`);
    console.log(`  - Total: ${descripciones.length}`);
    console.log(`  - Huérfanas (sin uso en presupuesto activo): ${descHuerfanas.length}`);


    // 6. RESUMEN DE ACCIÓN
    // ============================================
    const totalBorrar = actHuerfanas.length + dgHuerfanos.length + linHuerfanas.length + descHuerfanas.length;

    console.log(`\n[RESUMEN] Se eliminarán ${totalBorrar} registros en total.`);

    if (totalBorrar === 0) {
        console.log('✅ Base de datos íntegra. No se requiere limpieza.');
        return;
    }

    if (DRY_RUN) {
        console.log('\n[SIMULACIÓN] No se realizaron cambios. Cambia DRY_RUN = false para ejecutar.');
        // Muestra samples
        if (actHuerfanas.length > 0) console.log(`Sample Act Huérfana: ID ${actHuerfanas[0].id}, ComPadre ${actHuerfanas[0].idComunicado}`);
        return;
    }

    // 7. EJECUCIÓN REAL (Batch o Loop)
    // ============================================
    console.log('\n[EJECUTANDO ELIMINACIÓN]...');

    // A) Borrar Actualizaciones
    _batchDelete('actualizaciones', actHuerfanas);

    // B) Borrar Datos Generales
    _batchDelete('datosGenerales', dgHuerfanos);

    // C) Borrar PresupuestoLineas
    _batchDelete('presupuestoLineas', linHuerfanas);

    // D) Borrar Descripciones
    _batchDelete('descripcionLineas', descHuerfanas);

    console.log('\n✅ LIMPIEZA COMPLETA FINALIZADA.');
}

/**
 * Helper para borrar en lote (o iterando si no hay batch delete)
 */
function _batchDelete(tabla, registros) {
    if (registros.length === 0) return;

    console.log(`> Eliminando ${registros.length} registros de ${tabla}...`);
    let hits = 0;

    // Usamos deleteRow iterativo x simplicidad y seguridad (aunque más lento)
    // Si tienes una API de batch, úsala aquí.
    registros.forEach((r, i) => {
        try {
            const res = deleteRow(tabla, r.id);
            if (res.success) hits++;
            if ((i + 1) % 50 === 0) console.log(`  Progres: ${i + 1}/${registros.length}`);
        } catch (e) {
            console.error(`  Error eliminando ID ${r.id}: ${e.message}`);
        }
    });
    console.log(`  Terminado ${tabla}: ${hits} eliminados exitosamente.`);
}

/**
 * ===================================================================
 * SCRIPT DE PERFILADO DE RENDIMIENTO
 * ===================================================================
 * 
 * Mide el tiempo de respuesta de las operaciones críticas del sistema.
 * Ayuda a identificar cuellos de botella en la lectura de base de datos
 * o en el procesamiento de datos.
 * 
 * INSTRUCCIONES:
 * 1. Ejecutar desde el editor: Ejecutar > profileSystemPerformance
 * 2. O llamar desde cliente: serverCall('profileSystemPerformance')
 * ===================================================================
 */
function profileSystemPerformance() {
    console.log('BENCHMARK: Iniciando pruebas de rendimiento...');
    const results = [];
    
    // Helper para medir tiempo
    const measure = (label, fn) => {
        const start = new Date().getTime();
        let result = null;
        let diff = 0;
        let count = 0;
        try {
            result = fn();
            diff = new Date().getTime() - start;
            
            if (result && result.success && Array.isArray(result.data)) {
                count = result.data.length;
            } else if (Array.isArray(result)) {
                count = result.length;
            }
            
            console.log(`⏱️ [${diff}ms] ${label} (${count} registros)`);
            results.push({ label, timeMs: diff, count, success: true });
        } catch (e) {
            diff = new Date().getTime() - start;
            console.error(`❌ [${diff}ms] ${label} FALLÓ: ${e.message}`);
            results.push({ label, timeMs: diff, count: 0, success: false, error: e.message });
        }
        return result;
    };

    console.log('--- LECTURA DE TABLAS INDIVIDUALES ---');

    // 1. Tablas Maestras Pequeñas
    measure('Read Cuentas', () => readAllRows('cuentas'));
    measure('Read Empresas', () => readAllRows('empresas'));

    // 2. Tablas Medias
    measure('Read Comunicados (Maestro)', () => readAllRows('comunicados'));
    measure('Read Datos Generales', () => readAllRows('datosGenerales'));
    
    // 3. Tablas Grandes / Transaccionales
    measure('Read Actualizaciones', () => readAllRows('actualizaciones'));
    measure('Read Presupuesto Lineas', () => readAllRows('presupuestoLineas'));
    measure('Read Descripcion Lineas', () => readAllRows('descripcionLineas'));
    measure('Read Estimaciones', () => readAllRows('estimaciones'));
    measure('Read Bitacoras', () => readAllRows('bitacoraEstimaciones'));

    console.log('--- OPERACIONES COMPLEJAS (AGREGACIÓN) ---');

    // 4. Operación Pesada: Poblar todos los comunicados
    // Esta función hace múltiples lecturas y cruces de datos en memoria
    measure('POBLAR TODOS (readAllComunicados)', () => readAllComunicados());

    // 5. Simulación de carga de detalle (un comunicado pesado)
    // Buscamos un ID real para probar
    const coms = readAllRows('comunicados');
    if (coms.success && coms.data.length > 0) {
        // Tomar el último (suele tener más datos acumulados)
        const sampleId = coms.data[coms.data.length - 1].id; 
        measure(`POBLAR DETALLE ID ${sampleId} (getMatrizPresupuesto)`, () => getMatrizPresupuesto(sampleId));
    }

    console.log('BENCHMARK: Finalizado.');
    
    return {
        success: true,
        data: results,
        message: 'Prueba de rendimiento completada'
    };
}
