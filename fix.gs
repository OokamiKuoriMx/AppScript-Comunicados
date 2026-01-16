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

